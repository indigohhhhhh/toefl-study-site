"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beijingDate, dueReviews, rollStateToToday } from "@/lib/study-state";
import type {
  ExerciseItem,
  GradeResult,
  PhraseItem,
  QuizKind,
  ReviewItem,
  StudyState,
  VocabularyItem,
} from "@/lib/study-types";

type View =
  | "today"
  | "words"
  | "phrases"
  | "errors"
  | "progress"
  | "settings"
  | "review-quiz"
  | "word-learn"
  | "word-quiz"
  | "word-cloze"
  | "phrase-learn"
  | "phrase-quiz"
  | "phrase-practice";

type QuizQuestion = {
  id: string;
  kind: QuizKind;
  number: number;
  prompt: string;
  label: string;
};

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const LOCAL_STATE_KEY = "toefl-study-state-v1-release";

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00+08:00`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return beijingDate(parsed);
}

function shuffled<T extends { id: string }>(items: T[], seed: string): T[] {
  const score = (value: string) => {
    let hash = 2166136261;
    for (const char of `${seed}:${value}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  };
  return [...items].sort((a, b) => score(a.id) - score(b.id));
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function todayLabel(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00+08:00`));
}

export default function StudyApp({
  vocabulary,
  phrases,
  exercises,
  initialState,
  displayName,
}: {
  vocabulary: VocabularyItem[];
  phrases: PhraseItem[];
  exercises: ExerciseItem[];
  initialState: StudyState;
  displayName: string;
}) {
  const [state, setState] = useState(() => rollStateToToday(initialState));
  const [view, setView] = useState<View>("today");
  const [ready, setReady] = useState(false);
  const [storage, setStorage] = useState<"cloud" | "browser">("browser");
  const [online, setOnline] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [toast, setToast] = useState("");

  const wordById = useMemo(() => new Map(vocabulary.map((item) => [item.id, item])), [vocabulary]);
  const phraseById = useMemo(() => new Map(phrases.map((item) => [item.id, item])), [phrases]);
  const exerciseById = useMemo(() => new Map(exercises.map((item) => [item.id, item])), [exercises]);

  const wordCount = state.settings.temporaryVocabularySize ?? state.settings.vocabularyBatchSize;
  const phraseCount = state.settings.temporaryPhraseSize ?? state.settings.phraseBatchSize;
  const activeWords = vocabulary.slice(state.progress.vocabularyNextIndex - 1, state.progress.vocabularyNextIndex - 1 + wordCount);
  const activePhrases = phrases.slice(state.progress.phraseNextIndex - 1, state.progress.phraseNextIndex - 1 + phraseCount);
  const activeExercises = activePhrases.map((phrase) => exercises[phrase.index - 1]).filter(Boolean);
  const reviewsDue = dueReviews(state);

  const updateState = useCallback((change: (current: StudyState) => StudyState) => {
    setState((current) => ({ ...change(current), updatedAt: new Date().toISOString() }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialOnlineTimer = window.setTimeout(() => setOnline(navigator.onLine), 0);
    const localRaw = localStorage.getItem(LOCAL_STATE_KEY);
    let localState: StudyState | null = null;
    try {
      localState = localRaw ? (JSON.parse(localRaw) as StudyState) : null;
    } catch {
      localStorage.removeItem(LOCAL_STATE_KEY);
    }
    fetch("/api/state", { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : { state: null, storage: "browser" }))
      .then((payload: { state: StudyState | null; storage: "cloud" | "browser" }) => {
        if (cancelled) return;
        const chosen = payload.state ?? localState ?? initialState;
        setState(rollStateToToday(chosen));
        setStorage(payload.state ? "cloud" : payload.storage);
      })
      .catch(() => {
        if (!cancelled && localState) setState(rollStateToToday(localState));
      })
      .finally(() => { if (!cancelled) setReady(true); });

    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    const installHandler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", installHandler);
    return () => {
      cancelled = true;
      window.clearTimeout(initialOnlineTimer);
      window.removeEventListener("online", onlineHandler);
      window.removeEventListener("offline", offlineHandler);
      window.removeEventListener("beforeinstallprompt", installHandler);
    };
  }, [initialState]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
    const timer = window.setTimeout(() => {
      if (!navigator.onLine) return;
      fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      })
        .then((response) => {
          if (response.ok) setStorage("cloud");
          else setStorage("browser");
        })
        .catch(() => setStorage("browser"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [ready, state]);

  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(""), 2800);
      return () => window.clearTimeout(timer);
    }
  }, [toast]);

  const setCompleted = (key: keyof StudyState["daily"]["completed"]) => {
    updateState((current) => ({
      ...current,
      daily: { ...current.daily, completed: { ...current.daily.completed, [key]: true } },
    }));
  };

  const handleResults = (results: GradeResult[], completion: keyof StudyState["daily"]["completed"]) => {
    updateState((current) => {
      const nextReviews = [...current.progress.reviews];
      for (const result of results) {
        const key = `${result.kind}:${result.id}`;
        const position = nextReviews.findIndex((review) => review.key === key);
        const existing = position >= 0 ? nextReviews[position] : null;
        if (!result.correct) {
          const changed: ReviewItem = {
            key,
            kind: result.kind,
            itemId: result.id,
            errorCount: (existing?.errorCount ?? 0) + 1,
            consecutiveCorrect: 0,
            nextReviewAt: addDays(current.daily.date, 1),
            status: "scheduled",
            lastWrongAnswer: result.userAnswer,
          };
          if (position >= 0) nextReviews[position] = changed;
          else nextReviews.push(changed);
        } else if (existing) {
          const streak = existing.consecutiveCorrect + 1;
          const mastered = streak >= 3;
          nextReviews[position] = {
            ...existing,
            consecutiveCorrect: streak,
            status: mastered ? "mastered" : "scheduled",
            nextReviewAt: addDays(current.daily.date, mastered ? 30 : [1, 3, 7][Math.min(streak, 2)]),
          };
        }
      }

      const completed = { ...current.daily.completed, [completion]: true };
      let progress = { ...current.progress, reviews: nextReviews };
      let settings = current.settings;
      let submitted = current.daily.submitted;
      if (completion === "phraseExercise") {
        const currentWordCount = current.settings.temporaryVocabularySize ?? current.settings.vocabularyBatchSize;
        const currentPhraseCount = current.settings.temporaryPhraseSize ?? current.settings.phraseBatchSize;
        const learnedWords = Array.from({ length: currentWordCount }, (_, index) => current.progress.vocabularyNextIndex + index)
          .filter((index) => index <= vocabulary.length);
        const learnedPhrases = Array.from({ length: currentPhraseCount }, (_, index) => current.progress.phraseNextIndex + index)
          .filter((index) => index <= phrases.length);
        progress = {
          ...progress,
          vocabularyNextIndex: Math.min(vocabulary.length + 1, current.progress.vocabularyNextIndex + learnedWords.length),
          phraseNextIndex: Math.min(phrases.length + 1, current.progress.phraseNextIndex + learnedPhrases.length),
          learnedVocabulary: uniqueNumbers([...current.progress.learnedVocabulary, ...learnedWords]),
          learnedPhrases: uniqueNumbers([...current.progress.learnedPhrases, ...learnedPhrases]),
        };
        settings = { ...settings, temporaryVocabularySize: null, temporaryPhraseSize: null };
        submitted = true;
      }

      return {
        ...current,
        settings,
        progress,
        daily: { ...current.daily, completed, submitted },
      };
    });
  };

  const reviewQuestions = useMemo(() => shuffled(
    reviewsDue.map((review, index) => questionForReview(review, index + 1, wordById, phraseById, exerciseById)).filter(Boolean) as QuizQuestion[],
    `${state.daily.date}:reviews`,
  ), [reviewsDue, wordById, phraseById, exerciseById, state.daily.date]);

  const wordSpellingQuestions = useMemo(() => shuffled(activeWords.map((item) => ({
    id: item.id,
    kind: "word_spelling" as const,
    number: item.index,
    prompt: `${item.meaningsZh}（${item.partOfSpeech || "单词"}）`,
    label: "请拼写：",
  })), `${state.daily.date}:word-spelling`), [activeWords, state.daily.date]);

  const wordClozeQuestions = useMemo(() => shuffled(activeWords.map((item) => ({
    id: item.id,
    kind: "word_cloze" as const,
    number: item.index,
    prompt: item.exampleCloze.prompt,
    label: "填写完整英文单词：",
  })), `${state.daily.date}:word-cloze`), [activeWords, state.daily.date]);

  const phraseSpellingQuestions = useMemo(() => shuffled(activePhrases.map((item) => ({
    id: item.id,
    kind: "phrase_spelling" as const,
    number: item.index,
    prompt: `${item.meaningZh}（${item.category}）`,
    label: "请拼写完整搭配：",
  })), `${state.daily.date}:phrase-spelling`), [activePhrases, state.daily.date]);

  const phraseExerciseQuestions = useMemo(() => shuffled(activeExercises.map((item) => ({
    id: item.id,
    kind: "phrase_exercise" as const,
    number: item.index,
    prompt: item.prompt,
    label: "填写完整英文答案：",
  })), `${state.daily.date}:phrase-exercise`), [activeExercises, state.daily.date]);

  const navigate = (target: View) => {
    if (target === "word-learn" && reviewsDue.length === 0 && !state.daily.completed.reviews) {
      setCompleted("reviews");
    }
    setView(target);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const install = async () => {
    if (!installPrompt) {
      setToast("可在浏览器菜单中选择“添加到主屏幕”");
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const page = (() => {
    if (view === "today") return <Dashboard state={state} reviewsDue={reviewsDue.length} activeWords={activeWords} activePhrases={activePhrases} navigate={navigate} updateState={updateState} />;
    if (view === "word-learn") return <WordLearning items={activeWords} onDone={() => { setCompleted("vocabularyLearn"); navigate("word-quiz"); }} />;
    if (view === "phrase-learn") return <PhraseLearning items={activePhrases} onDone={() => { setCompleted("phraseLearn"); navigate("phrase-quiz"); }} />;
    if (view === "review-quiz") return <QuizView key="review-quiz" title="到期错题复查" description="顺序已打乱。只填写英文，不提供首字母或长度提示。" questions={reviewQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "reviews")} onNext={() => navigate("word-learn")} nextLabel="继续学习新单词" />;
    if (view === "word-quiz") return <QuizView key="word-quiz" title="单词无提示拼写" description="整组提交后统一批改；不提示首字母、字母数量或下划线。" questions={wordSpellingQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "vocabularySpelling")} onNext={() => navigate("word-cloze")} nextLabel="开始单词例句填空" />;
    if (view === "word-cloze") return <QuizView key="word-cloze" title="单词例句填空" description="请根据语法和语境填写完整单词。题面使用“已给字母  [还需字母数]”格式。" questions={wordClozeQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "vocabularyCloze")} onNext={() => navigate("phrase-learn")} nextLabel="开始学习词组" />;
    if (view === "phrase-quiz") return <QuizView key="phrase-quiz" title="词组无提示拼写" description="必须写出完整搭配；词序、介词和词形都参与判定。" questions={phraseSpellingQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "phraseSpelling")} onNext={() => navigate("phrase-practice")} nextLabel="开始词组配套练习" />;
    if (view === "phrase-practice") return <QuizView key="phrase-practice" title="词组配套练习" description="题目来自原资料，整组填写后统一批改。请填写完整英文答案。" questions={phraseExerciseQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "phraseExercise")} onNext={() => navigate("today")} nextLabel="返回今日首页" />;
    if (view === "words") return <WordLibrary items={vocabulary} learned={state.progress.learnedVocabulary} />;
    if (view === "phrases") return <PhraseLibrary items={phrases} learned={state.progress.learnedPhrases} />;
    if (view === "errors") return <ErrorBook reviews={state.progress.reviews} wordById={wordById} phraseById={phraseById} exerciseById={exerciseById} />;
    if (view === "progress") return <ProgressPage state={state} totalWords={vocabulary.length} totalPhrases={phrases.length} />;
    return <SettingsPage state={state} setState={setState} install={install} storage={storage} online={online} setToast={setToast} />;
  })();

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <button className="brand" onClick={() => navigate("today")}><span className="brand-mark">T</span><span><strong>词航</strong><small>TOEFL STUDY</small></span></button>
        <nav>
          <NavButton active={view === "today"} onClick={() => navigate("today")} label="今日" badge={state.daily.submitted ? "✓" : undefined} />
          <NavButton active={view === "words"} onClick={() => navigate("words")} label="单词库" />
          <NavButton active={view === "phrases"} onClick={() => navigate("phrases")} label="词组库" />
          <NavButton active={view === "errors"} onClick={() => navigate("errors")} label="错题本" badge={String(state.progress.reviews.filter((item) => item.status !== "mastered").length)} />
          <NavButton active={view === "progress"} onClick={() => navigate("progress")} label="学习记录" />
          <NavButton active={view === "settings"} onClick={() => navigate("settings")} label="设置与备份" />
        </nav>
        <div className="sidebar-goal"><span>目标</span><strong>TOEFL {state.settings.goalScore}</strong><small>9 月前完成</small></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><span className="eyebrow">{todayLabel(state.daily.date)} · 北京时间</span><h1>{view === "today" ? "今天，稳稳向前一步。" : pageTitle(view)}</h1></div>
          <div className="account-area"><span className={`sync-badge ${online ? "" : "offline"}`}>{!online ? "离线草稿" : storage === "cloud" ? "云端已连接" : "本机预览"}</span><button className="profile" aria-label="账户菜单">{displayName.slice(0, 2).toUpperCase()}</button></div>
        </header>
        {!ready && <div className="loading-line">正在读取学习进度…</div>}
        {page}
      </section>

      <nav className="mobile-nav" aria-label="手机导航">
        <NavButton active={view === "today"} onClick={() => navigate("today")} label="今日" />
        <NavButton active={view === "words"} onClick={() => navigate("words")} label="单词" />
        <NavButton active={view === "phrases"} onClick={() => navigate("phrases")} label="词组" />
        <NavButton active={view === "errors"} onClick={() => navigate("errors")} label="错题" />
        <NavButton active={view === "settings"} onClick={() => navigate("settings")} label="设置" />
      </nav>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function NavButton({ active, onClick, label, badge }: { active: boolean; onClick(): void; label: string; badge?: string }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><span>{label}</span>{badge && <b>{badge}</b>}</button>;
}

function pageTitle(view: View): string {
  const titles: Partial<Record<View, string>> = {
    words: "800 词学习资料",
    phrases: "固定词组资料",
    errors: "分开的错题记录",
    progress: "你的学习进度",
    settings: "设置、安装与备份",
    "review-quiz": "先复习，再学新内容",
    "word-learn": "今日新单词",
    "word-quiz": "单词拼写抽查",
    "word-cloze": "单词例句练习",
    "phrase-learn": "今日新词组",
    "phrase-quiz": "词组拼写抽查",
    "phrase-practice": "词组配套练习",
  };
  return titles[view] ?? "词航";
}

function questionForReview(
  review: ReviewItem,
  number: number,
  words: Map<string, VocabularyItem>,
  phrases: Map<string, PhraseItem>,
  exercises: Map<string, ExerciseItem>,
): QuizQuestion | null {
  if (review.kind === "word_spelling") {
    const item = words.get(review.itemId);
    return item ? { id: item.id, kind: review.kind, number, prompt: `${item.meaningsZh}（${item.partOfSpeech}）`, label: "请拼写：" } : null;
  }
  if (review.kind === "word_cloze") {
    const item = words.get(review.itemId);
    return item ? { id: item.id, kind: review.kind, number, prompt: item.exampleCloze.prompt, label: "填写完整英文单词：" } : null;
  }
  if (review.kind === "phrase_spelling") {
    const item = phrases.get(review.itemId);
    return item ? { id: item.id, kind: review.kind, number, prompt: `${item.meaningZh}（${item.category}）`, label: "请拼写完整搭配：" } : null;
  }
  const item = exercises.get(review.itemId);
  return item ? { id: item.id, kind: review.kind, number, prompt: item.prompt, label: "填写完整英文答案：" } : null;
}

function Dashboard({
  state,
  reviewsDue,
  activeWords,
  activePhrases,
  navigate,
  updateState,
}: {
  state: StudyState;
  reviewsDue: number;
  activeWords: VocabularyItem[];
  activePhrases: PhraseItem[];
  navigate(view: View): void;
  updateState(change: (current: StudyState) => StudyState): void;
}) {
  const completed = state.daily.completed;
  const taskValues = Object.values(completed);
  const progress = state.daily.submitted ? 100 : Math.round((taskValues.filter(Boolean).length / taskValues.length) * 100);
  const next = !completed.reviews && reviewsDue > 0
    ? { title: `先复习 ${reviewsDue} 个到期错词/错题`, detail: "错词会按间隔重复检查，连续多次正确后才暂时停止。", action: "开始复习", view: "review-quiz" as View }
    : !completed.vocabularyLearn
      ? { title: `学习第 ${activeWords[0]?.index ?? "—"}—${activeWords.at(-1)?.index ?? "—"} 词`, detail: `今天学习 ${activeWords.length} 个新单词，当前批次完成后才会开放下一批。`, action: "开始学习", view: "word-learn" as View }
      : !completed.vocabularySpelling
        ? { title: "完成单词无提示拼写", detail: "顺序打乱，整组提交后统一批改。", action: "开始拼写", view: "word-quiz" as View }
        : !completed.vocabularyCloze
          ? { title: "完成单词例句填空", detail: "在真实语境中检查词义、词形与拼写。", action: "开始填空", view: "word-cloze" as View }
          : !completed.phraseLearn
            ? { title: `学习 ${activePhrases.length} 个完整词组`, detail: "词组与单词分开记录，不会因包含相同单词而合并。", action: "学习词组", view: "phrase-learn" as View }
            : !completed.phraseSpelling
              ? { title: "完成词组无提示拼写", detail: "完整搭配、词序和介词都必须正确。", action: "开始拼写", view: "phrase-quiz" as View }
              : !completed.phraseExercise
                ? { title: "完成词组配套练习", detail: "题目和答案来自你提供的 Word 资料。", action: "开始练习", view: "phrase-practice" as View }
                : { title: "今天的任务已完成", detail: "新一批不会提前累积，明天登录后再继续。", action: "查看进度", view: "progress" as View };

  const tasks = [
    ["到期错词与错题", reviewsDue ? `${reviewsDue} 项` : "今日无到期", completed.reviews],
    ["学习新单词", `${activeWords.length} 个`, completed.vocabularyLearn],
    ["单词无提示拼写", `${activeWords.length} 题`, completed.vocabularySpelling],
    ["单词例句填空", `${activeWords.length} 题`, completed.vocabularyCloze],
    ["学习新词组", `${activePhrases.length} 个`, completed.phraseLearn],
    ["词组无提示拼写", `${activePhrases.length} 题`, completed.phraseSpelling],
    ["词组配套练习", `${activePhrases.length} 题`, completed.phraseExercise],
  ] as const;

  const changeWordSize = (size: number) => updateState((current) => ({
    ...current,
    settings: { ...current.settings, temporaryVocabularySize: size },
  }));
  const changePhraseSize = (size: number) => updateState((current) => ({
    ...current,
    settings: { ...current.settings, temporaryPhraseSize: size },
  }));

  return (
    <>
      <section className="hero-card">
        <div className="hero-copy">
          <span className="pill">{state.daily.submitted ? "今日完成" : "当前任务"}</span>
          <h2>{next.title}</h2>
          <p>{next.detail}</p>
          <div className="hero-actions"><button className="primary-button" onClick={() => navigate(next.view)}>{next.action} <span>→</span></button></div>
        </div>
        <div className="progress-ring" style={{ "--progress": `${progress}%` } as React.CSSProperties} aria-label={`今日进度 ${progress}%`}><strong>{progress}%</strong><span>今日进度</span></div>
      </section>

      <div className="content-grid">
        <section className="panel task-panel">
          <div className="panel-heading"><div><span className="eyebrow">学习路线</span><h2>今日任务</h2></div><span className="quiet">{taskValues.filter(Boolean).length} / 7</span></div>
          <div className="task-list">
            {tasks.map(([label, detail, done], index) => {
              const firstIncomplete = tasks.findIndex((task) => !task[2]);
              return <article className={`task-row ${done ? "done" : index === firstIncomplete ? "current" : "locked"}`} key={label}><span className="task-index">{done ? "✓" : index + 1}</span><div><strong>{label}</strong><small>{detail}</small></div><span className="task-state">{done ? "已完成" : index === firstIncomplete ? "进行中" : "待解锁"}</span></article>;
            })}
          </div>
        </section>

        <aside className="right-column">
          <section className="panel reduction-panel">
            <span className="eyebrow">临时减量</span><h2>今天可以少学，但不积压</h2>
            <p>只改变今天这一批，明天自动恢复默认数量。</p>
            <div className="choice-group"><strong>单词</strong>{[5, 10, 15].map((size) => <button disabled={completed.vocabularyLearn} className={activeWords.length === size ? "selected" : ""} onClick={() => changeWordSize(size)} key={size}>{size} 个</button>)}</div>
            <div className="choice-group"><strong>词组</strong>{[3, 5, 10].map((size) => <button disabled={completed.phraseLearn} className={activePhrases.length === size ? "selected" : ""} onClick={() => changePhraseSize(size)} key={size}>{size} 个</button>)}</div>
          </section>
          {!state.daily.submitted && <section className="panel reminder-panel"><span className="reminder-dot" /><div><strong>任务会在下次登录时继续显示</strong><p>网站关闭时不会外部提醒，也不会自动累积新词。</p></div></section>}
        </aside>
      </div>
    </>
  );
}

function WordLearning({ items, onDone }: { items: VocabularyItem[]; onDone(): void }) {
  return (
    <section className="learning-page">
      <div className="section-intro"><span className="pill">新单词 · {items.length} 个</span><h2>先理解，再检查拼写</h2><p>每个词都来自 800 词资料。例句填空会在拼写抽查之后单独进行。</p></div>
      <div className="study-card-grid">
        {items.map((item) => <article className="study-card" key={item.id}><div className="card-number">{item.index}</div><div className="word-heading"><h3>{item.word}</h3><span>{item.partOfSpeech}</span></div><p className="pronunciation">{item.pronunciation}</p><p className="meaning">{item.meaningsZh}</p><details><summary>查看释义、记忆和例句</summary><p><strong>英文释义：</strong>{item.definitionEn}</p>{item.mnemonic && <p><strong>记忆：</strong>{item.mnemonic}</p>}<p className="example"><strong>例句：</strong>{item.example}</p></details></article>)}
      </div>
      <div className="sticky-action"><div><strong>已经学习完这 {items.length} 个单词？</strong><small>下一步不提供任何拼写提示。</small></div><button className="primary-button" onClick={onDone}>开始整组拼写 →</button></div>
    </section>
  );
}

function PhraseLearning({ items, onDone }: { items: PhraseItem[]; onDone(): void }) {
  return (
    <section className="learning-page">
      <div className="section-intro"><span className="pill">新词组 · {items.length} 个</span><h2>记住完整搭配</h2><p>词组学习进度与单词完全分开。介词、词序和词形都会在拼写抽查中检查。</p></div>
      <div className="phrase-study-list">
        {items.map((item) => <article key={item.id}><span>{item.index}</span><div><h3>{item.phrase}</h3><p>{item.meaningZh}</p></div><small>{item.category}</small></article>)}
      </div>
      <div className="sticky-action"><div><strong>已经学习完这 {items.length} 个词组？</strong><small>下一步需写出完整英文搭配。</small></div><button className="primary-button" onClick={onDone}>开始整组拼写 →</button></div>
    </section>
  );
}

function QuizView({
  title,
  description,
  questions,
  date,
  online,
  onComplete,
  onNext,
  nextLabel,
}: {
  title: string;
  description: string;
  questions: QuizQuestion[];
  date: string;
  online: boolean;
  onComplete(results: GradeResult[]): void;
  onNext(): void;
  nextLabel: string;
}) {
  const [quizQuestions] = useState(() => questions);
  const draftKey = `toefl-draft:${date}:${quizQuestions.map((item) => `${item.kind}-${item.id}`).join("|")}`;
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    if (typeof localStorage === "undefined") return {};
    try {
      const saved = localStorage.getItem(draftKey);
      return saved ? JSON.parse(saved) as Record<string, string> : {};
    } catch {
      localStorage.removeItem(draftKey);
      return {};
    }
  });
  const [results, setResults] = useState<GradeResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const completedOnce = useRef(false);

  useEffect(() => {
    if (!results) localStorage.setItem(draftKey, JSON.stringify(answers));
  }, [answers, draftKey, results]);

  const submit = async () => {
    if (!online) {
      setError("当前离线：答案草稿已保留，联网后才能正式提交并写入云端记录。");
      return;
    }
    const missing = quizQuestions.filter((item) => !(answers[`${item.kind}:${item.id}`] ?? "").trim());
    if (missing.length) {
      setError(`还有 ${missing.length} 题未填写。整组完成后才能统一提交。`);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: `${date}:${quizQuestions[0]?.kind ?? "review"}:${crypto.randomUUID()}`,
          items: quizQuestions.map((item) => ({ id: item.id, kind: item.kind, answer: answers[`${item.kind}:${item.id}`] ?? "" })),
        }),
      });
      const payload = await response.json() as { results?: GradeResult[]; error?: string };
      if (!response.ok || !payload.results) throw new Error(payload.error || "提交失败");
      setResults(payload.results);
      localStorage.removeItem(draftKey);
      if (!completedOnce.current) {
        completedOnce.current = true;
        onComplete(payload.results);
      }
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "网络错误，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  const resultMap = useMemo(() => new Map(results?.map((item) => [`${item.kind}:${item.id}`, item]) ?? []), [results]);
  const correctCount = results?.filter((item) => item.correct).length ?? 0;

  return (
    <section className="quiz-page">
      <div className="section-intro"><span className="pill">整组提交 · {quizQuestions.length} 题</span><h2>{title}</h2><p>{description}</p></div>
      {results && <section className="result-summary"><div><span>本组成绩</span><strong>{correctCount} / {results.length}</strong></div><p>{correctCount === results.length ? "全部正确，这一组很稳。" : `有 ${results.length - correctCount} 题已加入对应的错题类别，下面已给出完整解释。`}</p></section>}
      <div className="question-list">
        {quizQuestions.map((question, index) => {
          const key = `${question.kind}:${question.id}`;
          const result = resultMap.get(key);
          return (
            <article className={`question-card ${result ? result.correct ? "correct" : "wrong" : ""}`} key={key}>
              <div className="question-meta"><span>{index + 1}</span><small>{result ? result.correct ? "正确" : "需要订正" : `资料题号 ${question.number}`}</small></div>
              <p className="question-prompt">{question.prompt}</p>
              <label><span>{question.label}</span><input autoComplete="off" spellCheck={false} disabled={Boolean(results)} value={answers[key] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [key]: event.target.value }))} /></label>
              {result && !result.correct && <WrongExplanation result={result} />}
            </article>
          );
        })}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="quiz-submit">
        {!results ? <button className="primary-button" disabled={submitting || !quizQuestions.length} onClick={submit}>{submitting ? "正在统一批改…" : `提交整组 ${quizQuestions.length} 题`}</button> : <button className="primary-button" onClick={onNext}>{nextLabel} →</button>}
        {!results && <small>大小写和首尾空格不影响判定；拼写、词形、词序和介词严格检查。</small>}
      </div>
    </section>
  );
}

function WrongExplanation({ result }: { result: GradeResult }) {
  return (
    <div className="wrong-explanation">
      <dl><div><dt>你的答案</dt><dd>{result.userAnswer || "（未填写）"}</dd></div><div><dt>正确答案</dt><dd>{result.expected}</dd></div><div><dt>中文含义</dt><dd>{result.meaningZh}</dd></div><div><dt>词性/题型</dt><dd>{result.partOfSpeech}</dd></div><div><dt>常见搭配</dt><dd>{result.commonUsage || "见原例句"}</dd></div></dl>
      <p><strong>错在哪里：</strong>{result.explanation}</p>
      <p><strong>原句中的含义：</strong>{result.contextMeaning}</p>
    </div>
  );
}

function WordLibrary({ items, learned }: { items: VocabularyItem[]; learned: number[] }) {
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) => `${item.word} ${item.meaningsZh}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 80);
  return (
    <section className="library-page"><div className="section-intro"><span className="pill">固定题库 · 800 词</span><h2>自由查看单词资料</h2><p>查看资料不会改变每日学习顺序；正式进度只在当日流程提交后更新。</p></div><input className="search-input" placeholder="搜索英文单词或中文释义" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="library-grid">{filtered.map((item) => <details className="library-card" key={item.id}><summary><span className="library-index">{item.index}</span><div><strong>{item.word}</strong><small>{item.partOfSpeech} {item.meaningsZh}</small></div><i>{learned.includes(item.index) ? "已学" : "未学"}</i></summary><p>{item.pronunciation}</p><p><strong>英文释义：</strong>{item.definitionEn}</p><p className="example"><strong>例句：</strong>{item.example}</p></details>)}</div>{filtered.length === 80 && <p className="muted center">为保证手机流畅，搜索结果每次最多显示 80 条。</p>}</section>
  );
}

