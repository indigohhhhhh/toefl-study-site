import type { QuizKind, ReviewItem, StudyState } from "./study-types";
export { normalizedAnswer } from "./grading.js";

export function beijingDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function createInitialState(date = beijingDate()): StudyState {
  const now = new Date().toISOString();
  const reviewDate = date;
  const seededReviews: ReviewItem[] = [
    ["word-002", "word_spelling", "evovel"],
    ["word-005", "word_spelling", "servive"],
    ["word-009", "word_spelling", "exhibitat"],
    ["word-013", "word_spelling", "evironment"],
  ].map(([itemId, kind, lastWrongAnswer]) => ({
    key: `${kind}:${itemId}`,
    itemId,
    kind: kind as QuizKind,
    errorCount: 1,
    consecutiveCorrect: 0,
    nextReviewAt: reviewDate,
    status: "due",
    lastWrongAnswer,
  }));

  return {
    version: 1,
    initializedAt: now,
    updatedAt: now,
    settings: {
      vocabularyBatchSize: 15,
      phraseBatchSize: 10,
      temporaryVocabularySize: null,
      temporaryPhraseSize: null,
      goalScore: 105,
    },
    progress: {
      vocabularyNextIndex: 16,
      phraseNextIndex: 1,
      comprehensiveExerciseNextIndex: 1,
      learnedVocabulary: Array.from({ length: 15 }, (_, index) => index + 1),
      learnedPhrases: [],
      reviews: seededReviews,
      selfSpellingCorrect: {},
    },
    notebook: { notes: [] },
    daily: {
      date,
      submitted: false,
      continuousLearning: false,
      completed: {
        reviews: false,
        vocabularyLearn: false,
        vocabularySpelling: false,
        vocabularyCloze: false,
        phraseLearn: false,
        phraseSpelling: false,
      },
    },
  };
}

export function rollStateToToday(state: StudyState, date = beijingDate()): StudyState {
  const comprehensiveExerciseNextIndex = Number.isInteger(state.progress.comprehensiveExerciseNextIndex)
    && state.progress.comprehensiveExerciseNextIndex >= 1
    ? state.progress.comprehensiveExerciseNextIndex
    : 1;
  const selfSpellingCorrect = Object.fromEntries(
    Object.entries(state.progress.selfSpellingCorrect ?? {})
      .filter(([itemId, count]) => itemId && Number.isInteger(count) && count >= 0),
  );
  const notes = Array.isArray(state.notebook?.notes)
    ? state.notebook.notes.filter((note) => note && typeof note.id === "string" && typeof note.anchorId === "string")
    : [];
  const normalized: StudyState = {
    ...state,
    progress: { ...state.progress, comprehensiveExerciseNextIndex, selfSpellingCorrect },
    notebook: { notes },
    daily: { ...state.daily, continuousLearning: state.daily.continuousLearning === true },
  };
  if (normalized.daily.date === date) return normalized;
  const carryContinuousLearning = normalized.daily.continuousLearning;
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    settings: {
      ...normalized.settings,
      temporaryVocabularySize: carryContinuousLearning ? normalized.settings.temporaryVocabularySize : null,
      temporaryPhraseSize: carryContinuousLearning ? normalized.settings.temporaryPhraseSize : null,
    },
    progress: {
      ...normalized.progress,
      reviews: normalized.progress.reviews.map((item) =>
        item.status !== "mastered" && item.nextReviewAt <= date ? { ...item, status: "due" } : item,
      ),
    },
    daily: {
      date,
      submitted: false,
      continuousLearning: carryContinuousLearning,
      completed: {
        reviews: false,
        vocabularyLearn: carryContinuousLearning ? normalized.daily.completed.vocabularyLearn : false,
        vocabularySpelling: carryContinuousLearning ? normalized.daily.completed.vocabularySpelling : false,
        vocabularyCloze: carryContinuousLearning ? normalized.daily.completed.vocabularyCloze : false,
        phraseLearn: carryContinuousLearning ? normalized.daily.completed.phraseLearn : false,
        phraseSpelling: carryContinuousLearning ? normalized.daily.completed.phraseSpelling : false,
      },
    },
  };
}

export function dueReviews(state: StudyState): ReviewItem[] {
  return state.progress.reviews.filter(
    (item) => item.status === "due" || (item.status === "scheduled" && item.nextReviewAt <= state.daily.date),
  );
}
