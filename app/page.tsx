import StudyApp from "./StudyApp";
import PasswordGate from "./PasswordGate";
import vocabularyJson from "@/data/vocabulary.json";
import phrasesJson from "@/data/phrases.json";
import exercisesJson from "@/data/phrase-exercises.json";
import { createInitialState } from "@/lib/study-state";
import { currentPasswordSession, passwordIsConfigured } from "@/lib/password-auth";
import type { ExerciseItem, PhraseItem, VocabularyItem } from "@/lib/study-types";

export default async function Home() {
  let authenticated = false;
  let authAvailable = true;
  try {
    authenticated = await currentPasswordSession();
  } catch {
    authAvailable = false;
  }
  if (!authAvailable) return <PasswordGate initialMode="unavailable" />;
  if (!authenticated) {
    let initialMode: "login" | "setup" | "unavailable" = "unavailable";
    try {
      initialMode = (await passwordIsConfigured()) ? "login" : "setup";
    } catch {
      initialMode = "unavailable";
    }
    return <PasswordGate initialMode={initialMode} />;
  }
  return (
    <StudyApp
      vocabulary={vocabularyJson as VocabularyItem[]}
      phrases={phrasesJson as PhraseItem[]}
      exercises={exercisesJson as ExerciseItem[]}
      initialState={createInitialState()}
      displayName="我"
    />
  );
}
