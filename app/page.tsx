import StudyApp from "./StudyApp";
import vocabularyJson from "@/data/vocabulary.json";
import phrasesJson from "@/data/phrases.json";
import exercisesJson from "@/data/phrase-exercises.json";
import { getChatGPTUser } from "./chatgpt-auth";
import { createInitialState } from "@/lib/study-state";
import type { ExerciseItem, PhraseItem, VocabularyItem } from "@/lib/study-types";

export default async function Home() {
  const user = await getChatGPTUser();
  return (
    <StudyApp
      vocabulary={vocabularyJson as VocabularyItem[]}
      phrases={phrasesJson as PhraseItem[]}
      exercises={exercisesJson as ExerciseItem[]}
      initialState={createInitialState()}
      displayName={user?.fullName ?? user?.email ?? "AS"}
    />
  );
}
