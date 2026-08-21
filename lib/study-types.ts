export type QuizKind = "word_spelling" | "word_cloze" | "phrase_spelling" | "phrase_exercise";

export type VocabularyItem = {
  id: string;
  index: number;
  word: string;
  pronunciation: string;
  partOfSpeech: string;
  meaningsZh: string;
  definitionEn: string;
  notesZh: string;
  mnemonic: string;
  example: string;
  exampleCloze: { prompt: string; answer: string; prefixLength: number };
  acceptedAnswers: string[];
};

export type PhraseItem = {
  id: string;
  index: number;
  phrase: string;
  meaningZh: string;
  category: string;
  acceptedAnswers: string[];
};

export type ExerciseItem = {
  id: string;
  index: number;
  sourceSentence: string;
  prompt: string;
  answer: string;
  acceptedAnswers: string[];
  sourceAnswer: string;
  explanation: string;
  section: string;
};

export type ReviewItem = {
  key: string;
  kind: QuizKind;
  itemId: string;
  errorCount: number;
  consecutiveCorrect: number;
  nextReviewAt: string;
  status: "due" | "scheduled" | "mastered";
  lastWrongAnswer?: string;
};

export type StudyNote = {
  id: string;
  anchorId: string;
  sourceKind: "word" | "phrase";
  itemId: string;
  field: string;
  label: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  prefix: string;
  suffix: string;
  body: string;
  createdAt: string;
};

export type StudyState = {
  version: 1;
  initializedAt: string;
  updatedAt: string;
  settings: {
    vocabularyBatchSize: number;
    phraseBatchSize: number;
    temporaryVocabularySize: number | null;
    temporaryPhraseSize: number | null;
    goalScore: number;
  };
  progress: {
    vocabularyNextIndex: number;
    phraseNextIndex: number;
    comprehensiveExerciseNextIndex: number;
    learnedVocabulary: number[];
    learnedPhrases: number[];
    reviews: ReviewItem[];
    selfSpellingCorrect: Record<string, number>;
  };
  notebook: {
    notes: StudyNote[];
  };
  daily: {
    date: string;
    submitted: boolean;
    continuousLearning: boolean;
    completed: {
      reviews: boolean;
      vocabularyLearn: boolean;
      vocabularySpelling: boolean;
      vocabularyCloze: boolean;
      phraseLearn: boolean;
      phraseSpelling: boolean;
    };
  };
};

export type GradeResult = {
  id: string;
  kind: QuizKind;
  correct: boolean;
  userAnswer: string;
  expected: string;
  meaningZh: string;
  partOfSpeech: string;
  commonUsage: string;
  contextMeaning: string;
  explanation: string;
};
