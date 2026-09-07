"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GradingResponseError, readGradeResults } from "@/lib/grade-response";
import { matchesSelfSpelling } from "@/lib/grading";
import { advanceSpellingSession, editSpellingAnswer, firstSpellingAnswers, handleSpellingEnter, restoreSpellingSession, spellingAction } from "@/lib/spelling-session";
import { beijingDate, dueReviews, normalizedAnswer, rollStateToToday } from "@/lib/study-state";
import type {
  ExerciseItem,
  GradeResult,
  PhraseItem,
  QuizKind,
  ReviewItem,
  StudyNote,
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
  | "comprehensive-practice";

type QuizQuestion = {
  id: string;
  kind: QuizKind;
  number: number;
  prompt: string;
  label: string;
  acceptedAnswers?: string[];
  note?: {
    sourceKind: StudyNote["sourceKind"];
    itemId: string;
    field: string;
    label: string;
  };
};

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const LOCAL_STATE_KEY = "toefl-study-state-v1-release";
const NOTEBOOK_POSITION_KEY = "toefl-notebook-position-v1";

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

function annotationProps(sourceKind: StudyNote["sourceKind"], itemId: string, field: string, label: string) {
  return {
    "data-note-anchor": `${sourceKind}:${itemId}:${field}`,
    "data-note-kind": sourceKind,
    "data-note-item": itemId,
    "data-note-field": field,
    "data-note-label": label,
  };
}

function selectNoteRange(element: HTMLElement, startOffset: number, endOffset: number, quote: string) {
  const fullText = element.textContent ?? "";
  const quoteOffset = fullText.indexOf(quote);
  const resolvedStart = quoteOffset >= 0 ? quoteOffset : Math.min(startOffset, fullText.length);
  const resolvedEnd = quoteOffset >= 0
    ? quoteOffset + quote.length
    : Math.min(Math.max(resolvedStart, endOffset), fullText.length);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let position = 0;
  let startSet = false;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (!startSet && resolvedStart <= position + length) {
      range.setStart(node, Math.max(0, resolvedStart - position));
      startSet = true;
    }
    if (startSet && resolvedEnd <= position + length) {
      range.setEnd(node, Math.max(0, resolvedEnd - position));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    position += length;
    node = walker.nextNode();
  }
}

function reviewsAfterResults(reviews: ReviewItem[], results: GradeResult[], date: string): ReviewItem[] {
  const nextReviews = [...reviews];
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
        nextReviewAt: addDays(date, 1),
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
        nextReviewAt: addDays(date, mastered ? 30 : [1, 3, 7][Math.min(streak, 2)]),
      };
    }
  }
  return nextReviews;
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
  const [comprehensiveBatchStart, setComprehensiveBatchStart] = useState<number | null>(null);
  const [noteJump, setNoteJump] = useState<{ note: StudyNote; token: number } | null>(null);

  const wordById = useMemo(() => new Map(vocabulary.map((item) => [item.id, item])), [vocabulary]);
  const phraseById = useMemo(() => new Map(phrases.map((item) => [item.id, item])), [phrases]);
  const exerciseById = useMemo(() => new Map(exercises.map((item) => [item.id, item])), [exercises]);

  const wordCount = state.settings.temporaryVocabularySize ?? state.settings.vocabularyBatchSize;
  const phraseCount = state.settings.temporaryPhraseSize ?? state.settings.phraseBatchSize;
  const activeWords = vocabulary.slice(state.progress.vocabularyNextIndex - 1, state.progress.vocabularyNextIndex - 1 + wordCount);
  const activePhrases = phrases.slice(state.progress.phraseNextIndex - 1, state.progress.phraseNextIndex - 1 + phraseCount);
  const comprehensiveExerciseNextIndex = Math.min(
    exercises.length + 1,
    Math.max(1, state.progress.comprehensiveExerciseNextIndex),
  );
  const comprehensiveStart = comprehensiveBatchStart ?? comprehensiveExerciseNextIndex;
  const activeComprehensiveExercises = exercises.slice(comprehensiveStart - 1, comprehensiveStart - 1 + 10);
  const comprehensiveUnlocked = state.progress.learnedPhrases.length >= phrases.length;
  const reviewsDue = dueReviews(state);

  const updateState = useCallback((change: (current: StudyState) => StudyState) => {
    setState((current) => ({ ...change(current), updatedAt: new Date().toISOString() }));
  }, []);

  const recordSelfSpellingCorrect = useCallback((itemId: string) => {
    updateState((current) => ({
      ...current,
      progress: {
        ...current.progress,
        selfSpellingCorrect: {
          ...current.progress.selfSpellingCorrect,
          [itemId]: (current.progress.selfSpellingCorrect[itemId] ?? 0) + 1,
        },
      },
    }));
  }, [updateState]);

  const addNote = useCallback((note: StudyNote) => {
    updateState((current) => ({
      ...current,
      notebook: { ...current.notebook, notes: [note, ...current.notebook.notes] },
    }));
  }, [updateState]);

  const updateNotebookText = useCallback((text: string) => {
    updateState((current) => ({
      ...current,
      notebook: { ...current.notebook, text },
    }));
  }, [updateState]);

  const openNote = useCallback((note: StudyNote) => {
    setNoteJump({ note, token: Date.now() });
    setView(note.sourceKind === "word" ? "words" : "phrases");
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
    let controllerChanged = false;
    const hadServiceWorkerController = Boolean(navigator.serviceWorker?.controller);
    const controllerChangeHandler = () => {
      if (!hadServiceWorkerController || controllerChanged) return;
      controllerChanged = true;
      window.location.reload();
    };
    if ("serviceWorker" in navigator) {
      if (import.meta.env.PROD) {
        navigator.serviceWorker.addEventListener("controllerchange", controllerChangeHandler);
        navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
          .then((registration) => registration.update())
          .catch(() => undefined);
      } else {
        // A development service worker can keep serving an old Vite client after
        // the local server has stopped. Remove it so localhost always reflects
        // the live development server and never appears to run in the background.
        navigator.serviceWorker.getRegistrations()
          .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
          .then(() => caches.keys())
          .then((keys) => Promise.all(keys.filter((key) => key.startsWith("toefl-study-shell-")).map((key) => caches.delete(key))))
          .catch(() => undefined);
      }
    }
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
      if (import.meta.env.PROD && "serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", controllerChangeHandler);
      }
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

  useEffect(() => {
    if (!noteJump) return;
    let highlightTimer = 0;
    const revealTimer = window.setTimeout(() => {
      const element = [...document.querySelectorAll<HTMLElement>("[data-note-anchor]")]
        .find((candidate) => candidate.dataset.noteAnchor === noteJump.note.anchorId);
      if (!element) return;
      const details = element.closest("details");
      if (details) details.open = true;
      element.classList.remove("note-jump-highlight");
      void element.offsetWidth;
      element.classList.add("note-jump-highlight");
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      selectNoteRange(element, noteJump.note.startOffset, noteJump.note.endOffset, noteJump.note.quote);
      highlightTimer = window.setTimeout(() => element.classList.remove("note-jump-highlight"), 3200);
    }, 80);
    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(highlightTimer);
    };
  }, [noteJump, view]);

  useEffect(() => {
    if (!ready || state.daily.submitted || reviewsDue.length > 0 || (!activeWords.length && !activePhrases.length)) return;
    const completed = state.daily.completed;
    const wordTasksDone = !activeWords.length
      || (completed.vocabularyLearn && completed.vocabularySpelling && completed.vocabularyCloze);
    const phraseTasksDone = !activePhrases.length
      || (completed.phraseLearn && completed.phraseSpelling);
    if (!wordTasksDone || !phraseTasksDone) return;

    const repairTimer = window.setTimeout(() => {
      updateState((current) => {
        if (current.daily.submitted) return current;
        const currentWordCount = current.settings.temporaryVocabularySize ?? current.settings.vocabularyBatchSize;
        const currentPhraseCount = current.settings.temporaryPhraseSize ?? current.settings.phraseBatchSize;
        const learnedWords = Array.from({ length: currentWordCount }, (_, index) => current.progress.vocabularyNextIndex + index)
          .filter((index) => index <= vocabulary.length);
        const learnedPhrases = Array.from({ length: currentPhraseCount }, (_, index) => current.progress.phraseNextIndex + index)
          .filter((index) => index <= phrases.length);
        return {
          ...current,
          settings: { ...current.settings, temporaryVocabularySize: null, temporaryPhraseSize: null },
          progress: {
            ...current.progress,
            vocabularyNextIndex: Math.min(vocabulary.length + 1, current.progress.vocabularyNextIndex + learnedWords.length),
            phraseNextIndex: Math.min(phrases.length + 1, current.progress.phraseNextIndex + learnedPhrases.length),
            learnedVocabulary: uniqueNumbers([...current.progress.learnedVocabulary, ...learnedWords]),
            learnedPhrases: uniqueNumbers([...current.progress.learnedPhrases, ...learnedPhrases]),
          },
          daily: { ...current.daily, submitted: true, continuousLearning: false },
        };
      });
    }, 0);
    return () => window.clearTimeout(repairTimer);
  }, [
    activePhrases.length,
    activeWords.length,
    phrases.length,
    ready,
    reviewsDue.length,
    state.daily.completed,
    state.daily.submitted,
    updateState,
    vocabulary.length,
  ]);

  const setCompleted = (key: keyof StudyState["daily"]["completed"]) => {
    updateState((current) => ({
      ...current,
      daily: { ...current.daily, completed: { ...current.daily.completed, [key]: true } },
    }));
  };

  const handleResults = (results: GradeResult[], completion: keyof StudyState["daily"]["completed"]) => {
    updateState((current) => {
      const nextReviews = reviewsAfterResults(current.progress.reviews, results, current.daily.date);

      const completed = { ...current.daily.completed, [completion]: true };
      let progress = { ...current.progress, reviews: nextReviews };
      let settings = current.settings;
      let submitted = current.daily.submitted;
      const completesBatch = completion === "phraseSpelling"
        || (completion === "vocabularyCloze" && activePhrases.length === 0);
      if (completesBatch) {
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
        daily: { ...current.daily, completed, submitted, continuousLearning: completesBatch ? false : current.daily.continuousLearning },
      };
    });
  };

  const startContinuousLearning = () => {
    if (!state.daily.submitted || reviewsDue.length > 0 || (!activeWords.length && !activePhrases.length)) return;
    updateState((current) => ({
      ...current,
      daily: {
        ...current.daily,
        continuousLearning: true,
        completed: {
          reviews: true,
          vocabularyLearn: false,
          vocabularySpelling: false,
          vocabularyCloze: false,
          phraseLearn: false,
          phraseSpelling: false,
        },
      },
    }));
    setView(activeWords.length ? "word-learn" : "phrase-learn");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleComprehensiveResults = (results: GradeResult[]) => {
    updateState((current) => {
      if (current.progress.learnedPhrases.length < phrases.length) return current;
      const completedCount = activeComprehensiveExercises.length;
      return {
        ...current,
        progress: {
          ...current.progress,
          reviews: reviewsAfterResults(current.progress.reviews, results, current.daily.date),
          comprehensiveExerciseNextIndex: Math.max(
            current.progress.comprehensiveExerciseNextIndex,
            Math.min(exercises.length + 1, comprehensiveStart + completedCount),
          ),
        },
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
    acceptedAnswers: [item.word],
    note: { sourceKind: "word" as const, itemId: item.id, field: "meaning", label: `${item.word} · 中文释义` },
  })), `${state.daily.date}:word-spelling`), [activeWords, state.daily.date]);

  const wordClozeQuestions = useMemo(() => shuffled(activeWords.map((item) => ({
    id: item.id,
    kind: "word_cloze" as const,
    number: item.index,
    prompt: item.exampleCloze.prompt,
    label: "填写完整英文单词：",
    note: { sourceKind: "word" as const, itemId: item.id, field: "example", label: `${item.word} · 例句` },
  })), `${state.daily.date}:word-cloze`), [activeWords, state.daily.date]);

  const phraseSpellingQuestions = useMemo(() => shuffled(activePhrases.map((item) => ({
    id: item.id,
    kind: "phrase_spelling" as const,
    number: item.index,
    prompt: `${item.meaningZh}（${item.category}）`,
    label: "请拼写完整搭配：",
    acceptedAnswers: item.acceptedAnswers,
    note: { sourceKind: "phrase" as const, itemId: item.id, field: "meaning", label: `${item.phrase} · 中文释义` },
  })), `${state.daily.date}:phrase-spelling`), [activePhrases, state.daily.date]);

  const comprehensiveExerciseQuestions = useMemo(() => shuffled(activeComprehensiveExercises.map((item) => ({
    id: item.id,
    kind: "phrase_exercise" as const,
    number: item.index,
    prompt: item.prompt,
    label: "填写完整英文答案：",
  })), `comprehensive:${comprehensiveStart}`), [activeComprehensiveExercises, comprehensiveStart]);

  const nextLearningView = (): View => {
    const completed = state.daily.completed;
    if (activeWords.length) {
      if (!completed.vocabularyLearn) return "word-learn";
      if (!completed.vocabularySpelling) return "word-quiz";
      if (!completed.vocabularyCloze) return "word-cloze";
    }
    if (activePhrases.length) {
      if (!completed.phraseLearn) return "phrase-learn";
      if (!completed.phraseSpelling) return "phrase-quiz";
    }
    return "today";
  };

  const navigate = (target: View) => {
    const learningViews: View[] = ["word-learn", "word-quiz", "word-cloze", "phrase-learn", "phrase-quiz"];
    if (learningViews.includes(target) && reviewsDue.length === 0 && !state.daily.completed.reviews) {
      setCompleted("reviews");
    }
    setNoteJump(null);
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
    if (view === "today") return <Dashboard state={state} reviewsDue={reviewsDue.length} activeWords={activeWords} activePhrases={activePhrases} navigate={navigate} updateState={updateState} onContinue={startContinuousLearning} />;
    if (view === "word-learn") return <WordLearning items={activeWords} correctCounts={state.progress.selfSpellingCorrect} onCorrect={recordSelfSpellingCorrect} onDone={() => { setCompleted("vocabularyLearn"); navigate("word-quiz"); }} />;
    if (view === "phrase-learn") return <PhraseLearning items={activePhrases} correctCounts={state.progress.selfSpellingCorrect} onCorrect={recordSelfSpellingCorrect} onDone={() => { setCompleted("phraseLearn"); navigate("phrase-quiz"); }} />;
    if (view === "review-quiz") return <QuizView key="review-quiz" title="到期错题复查" description="顺序已打乱。只填写英文，不提供首字母或长度提示。" questions={reviewQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "reviews")} onNext={() => navigate(nextLearningView())} nextLabel={nextLearningView() === "word-learn" ? "继续学习新单词" : nextLearningView() === "word-quiz" ? "继续单词拼写" : nextLearningView() === "word-cloze" ? "继续单词例句填空" : nextLearningView() === "phrase-learn" ? "继续学习新词组" : nextLearningView() === "phrase-quiz" ? "继续词组拼写" : "返回今日首页"} />;
    if (view === "word-quiz") return <QuizView key="word-quiz" title="单词无提示拼写" description="回车确认答案；答对后再回车进入下一题，答错后再回车重新拼写。整组完成后保存首次成绩。" questions={wordSpellingQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "vocabularySpelling")} onNext={() => navigate("word-cloze")} nextLabel="开始单词例句填空" />;
    if (view === "word-cloze") return <QuizView key="word-cloze" title="单词例句填空" description="请根据语法和语境填写完整单词。题面使用“已给字母  [还需字母数]”格式。" questions={wordClozeQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "vocabularyCloze")} onNext={() => navigate(activePhrases.length ? "phrase-learn" : "today")} nextLabel={activePhrases.length ? "开始学习词组" : "完成本轮学习"} />;
    if (view === "phrase-quiz") return <QuizView key="phrase-quiz" title="词组无提示拼写" description="回车确认答案；答错后必须重新拼写，正确后才能进入下一题。整组全部订正正确后保存首次成绩。" questions={phraseSpellingQuestions} date={state.daily.date} online={online} onComplete={(results) => handleResults(results, "phraseSpelling")} onNext={() => navigate("today")} nextLabel="完成本轮学习" />;
    if (view === "comprehensive-practice") return <QuizView key={`comprehensive-${comprehensiveStart}`} title={`综合填词练习 · 第 ${comprehensiveStart}—${comprehensiveStart + activeComprehensiveExercises.length - 1} 题`} description="原资料 Part 3：根据句子中已给出的字母和缺失数量，填写完整英文单词。此处进度与每日词组学习分开保存。" questions={comprehensiveExerciseQuestions} date={state.daily.date} online={online} onComplete={handleComprehensiveResults} onNext={() => { setComprehensiveBatchStart(null); navigate("phrases"); }} nextLabel="返回词组库" />;
    if (view === "words") return <WordLibrary key={`words-${noteJump?.token ?? "normal"}`} items={vocabulary} learned={state.progress.learnedVocabulary} correctCounts={state.progress.selfSpellingCorrect} onCorrect={recordSelfSpellingCorrect} focusItemId={noteJump?.note.sourceKind === "word" ? noteJump.note.itemId : undefined} />;
    if (view === "phrases") return <PhraseLibrary key={`phrases-${noteJump?.token ?? "normal"}`} items={phrases} learned={state.progress.learnedPhrases} correctCounts={state.progress.selfSpellingCorrect} onCorrect={recordSelfSpellingCorrect} exerciseNextIndex={comprehensiveExerciseNextIndex} totalExercises={exercises.length} focusItemId={noteJump?.note.sourceKind === "phrase" ? noteJump.note.itemId : undefined} onStartComprehensive={() => { if (!comprehensiveUnlocked || comprehensiveExerciseNextIndex > exercises.length) return; setComprehensiveBatchStart(comprehensiveExerciseNextIndex); navigate("comprehensive-practice"); }} />;
    if (view === "errors") return <ErrorBook reviews={state.progress.reviews} wordById={wordById} phraseById={phraseById} exerciseById={exerciseById} />;
    if (view === "progress") return <ProgressPage state={state} totalWords={vocabulary.length} totalPhrases={phrases.length} totalExercises={exercises.length} />;
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
          <div className="account-area"><span className={`sync-badge ${online ? "" : "offline"}`}>{!online ? "离线草稿" : storage === "cloud" ? "云端已连接" : "本机预览"}</span><button className="profile" aria-label="退出登录" title="退出登录" onClick={() => { void fetch("/api/auth/logout", { method: "POST" }).finally(() => window.location.replace("/")); }}>{displayName.slice(0, 2).toUpperCase()}</button></div>
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
      <NotebookWidget text={state.notebook.text} notes={state.notebook.notes} onTextChange={updateNotebookText} onAdd={addNote} onOpenNote={openNote} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function NavButton({ active, onClick, label, badge }: { active: boolean; onClick(): void; label: string; badge?: string }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><span>{label}</span>{badge && <b>{badge}</b>}</button>;
}