function PhraseLibrary({ items, learned }: { items: PhraseItem[]; learned: number[] }) {
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) => `${item.phrase} ${item.meaningZh} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="library-page"><div className="section-intro"><span className="pill">独立题库 · 100 组</span><h2>自由查看词组资料</h2><p>词组始终与单词分开记录，即使搭配中包含同一个英文单词。</p></div><input className="search-input" placeholder="搜索词组或中文释义" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="phrase-library">{filtered.map((item) => <article key={item.id}><span>{item.index}</span><div><strong>{item.phrase}</strong><small>{item.meaningZh}</small></div><i>{learned.includes(item.index) ? "已学" : item.category}</i></article>)}</div></section>;
}

function ErrorBook({ reviews, wordById, phraseById, exerciseById }: { reviews: ReviewItem[]; wordById: Map<string, VocabularyItem>; phraseById: Map<string, PhraseItem>; exerciseById: Map<string, ExerciseItem> }) {
  const groups: Array<[string, QuizKind[]]> = [
    ["拼写错误的单词", ["word_spelling"]],
    ["拼写或搭配错误的词组", ["phrase_spelling"]],
    ["单词例句中的错题", ["word_cloze"]],
    ["词组练习中的错题", ["phrase_exercise"]],
  ];
  const nameOf = (review: ReviewItem) => wordById.get(review.itemId)?.word ?? phraseById.get(review.itemId)?.phrase ?? exerciseById.get(review.itemId)?.sourceSentence ?? review.itemId;
  return <section className="error-page"><div className="section-intro"><span className="pill">四类分开记录</span><h2>错题本</h2><p>错误次数永久累计；连续三次复习正确后暂时停止检查，再次答错会重新加入。</p></div><div className="error-groups">{groups.map(([title, kinds]) => { const items = reviews.filter((item) => kinds.includes(item.kind)); return <section className="panel" key={title}><div className="panel-heading"><h3>{title}</h3><span className="quiet">{items.length} 项</span></div>{items.length ? <div className="error-list">{items.map((item) => <article key={item.key}><div><strong>{nameOf(item)}</strong><small>累计错误 {item.errorCount} 次</small></div><span className={`status-chip ${item.status}`}>{item.status === "due" ? "今日复习" : item.status === "mastered" ? "暂时掌握" : "已安排复习"}</span></article>)}</div> : <p className="empty-state">这一类还没有错误记录。</p>}</section>; })}</div></section>;
}

function ProgressPage({ state, totalWords, totalPhrases }: { state: StudyState; totalWords: number; totalPhrases: number }) {
  const wordPercent = Math.round((state.progress.learnedVocabulary.length / totalWords) * 100);
  const phrasePercent = Math.round((state.progress.learnedPhrases.length / totalPhrases) * 100);
  const activeErrors = state.progress.reviews.filter((item) => item.status !== "mastered").length;
  return <section className="progress-page"><div className="section-intro"><span className="pill">目标 · TOEFL {state.settings.goalScore}</span><h2>当前学习进度</h2><p>只统计已经完成整套当日流程的批次，查看资料不计入进度。</p></div><div className="stats-grid"><article><span>已学单词</span><strong>{state.progress.learnedVocabulary.length}<small> / {totalWords}</small></strong><div className="bar"><i style={{ width: `${wordPercent}%` }} /></div><p>{wordPercent}%</p></article><article><span>已学词组</span><strong>{state.progress.learnedPhrases.length}<small> / {totalPhrases}</small></strong><div className="bar"><i style={{ width: `${phrasePercent}%` }} /></div><p>{phrasePercent}%</p></article><article><span>仍在复习</span><strong>{activeErrors}<small> 项</small></strong><p>单词、词组和两类例句错误分别保留。</p></article></div><section className="panel rules-panel"><span className="eyebrow">进度规则</span><h3>当前批次完成后，下一批才会出现</h3><p>网站不会把漏学的新词逐日堆叠。临时减量只影响当天，完成后按实际学习数量推进；下一次登录恢复默认的 15 个单词和 10 个词组。</p></section></section>;
}

function SettingsPage({ state, setState, install, storage, online, setToast }: { state: StudyState; setState(state: StudyState): void; install(): void; storage: "cloud" | "browser"; online: boolean; setToast(message: string): void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const exportBackup = () => {
    const payload = { format: "toefl-study-backup", exportedAt: new Date().toISOString(), state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `toefl-study-backup-${state.daily.date}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("完整 JSON 备份已导出");
  };
  const restoreBackup = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as { format?: string; state?: StudyState };
      if (payload.format !== "toefl-study-backup" || payload.state?.version !== 1) throw new Error("备份格式不正确");
      if (!window.confirm("恢复会用备份中的记录覆盖当前学习进度。确定继续吗？")) return;
      setState(rollStateToToday(payload.state));
      setToast("备份已恢复，并将同步到云端");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法读取备份");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  return (
    <section className="settings-page">
      <div className="section-intro"><span className="pill">个人网站</span><h2>安装、同步与资料管理</h2><p>第一版以联网学习为准；断网时保留页面外壳和未提交草稿，不会生成正式成绩。</p></div>
      <div className="settings-grid">
        <section className="panel setting-card"><span className="setting-icon">↗</span><h3>添加到手机桌面</h3><p>作为 PWA 安装，不需要应用商店。点击图标可直接进入今日学习。</p><button className="secondary-button" onClick={install}>添加到主屏幕</button></section>
        <section className="panel setting-card"><span className="setting-icon">☁</span><h3>同步状态</h3><p>{online ? storage === "cloud" ? "已连接私人云端数据库，手机与电脑使用同一进度。" : "当前是本机预览；发布后会连接私人云端数据库。" : "当前离线；答案草稿只保存在这台设备。"}</p><span className={`status-chip ${online ? "mastered" : "scheduled"}`}>{online ? "在线" : "离线"}</span></section>
        <section className="panel setting-card"><span className="setting-icon text-icon">JSON</span><h3>完整 JSON 备份</h3><p>导出包含学习进度、分开的错误记录、累计错误次数和设置，可用于以后恢复网站。</p><div className="button-row"><button className="secondary-button" onClick={exportBackup}>导出备份</button><button className="secondary-button" onClick={() => fileRef.current?.click()}>恢复备份</button></div><input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void restoreBackup(file); }} /></section>
        <section className="panel setting-card muted-card"><span className="setting-icon">＋</span><h3>上传新资料（接口已保留）</h3><p>后续可加入 PDF/DOCX 上传、人工确认解析结果和“是否保留原文件”的逐次选择。第一版暂不开放，避免未经确认写入题库。</p><button className="secondary-button" disabled>后续版本开放</button></section>
        <section className="panel setting-card"><span className="setting-icon">↶</span><h3>30 天回收站</h3><p>未来删除自定义资料时先进入回收站，30 天内可恢复。内置的 800 词与词组资料不会被普通操作删除。</p><span className="quiet">当前 0 项</span></section>
        <section className="panel setting-card"><span className="setting-icon">⇄</span><h3>完整离线接口</h3><p>已预留本地题库、待同步队列和版本字段。未来开放后，断网提交会先进入队列，联网时再解决冲突并同步。</p><span className="quiet">第一版：仅草稿离线</span></section>
      </div>
    </section>
  );
}
