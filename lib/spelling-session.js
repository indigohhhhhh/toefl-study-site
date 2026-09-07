import { matchesSelfSpelling } from "./grading.js";

/** @typedef {{ id: string, kind: string, acceptedAnswers?: string[] }} SpellingQuestion */
/** @typedef {{ answer: string, firstAnswer?: string, feedback: "correct" | "wrong" | null }} SpellingEntry */
/** @typedef {{ index: number, entries: Record<string, SpellingEntry> }} SpellingSession */

/** @param {"correct" | "wrong" | null} feedback @param {string} answer */
export function spellingAction(feedback, answer) {
  if (feedback === "correct") return "next";
  if (feedback === "wrong") return "retry";
  return answer.trim() ? "confirm" : "none";
}

/** Ignore held keys and IME confirmation; never hijack another input's Enter. */
export function handleSpellingEnter(event, action) {
  if (event.key !== "Enter" || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  if (!event.repeat) action();
}

/** @param {SpellingQuestion} question */
export function spellingKey(question) {
  return `${question.kind}:${question.id}`;
}

/** Temporary device draft only. Official scores still come from the grading API. */
/** @param {SpellingQuestion[]} questions @param {unknown} saved @param {Record<string, string>} legacyAnswers @returns {SpellingSession} */
export function restoreSpellingSession(questions, saved, legacyAnswers = {}) {
  const source = saved && typeof saved === "object" ? saved : {};
  const entries = {};
  for (const question of questions) {
    const key = spellingKey(question);
    const raw = source.entries?.[key];
    const answer = typeof raw?.answer === "string" ? raw.answer : typeof legacyAnswers[key] === "string" ? legacyAnswers[key] : "";
    const firstAnswer = typeof raw?.firstAnswer === "string" && raw.firstAnswer.trim() ? raw.firstAnswer : undefined;
    const checked = firstAnswer !== undefined && (raw?.feedback === "correct" || raw?.feedback === "wrong");
    entries[key] = {
      answer,
      ...(firstAnswer !== undefined ? { firstAnswer } : {}),
      feedback: checked ? matchesSelfSpelling(answer, question.acceptedAnswers ?? []) ? "correct" : "wrong" : null,
    };
  }
  const requestedIndex = Number.isInteger(source.index) ? Math.max(0, Math.min(source.index, questions.length)) : 0;
  let index = 0;
  while (index < requestedIndex && entries[spellingKey(questions[index])].feedback === "correct") index++;
  return { index, entries };
}

/** @param {SpellingSession} session @param {SpellingQuestion[]} questions @param {string} answer @returns {SpellingSession} */
export function editSpellingAnswer(session, questions, answer) {
  const question = questions[session.index];
  if (!question) return session;
  const key = spellingKey(question);
  const entry = session.entries[key] ?? { answer: "", feedback: null };
  if (entry.feedback) return session;
  return { ...session, entries: { ...session.entries, [key]: { ...entry, answer } } };
}

/** One deliberate activation: confirm, retry, or advance. Never overwrite the first attempt. */
/** @param {SpellingSession} session @param {SpellingQuestion[]} questions @returns {SpellingSession} */
export function advanceSpellingSession(session, questions) {
  const question = questions[session.index];
  if (!question) return session;
  const key = spellingKey(question);
  const entry = session.entries[key] ?? { answer: "", feedback: null };
  switch (spellingAction(entry.feedback, entry.answer)) {
    case "confirm": {
      const correct = matchesSelfSpelling(entry.answer, question.acceptedAnswers ?? []);
      return { ...session, entries: { ...session.entries, [key]: {
        ...entry, firstAnswer: entry.firstAnswer ?? entry.answer, feedback: correct ? "correct" : "wrong",
      } } };
    }
    case "retry":
      return { ...session, entries: { ...session.entries, [key]: { ...entry, answer: "", feedback: null } } };
    case "next":
      return { ...session, index: session.index + 1 };
    default:
      return session;
  }
}

/** @param {SpellingSession} session @param {SpellingQuestion[]} questions @returns {Record<string, string>} */
export function firstSpellingAnswers(session, questions) {
  return Object.fromEntries(questions.map((question) => {
    const key = spellingKey(question);
    return [key, session.entries[key]?.firstAnswer ?? ""];
  }));
}