type NoteDraft = Omit<StudyNote, "id" | "body" | "createdAt">;

function NotebookWidget({ text, notes, onTextChange, onAdd, onOpenNote }: { text: string; notes: StudyNote[]; onTextChange(text: string): void; onAdd(note: StudyNote): void; onOpenNote(note: StudyNote): void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<NoteDraft | null>(null);
  const [body, setBody] = useState("");
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const widgetRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number; startX: number; startY: number } | null>(null);
  const dragPositionRef = useRef<{ x: number; y: number } | null>(null);
  const dragMovedRef = useRef(false);

  useEffect(() => {
    let savedPosition: { x: number; y: number } | null = null;
    try {
      const saved = localStorage.getItem(NOTEBOOK_POSITION_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { x?: number; y?: number };
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) savedPosition = { x: parsed.x!, y: parsed.y! };
    } catch {
      localStorage.removeItem(NOTEBOOK_POSITION_KEY);
    }
    if (!savedPosition) return;
    const timer = window.setTimeout(() => setPosition(savedPosition), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const captureSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const anchor = startElement?.closest<HTMLElement>("[data-note-anchor]");
      if (!anchor || !anchor.contains(range.endContainer)) return;
      const rawQuote = range.toString();
      const quote = rawQuote.trim();
      if (!quote) return;
      const before = range.cloneRange();
      before.selectNodeContents(anchor);
      before.setEnd(range.startContainer, range.startOffset);
      const leadingWhitespace = rawQuote.length - rawQuote.trimStart().length;
      const startOffset = before.toString().length + leadingWhitespace;
      const endOffset = startOffset + quote.length;
      const fullText = anchor.textContent ?? "";
      const sourceKind = anchor.dataset.noteKind;
      const itemId = anchor.dataset.noteItem;
      const field = anchor.dataset.noteField;
      const label = anchor.dataset.noteLabel;
      const anchorId = anchor.dataset.noteAnchor;
      if ((sourceKind !== "word" && sourceKind !== "phrase") || !itemId || !field || !label || !anchorId) return;
      setSelectionDraft({
        anchorId,
        sourceKind,
        itemId,
        field,
        label,
        quote,
        startOffset,
        endOffset,
        prefix: fullText.slice(Math.max(0, startOffset - 28), startOffset),
        suffix: fullText.slice(endOffset, endOffset + 28),
      });
    };
    const selectionChange = () => window.setTimeout(captureSelection, 0);
    const mouseUp = (event: MouseEvent) => {
      if (widgetRef.current?.contains(event.target as Node)) return;
      window.setTimeout(captureSelection, 0);
    };
    const touchEnd = (event: TouchEvent) => {
      if (widgetRef.current?.contains(event.target as Node)) return;
      window.setTimeout(captureSelection, 80);
    };
    document.addEventListener("selectionchange", selectionChange);
    document.addEventListener("mouseup", mouseUp);
    document.addEventListener("touchend", touchEnd);
    return () => {
      document.removeEventListener("selectionchange", selectionChange);
      document.removeEventListener("mouseup", mouseUp);
      document.removeEventListener("touchend", touchEnd);
    };
  }, []);

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    const targetButton = (event.target as HTMLElement).closest("button");
    if ((targetButton && targetButton !== event.currentTarget) || !widgetRef.current) return;
    const bounds = widgetRef.current.getBoundingClientRect();
    const currentPosition = { x: bounds.left, y: bounds.top };
    dragMovedRef.current = false;
    dragPositionRef.current = currentPosition;
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top, startX: event.clientX, startY: event.clientY };
    setPosition(currentPosition);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !widgetRef.current) return;
    const bounds = widgetRef.current.getBoundingClientRect();
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) dragMovedRef.current = true;
    const nextPosition = {
      x: Math.min(Math.max(8, event.clientX - drag.offsetX), Math.max(8, window.innerWidth - bounds.width - 8)),
      y: Math.min(Math.max(8, event.clientY - drag.offsetY), Math.max(8, window.innerHeight - bounds.height - 8)),
    };
    dragPositionRef.current = nextPosition;
    setPosition(nextPosition);
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const finalPosition = dragPositionRef.current;
    if (finalPosition) localStorage.setItem(NOTEBOOK_POSITION_KEY, JSON.stringify(finalPosition));
    if (event.type === "pointercancel") dragMovedRef.current = false;
  };

  const openNotebook = () => {
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    if (widgetRef.current && position) {
      const bounds = widgetRef.current.getBoundingClientRect();
      const openWidth = Math.min(300, window.innerWidth - 16);
      const openHeight = Math.min(390, Math.max(160, window.innerHeight - 90));
      const fittedPosition = {
        x: Math.min(Math.max(8, bounds.left), Math.max(8, window.innerWidth - openWidth - 8)),
        y: Math.min(Math.max(8, bounds.top), Math.max(8, window.innerHeight - openHeight - 8)),
      };
      dragPositionRef.current = fittedPosition;
      setPosition(fittedPosition);
      localStorage.setItem(NOTEBOOK_POSITION_KEY, JSON.stringify(fittedPosition));
    }
    setOpen(true);
  };

  const clearDraft = () => {
    setDraft(null);
    setSelectionDraft(null);
    setBody("");
    window.getSelection()?.removeAllRanges();
  };

  const startAnnotation = () => {
    if (!selectionDraft) return;
    setDraft(selectionDraft);
    setBody("");
    openNotebook();
  };

  const saveNote = () => {
    if (!draft || !body.trim()) return;
    onAdd({
      ...draft,
      id: crypto.randomUUID(),
      body: body.trim(),
      createdAt: new Date().toISOString(),
    });
    clearDraft();
  };

  const style = position ? { left: `${position.x}px`, top: `${position.y}px`, right: "auto", bottom: "auto" } : undefined;
  return (
    <aside className={`notebook-widget ${open ? "open" : "collapsed"}`} style={style} ref={widgetRef} aria-label="笔记本">
      {!open ? (
        <>
          {selectionDraft && <button className="selection-note-chip" onClick={startAnnotation}>添加注释</button>}
          <button
            className="notebook-launcher"
            aria-label={`笔记本，共 ${notes.length} 条笔记；点击打开，拖动移动`}
            title="点击打开，拖动移动"
            onClick={openNotebook}
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >笔记 <span>{notes.length}</span></button>
        </>
      ) : (
        <>
          <div className="notebook-header" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <div><strong>笔记本</strong><small>拖动这里移动</small></div>
            <button aria-label="收起笔记本" onClick={() => setOpen(false)}>—</button>
          </div>
          <div className="notebook-content">
            <label className="free-notebook-editor">
              <span>自由笔记</span>
              <textarea aria-label="自由笔记" placeholder="随时在这里记录内容……" value={text} onChange={(event) => onTextChange(event.target.value)} />
              <small>内容会自动保存到学习记录。</small>
            </label>
            {!draft && (
              <div className={`notebook-selection-bar ${selectionDraft ? "ready" : ""}`}>
                <span>{selectionDraft ? `已选：“${selectionDraft.quote.length > 24 ? `${selectionDraft.quote.slice(0, 24)}…` : selectionDraft.quote}”` : "选中单词或词组资料后，可在这里添加注释。"}</span>
                <button className="secondary-button" disabled={!selectionDraft} onClick={startAnnotation}>添加选中内容</button>
              </div>
            )}
            {draft ? (
              <section className="note-compose">
                <span>{draft.label}</span>
                <blockquote>{draft.quote}</blockquote>
                <label><span>写下注释</span><textarea placeholder="这段内容提醒了我什么？" value={body} onChange={(event) => setBody(event.target.value)} /></label>
                <div className="notebook-actions"><button className="text-button" onClick={clearDraft}>取消</button><button className="secondary-button" disabled={!body.trim()} onClick={saveNote}>保存注释</button></div>
              </section>
            ) : notes.length ? (
              <div className="notebook-list"><strong className="notebook-section-title">资料注释</strong>
                {notes.map((note) => (
                  <button className="notebook-note" key={note.id} onClick={() => { setOpen(false); onOpenNote(note); }}>
                    <span>{note.label}</span>
                    <blockquote>{note.quote}</blockquote>
                    <p>{note.body}</p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="notebook-empty"><strong>还没有资料注释</strong><p>上面的文字簿可以直接使用；选中文字添加注释是补充功能。</p></div>
            )}
          </div>
        </>
      )}
    </aside>
  );
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
    "comprehensive-practice": "综合填词练习",
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
    return item ? { id: item.id, kind: review.kind, number, prompt: `${item.meaningsZh}（${item.partOfSpeech}）`, label: "请拼写：", acceptedAnswers: [item.word], note: { sourceKind: "word", itemId: item.id, field: "meaning", label: `${item.word} · 中文释义` } } : null;
  }
  if (review.kind === "word_cloze") {
    const item = words.get(review.itemId);
    return item ? { id: item.id, kind: review.kind, number, prompt: item.exampleCloze.prompt, label: "填写完整英文单词：", note: { sourceKind: "word", itemId: item.id, field: "example", label: `${item.word} · 例句` } } : null;
  }
  if (review.kind === "phrase_spelling") {
    const item = phrases.get(review.itemId);
    return item ? { id: item.id, kind: review.kind, number, prompt: `${item.meaningZh}（${item.category}）`, label: "请拼写完整搭配：", acceptedAnswers: item.acceptedAnswers, note: { sourceKind: "phrase", itemId: item.id, field: "meaning", label: `${item.phrase} · 中文释义` } } : null;
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
  onContinue,
}: {
  state: StudyState;
  reviewsDue: number;
  activeWords: VocabularyItem[];
  activePhrases: PhraseItem[];
  navigate(view: View): void;
  updateState(change: (current: StudyState) => StudyState): void;
  onContinue(): void;
}) {
  const completed = state.daily.completed;
  const reviewDone = completed.reviews || reviewsDue === 0;
  const contentExhausted = activeWords.length === 0 && activePhrases.length === 0;
  const betweenBatches = state.daily.submitted && !state.daily.continuousLearning;
  const tasks: Array<[string, string, boolean]> = betweenBatches
    ? [
        ["到期错词与错题", "本轮开始前已完成", true],
        ["本轮学习任务", contentExhausted ? "全部学习资料已完成" : "已完成，可以继续下一批", true],
      ]
    : [["到期错词与错题", reviewsDue ? `${reviewsDue} 项` : "今日无到期", reviewDone]];
  if (!betweenBatches && activeWords.length) {
    tasks.push(["学习新单词", `${activeWords.length} 个`, completed.vocabularyLearn], ["单词无提示拼写", `${activeWords.length} 题`, completed.vocabularySpelling], ["单词例句填空", `${activeWords.length} 题`, completed.vocabularyCloze]);
  }
  if (!betweenBatches && activePhrases.length) {
    tasks.push(["学习新词组", `${activePhrases.length} 个`, completed.phraseLearn], ["词组无提示拼写", `${activePhrases.length} 题`, completed.phraseSpelling]);
  }
  const taskValues = tasks.map((task) => task[2]);
  const progress = betweenBatches ? 100 : Math.round((taskValues.filter(Boolean).length / taskValues.length) * 100);
  const canContinue = betweenBatches && reviewsDue === 0 && !contentExhausted;
  const next = betweenBatches
    ? contentExhausted
      ? { title: "全部学习资料已经完成", detail: "800 个单词和 100 个词组都已学完，之后仍可继续完成到期复习和综合填词。", action: "查看进度", view: "progress" as View }
      : { title: "本轮任务已完成，还要继续吗？", detail: `下一批可以学习 ${activeWords.length ? `${activeWords.length} 个单词` : ""}${activeWords.length && activePhrases.length ? "和" : ""}${activePhrases.length ? `${activePhrases.length} 个词组` : ""}，完成后还可以再次继续。`, action: "继续学习", view: "today" as View }
    : !reviewDone && reviewsDue > 0
    ? { title: `先复习 ${reviewsDue} 个到期错词/错题`, detail: "错词会按间隔重复检查，连续多次正确后才暂时停止。", action: "开始复习", view: "review-quiz" as View }
    : activeWords.length > 0 && !completed.vocabularyLearn
      ? { title: `学习第 ${activeWords[0]?.index ?? "—"}—${activeWords.at(-1)?.index ?? "—"} 词`, detail: `今天学习 ${activeWords.length} 个新单词，当前批次完成后才会开放下一批。`, action: "开始学习", view: "word-learn" as View }
      : activeWords.length > 0 && !completed.vocabularySpelling
        ? { title: "完成单词无提示拼写", detail: "顺序打乱，整组提交后统一批改。", action: "开始拼写", view: "word-quiz" as View }
        : activeWords.length > 0 && !completed.vocabularyCloze
          ? { title: "完成单词例句填空", detail: "在真实语境中检查词义、词形与拼写。", action: "开始填空", view: "word-cloze" as View }
          : activePhrases.length > 0 && !completed.phraseLearn
            ? { title: `学习 ${activePhrases.length} 个完整词组`, detail: "词组与单词分开记录，不会因包含相同单词而合并。", action: "学习词组", view: "phrase-learn" as View }
            : activePhrases.length > 0 && !completed.phraseSpelling
              ? { title: "完成词组无提示拼写", detail: "完整搭配、词序和介词都必须正确。", action: "开始拼写", view: "phrase-quiz" as View }
              : { title: "全部学习资料已经完成", detail: "今天没有新的学习内容，仍可按日期完成到期复习。", action: "查看进度", view: "progress" as View };

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
          <span className="pill">{betweenBatches ? "本轮完成" : state.daily.continuousLearning ? "自主加学" : "当前任务"}</span>
          <h2>{next.title}</h2>
          <p>{next.detail}</p>
          <div className="hero-actions"><button className="primary-button" onClick={() => canContinue ? onContinue() : navigate(next.view)}>{next.action} <span>→</span></button></div>
        </div>
        <div className="progress-ring" style={{ "--progress": `${progress}%` } as React.CSSProperties} aria-label={`今日进度 ${progress}%`}><strong>{progress}%</strong><span>今日进度</span></div>
      </section>

      <div className="content-grid">
        <section className="panel task-panel">
          <div className="panel-heading"><div><span className="eyebrow">学习路线</span><h2>{state.daily.continuousLearning ? "本轮自主学习" : "今日任务"}</h2></div><span className="quiet">{taskValues.filter(Boolean).length} / {tasks.length}</span></div>
          <div className="task-list">
            {tasks.map(([label, detail, done], index) => {
              const firstIncomplete = tasks.findIndex((task) => !task[2]);
              return <article className={`task-row ${done ? "done" : index === firstIncomplete ? "current" : "locked"}`} key={label}><span className="task-index">{done ? "✓" : index + 1}</span><div><strong>{label}</strong><small>{detail}</small></div><span className="task-state">{done ? "已完成" : index === firstIncomplete ? "进行中" : "待解锁"}</span></article>;
            })}
          </div>
        </section>

        <aside className="right-column">
          <section className="panel reduction-panel">
            <span className="eyebrow">{betweenBatches ? "下一批" : "本轮数量"}</span><h2>{betweenBatches ? "选择后继续学习" : "可以临时调整数量"}</h2>
            <p>{betweenBatches ? "默认是 15 个单词和 10 个词组；完成后仍可继续下一批。" : "只改变当前这一批，完成后恢复默认数量。"}</p>
            {activeWords.length > 0 && <div className="choice-group"><strong>单词</strong>{[5, 10, 15].map((size) => <button disabled={!betweenBatches && completed.vocabularyLearn} className={activeWords.length === size ? "selected" : ""} onClick={() => changeWordSize(size)} key={size}>{size} 个</button>)}</div>}
            {activePhrases.length > 0 && <div className="choice-group"><strong>词组</strong>{[3, 5, 10].map((size) => <button disabled={!betweenBatches && completed.phraseLearn} className={activePhrases.length === size ? "selected" : ""} onClick={() => changePhraseSize(size)} key={size}>{size} 个</button>)}</div>}
          </section>
          {(!state.daily.submitted || state.daily.continuousLearning) && <section className="panel reminder-panel"><span className="reminder-dot" /><div><strong>任务会在下次登录时继续显示</strong><p>网站关闭时不会外部提醒，也不会自动累积新词。</p></div></section>}
        </aside>
      </div>
    </>
  );
}

