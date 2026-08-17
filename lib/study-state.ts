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
      learnedVocabulary: Array.from({ length: 15 }, (_, index) => index + 1),
      learnedPhrases: [],
      reviews: seededReviews,
    },
    daily: {
      date,
      submitted: false,
      completed: {
        reviews: false,
        vocabularyLearn: false,
        vocabularySpelling: false,
        vocabularyCloze: false,
        phraseLearn: false,
        phraseSpelling: false,
        phraseExercise: false,
      },
    },
  };
}

export function rollStateToToday(state: StudyState, date = beijingDate()): StudyState {
  if (state.daily.date === date) return state;
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    settings: {
      ...state.settings,
      temporaryVocabularySize: null,
      temporaryPhraseSize: null,
    },
    progress: {
      ...state.progress,
      reviews: state.progress.reviews.map((item) =>
        item.status !== "mastered" && item.nextReviewAt <= date ? { ...item, status: "due" } : item,
      ),
    },
    daily: {
      date,
      submitted: false,
      completed: {
        reviews: false,
        vocabularyLearn: false,
        vocabularySpelling: false,
        vocabularyCloze: false,
        phraseLearn: false,
        phraseSpelling: false,
        phraseExercise: false,
      },
    },
  };
}

export function dueReviews(state: StudyState): ReviewItem[] {
  return state.progress.reviews.filter(
    (item) => item.status === "due" || (item.status === "scheduled" && item.nextReviewAt <= state.daily.date),
  );
}
