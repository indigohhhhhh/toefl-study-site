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
  assert.match(html, /词组配套练习/);
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
});

test("strict normalizer ignores case, spacing, and trailing item numbers only", () => {
  assert.equal(normalizedAnswer("  CLIMATIC   16 "), "climatic");
  assert.equal(normalizedAnswer("  Adapt   to  4 "), "adapt to");
  assert.notEqual(normalizedAnswer("adapt in"), normalizedAnswer("Adapt to"));
  assert.notEqual(normalizedAnswer("servive"), normalizedAnswer("survive"));
});