function useSelfSpelling(items: Array<VocabularyItem | PhraseItem>, onCorrect: (itemId: string) => void) {
  const [spellingId, setSpellingId] = useState<string | null>(null);
  const [spellingAnswer, setSpellingAnswer] = useState("");
  const [spellingResult, setSpellingResult] = useState<"correct" | "wrong" | null>(null);
  const spellingInputRef = useRef<HTMLInputElement>(null);
  const countedAttemptRef = useRef(false);
  const activePosition = items.findIndex((item) => item.id === spellingId);

  useEffect(() => {
    if (spellingId) spellingInputRef.current?.focus();
  }, [spellingId, spellingResult]);

  const restore = () => {
    countedAttemptRef.current = false;
    setSpellingId(null);
    setSpellingAnswer("");
    setSpellingResult(null);
  };

  const start = (itemId: string) => {
    countedAttemptRef.current = false;
    setSpellingId(itemId);
    setSpellingAnswer("");
    setSpellingResult(null);
  };

  const confirm = (item: VocabularyItem | PhraseItem) => {
    if (!spellingAnswer.trim() || spellingResult) return;
    const correct = matchesSelfSpelling(spellingAnswer, "word" in item ? [item.word] : item.acceptedAnswers);
    setSpellingResult(correct ? "correct" : "wrong");
    if (correct && !countedAttemptRef.current) {
      countedAttemptRef.current = true;
      onCorrect(item.id);
    }
  };

  const retry = () => {
    countedAttemptRef.current = false;
    setSpellingAnswer("");
    setSpellingResult(null);
  };

  const next = () => {
    if (spellingResult !== "correct") return;
    const nextItem = items[activePosition + 1];
    if (nextItem) start(nextItem.id);
    else restore();
  };

  const advance = (item: VocabularyItem | PhraseItem) => {
    const action = spellingAction(spellingResult, spellingAnswer);
    if (action === "confirm") confirm(item);
    else if (action === "retry") retry();
    else if (action === "next") next();
  };

  return {
    activeId: spellingId,
    answer: spellingAnswer,
    result: spellingResult,
    inputRef: spellingInputRef,
    hasNext: activePosition >= 0 && activePosition < items.length - 1,
    setAnswer: setSpellingAnswer,
    start,
    confirm,
    retry,
    next,
    restore,
    advance,
  };
}

