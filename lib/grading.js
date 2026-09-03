export function normalizedAnswer(value) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?:\s+\d+)+\s*$/, "")
    .trim()
    .toLocaleLowerCase("en-US");
}

/** @param {string} answer @param {string[]} expectedAnswers */
export function matchesSelfSpelling(answer, expectedAnswers) {
  return Boolean(answer.trim()) && expectedAnswers.some((expected) => normalizedAnswer(answer) === normalizedAnswer(expected));
}
