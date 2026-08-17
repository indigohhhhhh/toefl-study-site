export function normalizedAnswer(value) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?:\s+\d+)+\s*$/, "")
    .trim()
    .toLocaleLowerCase("en-US");
}