function SelfSpellingPanel({ item, spelling }: { item: VocabularyItem | PhraseItem; spelling: ReturnType<typeof useSelfSpelling> }) {
  const isWord = "word" in item;
  const expected = isWord ? item.word : item.phrase;
  return (
    <div className="library-spelling-panel">
      {!spelling.result ? (
        <>
          <p>{isWord ? "请根据中文释义拼写英文" : "请根据中文释义填写完整词组"}；回车确认，本次练习不计入错题。</p>
          <div className="spelling-action-row">
            <button className="secondary-button" disabled={!spelling.answer.trim()} onClick={() => spelling.confirm(item)} onKeyDown={(event) => handleSpellingEnter(event, () => spelling.advance(item))}>确认</button>
            <button className="secondary-button" onClick={spelling.restore}>还原</button>
          </div>
        </>
      ) : (
        <>
          <p className={`spelling-feedback ${spelling.result}`} role="status">
            {spelling.result === "correct" ? "拼写正确" : "拼写错误"}，正确拼写：<strong>{expected}</strong>
          </p>
          <div className="spelling-action-row">
            {spelling.result === "wrong" ? (
              <button className="secondary-button" onClick={spelling.retry} onKeyDown={(event) => handleSpellingEnter(event, spelling.retry)}>重新拼写（回车）</button>
            ) : (
              <button className="secondary-button" onClick={spelling.next} onKeyDown={(event) => handleSpellingEnter(event, spelling.next)}>{spelling.hasNext ? isWord ? "下一个单词" : "下一个词组" : "结束练习"}（回车）</button>
            )}
            <button className="secondary-button" onClick={spelling.restore}>还原</button>
          </div>
        </>
      )}
    </div>
  );
}

