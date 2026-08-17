import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizedAnswer } from "../lib/grading.js";

let workerPromise;

async function worker() {
  if (workerPromise) return workerPromise;
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  workerPromise = import(workerUrl.href).then((module) => module.default);
  return workerPromise;
}

function environment() {
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
}

function context() {
  return { waitUntil() {}, passThroughOnException() {} };
}

test("server-renders the real TOEFL learning dashboard", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), environment(), context());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>词航 · 托福词汇学习<\/title>/);
  assert.match(html, /先复习 4 个到期错词\/错题/);
  assert.match(html, /学习第|学习新单词/);
  assert.match(html, /词组无提示拼写/);
  assert.doesNotMatch(html, /词组配套练习/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("contains the complete fixed question banks", async () => {
  const [vocabulary, phrases, exercises] = await Promise.all([
    readFile(new URL("../data/vocabulary.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/phrases.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/phrase-exercises.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.equal(vocabulary.length, 800);
  assert.equal(phrases.length, 100);
  assert.equal(exercises.length, 100);
  assert.deepEqual([vocabulary[0].word, vocabulary[15].word, vocabulary[799].word], ["evolve", "climatic", "popularity"]);
  assert.deepEqual([phrases[0].phrase, phrases[99].phrase], ["Adapt to", "Take into account"]);
  assert.ok(exercises.every((item) => Array.isArray(item.acceptedAnswers) && item.acceptedAnswers.length));
  assert.deepEqual([exercises[0].prompt, exercises[0].answer], ["The survival of certain polar species depends heav  [3] on stable ice conditions.", "heavily"]);
});

test("decouples original Part 3 from the six-step daily phrase flow", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");
  assert.match(source, /completion === "phraseSpelling"/);
  assert.doesNotMatch(source, /completion === "phraseExercise"/);
  assert.match(source, /learnedPhrases\.length >= phrases\.length/);
  assert.match(source, /comprehensiveExerciseNextIndex/);
  assert.match(source, /原资料 Part 3/);
});

test("allows continuous learning without assigning future-day credits", async () => {
  const [source, types, state] = await Promise.all([
    readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/study-types.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/study-state.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /startContinuousLearning/);
  assert.match(source, /继续学习/);
  assert.match(source, /completion === "vocabularyCloze" && activePhrases\.length === 0/);
  assert.doesNotMatch(source, /已提前|预计明日复习量/);
  assert.match(types, /continuousLearning: boolean/);
  assert.match(state, /continuousLearning: false/);
});

test("strict normalizer ignores case, spacing, and trailing item numbers only", () => {
  assert.equal(normalizedAnswer("  CLIMATIC   16 "), "climatic");
  assert.equal(normalizedAnswer("  Adapt   to  4 "), "adapt to");
  assert.notEqual(normalizedAnswer("adapt in"), normalizedAnswer("Adapt to"));
  assert.notEqual(normalizedAnswer("servive"), normalizedAnswer("survive"));
});

test("word spelling correction uses the same strict comparison", () => {
  assert.equal(normalizedAnswer(" Erosion 25 "), normalizedAnswer("erosion"));
  assert.notEqual(normalizedAnswer("errosion"), normalizedAnswer("erosion"));
});

test("service worker refreshes deployed assets before using its offline cache", async () => {
  const [serviceWorker, source] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(serviceWorker, /toefl-study-shell-v5/);
  assert.match(serviceWorker, /fetch\(request\)[\s\S]*catch\(\(\) => caches\.match\(request\)\)/);
  assert.match(source, /updateViaCache: "none"/);
  assert.match(source, /controllerchange/);
});

test("repairs a fully completed legacy batch that was never finalized", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");
  assert.match(source, /wordTasksDone/);
  assert.match(source, /phraseTasksDone/);
  assert.match(source, /if \(current\.daily\.submitted\) return current/);
  assert.match(source, /daily: \{ \.\.\.current\.daily, submitted: true, continuousLearning: false \}/);
});