function WordLearning({ items, correctCounts, onCorrect, onDone }: { items: VocabularyItem[]; correctCounts: Record<string, number>; onCorrect(itemId: string): void; onDone(): void }) {
  const spelling = useSelfSpelling(items, onCorrect);
  return (
    <section className="learning-page">
      <div className="section-intro"><span className="pill">新单词 · {items.length} 个</span><h2>先理解，再检查拼写</h2><p>每个词都来自 800 词资料。卡片内可自由拼写且不计错题；正式拼写抽查仍在下一步进行。</p></div>
      <div className="study-card-grid">
        {items.map((item) => {
          const active = spelling.activeId === item.id;
          return (
            <article className={`study-card ${active ? "spelling-active" : ""}`} key={item.id}>
              <div className="card-number">{item.index}</div>
              <div className="word-heading">
                {active ? (
                  <input
                    className="library-spelling-input study-spelling-input"
                    aria-label={`根据“${item.meaningsZh}”拼写英文单词`}
                    autoComplete="off"
                    readOnly={Boolean(spelling.result)}
                    placeholder="请输入英文拼写"
                    ref={spelling.inputRef}
                    spellCheck={false}
                    value={spelling.answer}
                    onChange={(event) => spelling.setAnswer(event.target.value)}
                    onKeyDown={(event) => handleSpellingEnter(event, () => spelling.advance(item))}
                  />
                ) : <h3 {...annotationProps("word", item.id, "word", `${item.word} · 单词`)}>{item.word}</h3>}
                <span>{item.partOfSpeech}</span>
                {!active && <button className="spelling-button" onClick={() => spelling.start(item.id)}>拼写</button>}
                <span className="spelling-count">自行拼对 {correctCounts[item.id] ?? 0} 次</span>
              </div>
              {active ? (
                <>
                  <p className="meaning" {...annotationProps("word", item.id, "meaning", `${item.word} · 中文释义`)}>{item.meaningsZh}</p>
                  <SelfSpellingPanel item={item} spelling={spelling} />
                </>
              ) : (
                <>
                  <p className="pronunciation" {...annotationProps("word", item.id, "pronunciation", `${item.word} · 发音`)}>{item.pronunciation}</p>
                  <p className="meaning" {...annotationProps("word", item.id, "meaning", `${item.word} · 中文释义`)}>{item.meaningsZh}</p>
                  <details><summary>查看释义、记忆和例句</summary><p {...annotationProps("word", item.id, "definition", `${item.word} · 英文释义`)}><strong>英文释义：</strong>{item.definitionEn}</p>{item.mnemonic && <p {...annotationProps("word", item.id, "mnemonic", `${item.word} · 记忆`)}><strong>记忆：</strong>{item.mnemonic}</p>}<p className="example" {...annotationProps("word", item.id, "example", `${item.word} · 例句`)}><strong>例句：</strong>{item.example}</p></details>
                </>
              )}
            </article>
          );
        })}
      </div>
      <div className="sticky-action"><div><strong>已经学习完这 {items.length} 个单词？</strong><small>下一步不提供任何拼写提示。</small></div><button className="primary-button" onClick={onDone}>开始整组拼写 →</button></div>
    </section>
  );
}

function PhraseCard({ item, spelling, correctCount, status }: { item: PhraseItem; spelling: ReturnType<typeof useSelfSpelling>; correctCount: number; status: string }) {
  const active = spelling.activeId === item.id;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active, spelling.result]);
  return (
    <article className={`phrase-card ${active ? "spelling-active" : ""}`}>
      <span>{item.index}</span>
      <div className="phrase-card-main">
        <div className="phrase-heading">
          {active ? (
            <input
              className="library-spelling-input"
              aria-label={`根据“${item.meaningZh}”拼写完整词组`}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              readOnly={Boolean(spelling.result)}
              placeholder="请输入完整词组"
              ref={inputRef}
              spellCheck={false}
              value={spelling.answer}
              onChange={(event) => spelling.setAnswer(event.target.value)}
              onKeyDown={(event) => handleSpellingEnter(event, () => spelling.advance(item))}
            />
          ) : <h3 {...annotationProps("phrase", item.id, "phrase", `${item.phrase} · 词组`)}>{item.phrase}</h3>}
          {!active && <button className="spelling-button" onClick={() => spelling.start(item.id)}>拼写</button>}
          <span className="spelling-count">拼对 {correctCount} 次</span>
        </div>
        <p className="phrase-meaning" {...annotationProps("phrase", item.id, "meaning", `${item.phrase} · 中文释义`)}>{item.meaningZh}</p>
        {active && <SelfSpellingPanel item={item} spelling={spelling} />}
      </div>
      {!active && <small className="phrase-status">{status}</small>}
    </article>
  );
}

function PhraseLearning({ items, correctCounts, onCorrect, onDone }: { items: PhraseItem[]; correctCounts: Record<string, number>; onCorrect(itemId: string): void; onDone(): void }) {
  const spelling = useSelfSpelling(items, onCorrect);
  return (
    <section className="learning-page">
      <div className="section-intro"><span className="pill">新词组 · {items.length} 个</span><h2>记住完整搭配</h2><p>词组学习进度与单词完全分开。介词、词序和词形都会在拼写抽查中检查。</p></div>
      <div className="phrase-study-list">
        {items.map((item) => <PhraseCard key={item.id} item={item} spelling={spelling} correctCount={correctCounts[item.id] ?? 0} status={item.category} />)}
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
  const sequential = quizQuestions.length > 0 && quizQuestions.every((item) =>
    (item.kind === "word_spelling" || item.kind === "phrase_spelling") && item.acceptedAnswers?.length);
  const draftKey = `toefl-draft:${date}:${quizQuestions.map((item) => `${item.kind}-${item.id}`).join("|")}`;
  const sequenceDraftKey = `${draftKey}:stepwise-v1`;
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
  const [sequence, setSequence] = useState(() => {
    let saved: unknown = null;
    try {
      if (typeof localStorage !== "undefined") saved = JSON.parse(localStorage.getItem(sequenceDraftKey) ?? "null");
    } catch { /* Keep the older answer draft when a stepwise draft is unreadable. */ }
    return restoreSpellingSession(quizQuestions, saved, answers);
  });
  const [results, setResults] = useState<GradeResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [correctionAnswers, setCorrectionAnswers] = useState<Record<string, string>>({});
  const [correctionFeedback, setCorrectionFeedback] = useState<Record<string, "wrong" | "correct">>({});
  const [correctedKeys, setCorrectedKeys] = useState<string[]>([]);
  const completedOnce = useRef(false);
  const submittingRef = useRef(false);
  const sequenceInputRef = useRef<HTMLInputElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const firstAnswers = sequential ? firstSpellingAnswers(sequence, quizQuestions) : answers;
  const activeIndex = Math.min(sequence.index, quizQuestions.length - 1);
  const activeQuestion = quizQuestions[activeIndex];
  const activeKey = activeQuestion ? `${activeQuestion.kind}:${activeQuestion.id}` : "";
  const activeFeedback = activeQuestion ? sequence.entries[activeKey]?.feedback : null;

  useEffect(() => {
    if (!sequential) return;
    if (results) nextButtonRef.current?.focus();
    else sequenceInputRef.current?.focus();
  }, [sequential, sequence.index, activeFeedback, results, submitting]);

  const completeOnce = (gradedResults: GradeResult[]) => {
    if (completedOnce.current) return;
    completedOnce.current = true;
    onComplete(gradedResults);
  };

  useEffect(() => {
    if (results) return;
    try {
      if (sequential) localStorage.setItem(sequenceDraftKey, JSON.stringify(sequence));
      else localStorage.setItem(draftKey, JSON.stringify(answers));
    } catch { /* Storage restrictions must not interrupt typing. */ }
  }, [answers, draftKey, results, sequence, sequenceDraftKey, sequential]);

  const submit = async (submittedAnswers = answers) => {
    if (submittingRef.current || results) return;
    if (!online) {
      setError("当前离线：答案草稿已保留，联网后才能正式提交并写入云端记录。");
      return;
    }
    const missing = quizQuestions.filter((item) => !(submittedAnswers[`${item.kind}:${item.id}`] ?? "").trim());
    if (missing.length) {
      setError(`还有 ${missing.length} 题未填写。整组完成后才能统一提交。`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    setNeedsLogin(false);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: `${date}:${quizQuestions[0]?.kind ?? "review"}:${crypto.randomUUID()}`,
          items: quizQuestions.map((item) => ({ id: item.id, kind: item.kind, answer: submittedAnswers[`${item.kind}:${item.id}`] ?? "" })),
        }),
      });
      const gradedResults = await readGradeResults(response, quizQuestions);
      if (sequential && gradedResults.some((result) => {
        const question = quizQuestions.find((item) => item.id === result.id && item.kind === result.kind)!;
        return result.correct !== matchesSelfSpelling(submittedAnswers[`${result.kind}:${result.id}`], question.acceptedAnswers ?? []);
      })) {
        throw new GradingResponseError("当前资料与评分版本不一致。答案草稿已保留，请刷新后重试。");
      }
      setResults(gradedResults);
      try {
        localStorage.removeItem(draftKey);
        if (sequential) localStorage.removeItem(sequenceDraftKey);
      } catch { /* Saving official results does not depend on device storage. */ }
      const hasWrongWordSpelling = gradedResults.some((item) => item.kind === "word_spelling" && !item.correct);
      if (sequential || !hasWrongWordSpelling) completeOnce(gradedResults);
    } catch (submissionError) {
      if (submissionError instanceof GradingResponseError) {
        setError(submissionError.message);
        setNeedsLogin(submissionError.needsLogin);
      } else {
        setError(controller.signal.aborted
          ? "提交等待时间过长。答案草稿已保留，请重试提交。"
          : "暂时无法连接评分服务。答案草稿已保留，请检查网络后重试。");
      }
    } finally {
      window.clearTimeout(timeout);
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const advanceSequence = () => {
    if (submittingRef.current || results) return;
    const nextSequence = advanceSpellingSession(sequence, quizQuestions);
    setSequence(nextSequence);
    setError("");
    if (nextSequence.index === quizQuestions.length) {
      void submit(firstSpellingAnswers(nextSequence, quizQuestions));
    }
  };

  const resultMap = useMemo(() => new Map(results?.map((item) => [`${item.kind}:${item.id}`, item]) ?? []), [results]);
  const correctCount = results?.filter((item) => item.correct).length ?? 0;
  const wrongWordResults = useMemo(
    () => sequential ? [] : results?.filter((item) => item.kind === "word_spelling" && !item.correct) ?? [],
    [results, sequential],
  );
  const pendingCorrectionCount = wrongWordResults.filter((item) => !correctedKeys.includes(`${item.kind}:${item.id}`)).length;

  const submitCorrection = (result: GradeResult) => {
    const key = `${result.kind}:${result.id}`;
    const correction = correctionAnswers[key] ?? "";
    const correct = normalizedAnswer(correction) === normalizedAnswer(result.expected);
    setCorrectionFeedback((current) => ({ ...current, [key]: correct ? "correct" : "wrong" }));
    if (correct) {
      const nextCorrectedKeys = correctedKeys.includes(key) ? correctedKeys : [...correctedKeys, key];
      setCorrectedKeys(nextCorrectedKeys);
      if (results && wrongWordResults.every((item) => nextCorrectedKeys.includes(`${item.kind}:${item.id}`))) {
        completeOnce(results);
      }
    }
  };

  return (
    <section className="quiz-page">
      <div className="section-intro"><span className="pill">{sequential ? results ? "本组完成" : `逐题拼写 · ${activeIndex + 1} / ${quizQuestions.length}` : `整组提交 · ${quizQuestions.length} 题`}</span><h2>{title}</h2><p>{description}</p></div>
      {results && <section className="result-summary"><div><span>{sequential ? "首次作答成绩" : "本组成绩"}</span><strong>{correctCount} / {results.length}</strong></div><p>{correctCount === results.length ? "全部正确，这一组很稳。" : sequential ? `有 ${results.length - correctCount} 题首次答错，现已全部订正；每题只记 1 次错误。` : wrongWordResults.length > 0 ? `有 ${wrongWordResults.length} 个单词需要订正。本轮每个错词只记 1 次，订正中的错误不会重复计数。` : `有 ${results.length - correctCount} 题已加入对应的错题类别，下面已给出完整解释。`}</p></section>}
      <div className="question-list">
        {quizQuestions.map((question, index) => {
          if (sequential && !results && index !== activeIndex) return null;
          const key = `${question.kind}:${question.id}`;
          const result = resultMap.get(key);
          const entry = sequence.entries[key];
          const feedback = sequential && !results ? entry?.feedback : null;
          return (
            <article className={`question-card ${result ? result.correct ? "correct" : "wrong" : feedback ?? ""}`} key={key}>
              <div className="question-meta"><span>{index + 1}</span><small>{result ? result.correct ? "首次正确" : sequential ? "已订正" : "需要订正" : feedback ? feedback === "correct" ? "拼写正确" : "拼写错误" : `资料题号 ${question.number}`}</small></div>
              <p className="question-prompt" {...(question.note ? annotationProps(question.note.sourceKind, question.note.itemId, question.note.field, question.note.label) : {})}>{question.prompt}</p>
              <label><span>{question.label}</span>{sequential && !results ? (
                <input
                  ref={sequenceInputRef}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  readOnly={Boolean(feedback) || submitting || sequence.index === quizQuestions.length}
                  value={entry?.answer ?? ""}
                  onChange={(event) => setSequence((current) => editSpellingAnswer(current, quizQuestions, event.target.value))}
                  onKeyDown={(event) => handleSpellingEnter(event, advanceSequence)}
                />
              ) : <input autoComplete="off" spellCheck={false} disabled={Boolean(results)} value={firstAnswers[key] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [key]: event.target.value }))} />}</label>
              {sequential && !results && (
                <div className="stepwise-feedback" aria-live="polite">
                  {feedback ? <p className={`spelling-feedback ${feedback}`}>{feedback === "correct" ? "拼写正确" : "拼写错误"}，正确拼写：<strong>{question.acceptedAnswers?.[0]}</strong></p> : <p>{entry?.firstAnswer !== undefined ? "请重新拼写；本题的错误只记录一次。" : "输入后按回车确认。"}</p>}
                </div>
              )}
              {result && !result.correct && <WrongExplanation result={result} />}
              {result && !result.correct && result.kind === "word_spelling" && !sequential && (
                <div className={`correction-box ${correctedKeys.includes(key) ? "correct" : correctionFeedback[key] === "wrong" ? "wrong" : ""}`}>
                  <label>
                    <span>{correctedKeys.includes(key) ? "订正完成" : "请重新拼写这个单词，正确后才能继续："}</span>
                    <input
                      autoComplete="off"
                      spellCheck={false}
                      disabled={correctedKeys.includes(key)}
                      value={correctionAnswers[key] ?? ""}
                      onChange={(event) => setCorrectionAnswers((current) => ({ ...current, [key]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (correctionAnswers[key] ?? "").trim()) submitCorrection(result);
                      }}
                    />
                  </label>
                  {!correctedKeys.includes(key) && <button className="secondary-button" disabled={!(correctionAnswers[key] ?? "").trim()} onClick={() => submitCorrection(result)}>确认订正</button>}
                  {correctionFeedback[key] === "wrong" && <p className="correction-message wrong" role="alert">仍不正确。正确拼写是 <strong>{result.expected}</strong>，请重新输入。</p>}
                  {correctionFeedback[key] === "correct" && <p className="correction-message correct">订正正确。这次订正不会增加错误次数。</p>}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {error && <div className="form-error" role="alert">{error}{needsLogin && <button className="secondary-button" onClick={() => window.location.reload()}>刷新并重新登录</button>}</div>}
      <div className="quiz-submit">
        {!results ? sequential ? (
          <button className="primary-button" disabled={submitting || !activeQuestion || (!activeFeedback && !(sequence.entries[activeKey]?.answer ?? "").trim())} onClick={advanceSequence} onKeyDown={(event) => handleSpellingEnter(event, advanceSequence)}>
            {submitting ? "正在保存本组成绩…" : sequence.index === quizQuestions.length ? "重试提交本组（回车）" : activeFeedback === "wrong" ? "重新拼写（回车）" : activeFeedback === "correct" ? activeIndex === quizQuestions.length - 1 ? "提交本组（回车）" : "下一题（回车）" : "确认（回车）"}
          </button>
        ) : <button className="primary-button" disabled={submitting || !quizQuestions.length} onClick={() => void submit()}>{submitting ? "正在统一批改…" : `${error ? "重试" : ""}提交整组 ${quizQuestions.length} 题`}</button> : <button ref={nextButtonRef} className="primary-button" disabled={pendingCorrectionCount > 0} onClick={onNext} onKeyDown={(event) => handleSpellingEnter(event, () => { if (!pendingCorrectionCount) onNext(); })}>{pendingCorrectionCount > 0 ? `还需订正 ${pendingCorrectionCount} 个单词` : `${nextLabel} →`}</button>}
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

function WordLibrary({ items, learned, correctCounts, onCorrect, focusItemId }: { items: VocabularyItem[]; learned: number[]; correctCounts: Record<string, number>; onCorrect(itemId: string): void; focusItemId?: string }) {
  const focusItem = focusItemId ? items.find((item) => item.id === focusItemId) : undefined;
  const [query, setQuery] = useState(focusItem?.word ?? "");
  const matches = items.filter((item) => `${item.word} ${item.meaningsZh}`.toLowerCase().includes(query.trim().toLowerCase()));
  const firstMatches = matches.slice(0, 80);
  const filtered = focusItem && !firstMatches.some((item) => item.id === focusItem.id)
    ? [focusItem, ...firstMatches.slice(0, 79)]
    : firstMatches;
  const spelling = useSelfSpelling(filtered, onCorrect);

  return (
    <section className="library-page">
      <div className="section-intro"><span className="pill">固定题库 · 800 词</span><h2>自由查看单词资料</h2><p>查看资料不会改变每日学习顺序；自由拼写也不会计入错题或正式进度。</p></div>
      <input
        className="search-input"
        placeholder="搜索英文单词或中文释义"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          spelling.restore();
        }}
      />
      <div className="library-grid">
        {filtered.map((item) => {
          const active = spelling.activeId === item.id;
          return (
            <article className={`library-card ${active ? "spelling-active" : ""}`} key={item.id}>
              <div className="library-card-heading">
                <span className="library-index">{item.index}</span>
                <div className="library-card-main">
                  {active ? (
                    <input
                      className="library-spelling-input"
                      aria-label={`根据“${item.meaningsZh}”拼写英文单词`}
                      autoComplete="off"
                      readOnly={Boolean(spelling.result)}
                      placeholder="请输入英文拼写"
                      ref={spelling.inputRef}
                      spellCheck={false}
                      value={spelling.answer}
                      onChange={(event) => spelling.setAnswer(event.target.value)}
                      onKeyDown={(event) => handleSpellingEnter(event, () => spelling.advance(item))}
                    />
                  ) : <strong {...annotationProps("word", item.id, "word", `${item.word} · 单词`)}>{item.word}</strong>}
                  <small>{item.partOfSpeech} <span {...annotationProps("word", item.id, "meaning", `${item.word} · 中文释义`)}>{item.meaningsZh}</span></small>
                </div>
                <div className="library-card-actions">
                  <i>{learned.includes(item.index) ? "已学" : "未学"}</i>
                  <span className="spelling-count">拼对 {correctCounts[item.id] ?? 0} 次</span>
                  {!active && <button className="spelling-button" onClick={() => spelling.start(item.id)}>拼写</button>}
                </div>
              </div>
              {active ? (
                <SelfSpellingPanel item={item} spelling={spelling} />
              ) : (
                <details className="library-card-details">
                  <summary>查看发音、释义、记忆和例句</summary>
                  <p {...annotationProps("word", item.id, "pronunciation", `${item.word} · 发音`)}>{item.pronunciation}</p>
                  <p {...annotationProps("word", item.id, "definition", `${item.word} · 英文释义`)}><strong>英文释义：</strong>{item.definitionEn}</p>
                  {item.mnemonic && <p {...annotationProps("word", item.id, "mnemonic", `${item.word} · 记忆`)}><strong>记忆：</strong>{item.mnemonic}</p>}
                  <p className="example" {...annotationProps("word", item.id, "example", `${item.word} · 例句`)}><strong>例句：</strong>{item.example}</p>
                </details>
              )}
            </article>
          );
        })}
      </div>
      {filtered.length === 80 && <p className="muted center">为保证手机流畅，搜索结果每次最多显示 80 条。</p>}
    </section>
  );
}

function PhraseLibrary({ items, learned, correctCounts, onCorrect, exerciseNextIndex, totalExercises, focusItemId, onStartComprehensive }: { items: PhraseItem[]; learned: number[]; correctCounts: Record<string, number>; onCorrect(itemId: string): void; exerciseNextIndex: number; totalExercises: number; focusItemId?: string; onStartComprehensive(): void }) {
  const focusItem = focusItemId ? items.find((item) => item.id === focusItemId) : undefined;
  const [query, setQuery] = useState(focusItem?.phrase ?? "");
  const matches = items.filter((item) => `${item.phrase} ${item.meaningZh} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase()));
  const filtered = focusItem && !matches.some((item) => item.id === focusItem.id) ? [focusItem, ...matches] : matches;
  const spelling = useSelfSpelling(filtered, onCorrect);
  const unlocked = learned.length >= items.length;
  const completedExercises = Math.min(totalExercises, Math.max(0, exerciseNextIndex - 1));
  const complete = completedExercises >= totalExercises;
  const progressValue = unlocked ? completedExercises : learned.length;
  const progressTotal = unlocked ? totalExercises : items.length;
  return (
    <section className="library-page">
      <div className="section-intro"><span className="pill">独立题库 · 100 组</span><h2>自由查看词组资料</h2><p>词组始终与单词分开记录，即使搭配中包含同一个英文单词。</p></div>
      <section className={`panel comprehensive-panel ${unlocked ? "" : "locked"}`}>
        <div className="comprehensive-copy"><span className="eyebrow">原资料 Part 3 · 100 题</span><h3>综合填词练习</h3><p>{unlocked ? "每日词组学习已全部完成。现在可以按原题顺序练习补全缺失字母，每次 10 题，进度单独保存。" : "完成全部 100 个词组的每日学习后解锁。它不再属于每日词组流程，也不会影响每日完成状态。"}</p></div>
        <div className="comprehensive-status"><strong>{progressValue}<small> / {progressTotal}</small></strong><span>{unlocked ? complete ? "全部完成" : "综合题进度" : "词组解锁进度"}</span><div className="bar"><i style={{ width: `${Math.round((progressValue / progressTotal) * 100)}%` }} /></div><button className="secondary-button" disabled={!unlocked || complete} onClick={onStartComprehensive}>{complete ? "已完成 100 题" : unlocked ? "继续综合填词" : "完成词组后解锁"}</button></div>
      </section>
      <input className="search-input" placeholder="搜索词组或中文释义" value={query} onChange={(event) => { setQuery(event.target.value); spelling.restore(); }} />
      <div className="phrase-library">
        {filtered.map((item) => <PhraseCard key={item.id} item={item} spelling={spelling} correctCount={correctCounts[item.id] ?? 0} status={learned.includes(item.index) ? "已学" : item.category} />)}
      </div>
    </section>
  );
}

function ErrorBook({ reviews, wordById, phraseById, exerciseById }: { reviews: ReviewItem[]; wordById: Map<string, VocabularyItem>; phraseById: Map<string, PhraseItem>; exerciseById: Map<string, ExerciseItem> }) {
  const groups: Array<[string, QuizKind[]]> = [
    ["拼写错误的单词", ["word_spelling"]],
    ["拼写或搭配错误的词组", ["phrase_spelling"]],
    ["单词例句中的错题", ["word_cloze"]],
    ["综合填词练习中的错题", ["phrase_exercise"]],
  ];
  const nameOf = (review: ReviewItem) => wordById.get(review.itemId)?.word ?? phraseById.get(review.itemId)?.phrase ?? exerciseById.get(review.itemId)?.sourceSentence ?? review.itemId;
  return <section className="error-page"><div className="section-intro"><span className="pill">四类分开记录</span><h2>错题本</h2><p>错误次数永久累计；连续三次复习正确后暂时停止检查，再次答错会重新加入。</p></div><div className="error-groups">{groups.map(([title, kinds]) => { const items = reviews.filter((item) => kinds.includes(item.kind)); return <section className="panel" key={title}><div className="panel-heading"><h3>{title}</h3><span className="quiet">{items.length} 项</span></div>{items.length ? <div className="error-list">{items.map((item) => <article key={item.key}><div><strong>{nameOf(item)}</strong><small>累计错误 {item.errorCount} 次</small></div><span className={`status-chip ${item.status}`}>{item.status === "due" ? "今日复习" : item.status === "mastered" ? "暂时掌握" : "已安排复习"}</span></article>)}</div> : <p className="empty-state">这一类还没有错误记录。</p>}</section>; })}</div></section>;
}

function ProgressPage({ state, totalWords, totalPhrases, totalExercises }: { state: StudyState; totalWords: number; totalPhrases: number; totalExercises: number }) {
  const wordPercent = Math.round((state.progress.learnedVocabulary.length / totalWords) * 100);
  const phrasePercent = Math.round((state.progress.learnedPhrases.length / totalPhrases) * 100);
  const comprehensiveUnlocked = state.progress.learnedPhrases.length >= totalPhrases;
  const comprehensiveCompleted = Math.min(totalExercises, Math.max(0, state.progress.comprehensiveExerciseNextIndex - 1));
  const activeErrors = state.progress.reviews.filter((item) => item.status !== "mastered").length;
  return <section className="progress-page"><div className="section-intro"><span className="pill">目标 · TOEFL {state.settings.goalScore}</span><h2>当前学习进度</h2><p>每日学习批次与综合填词分别统计；查看资料不计入进度。</p></div><div className="stats-grid"><article><span>已学单词</span><strong>{state.progress.learnedVocabulary.length}<small> / {totalWords}</small></strong><div className="bar"><i style={{ width: `${wordPercent}%` }} /></div><p>{wordPercent}%</p></article><article><span>已学词组</span><strong>{state.progress.learnedPhrases.length}<small> / {totalPhrases}</small></strong><div className="bar"><i style={{ width: `${phrasePercent}%` }} /></div><p>{phrasePercent}%</p></article><article><span>综合填词</span><strong>{comprehensiveCompleted}<small> / {totalExercises}</small></strong><div className="bar"><i style={{ width: `${Math.round((comprehensiveCompleted / totalExercises) * 100)}%` }} /></div><p>{comprehensiveUnlocked ? "独立保存进度" : "完成全部词组后解锁"}</p></article><article><span>仍在复习</span><strong>{activeErrors}<small> 项</small></strong><p>单词、词组和两类例句错误分别保留。</p></article></div><section className="panel rules-panel"><span className="eyebrow">进度规则</span><h3>每日学习与综合练习互不占用进度</h3><p>每日批次在词组拼写提交后完成并推进；原 Part 3 仅在学完 100 个词组后开放，每次完成 10 题后单独推进。</p></section></section>;
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
