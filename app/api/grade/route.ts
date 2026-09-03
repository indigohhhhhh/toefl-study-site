import { getDb } from "@/db";
import { attempts } from "@/db/schema";
import exercisesJson from "@/data/phrase-exercises.json";
import phrasesJson from "@/data/phrases.json";
import vocabularyJson from "@/data/vocabulary.json";
import { requestUserId } from "@/lib/server-auth";
import { normalizedAnswer } from "@/lib/study-state";
import type { ExerciseItem, GradeResult, PhraseItem, QuizKind, VocabularyItem } from "@/lib/study-types";

const vocabulary = vocabularyJson as VocabularyItem[];
const phrases = phrasesJson as PhraseItem[];
const exercises = exercisesJson as ExerciseItem[];
const wordsById = new Map(vocabulary.map((item) => [item.id, item]));
const phrasesById = new Map(phrases.map((item) => [item.id, item]));
const exercisesById = new Map(exercises.map((item) => [item.id, item]));

type Submission = { sessionId?: string; items?: Array<{ id?: string; kind?: QuizKind; answer?: string }> };

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function gradeOne(id: string, kind: QuizKind, answer: string): GradeResult {
  if (kind === "word_spelling" || kind === "word_cloze") {
    const item = wordsById.get(id);
    if (!item) throw new Error(`UNKNOWN_ITEM:${id}`);
    const expected = kind === "word_cloze" ? item.exampleCloze.answer : item.word;
    const correct = normalizedAnswer(answer) === normalizedAnswer(expected);
    return {
      id,
      kind,
      correct,
      userAnswer: answer,
      expected,
      meaningZh: item.meaningsZh,
      partOfSpeech: item.partOfSpeech || "单词",
      commonUsage: item.notesZh || item.mnemonic,
      contextMeaning: item.example,
      explanation: kind === "word_cloze"
        ? `本句需要 ${expected}，需同时符合词义、拼写和句中的词形。`
        : `标准拼写是 ${item.word}；大小写不影响判定，但字母和词形必须完全正确。`,
    };
  }

  if (kind === "phrase_spelling") {
    const item = phrasesById.get(id);
    if (!item) throw new Error(`UNKNOWN_ITEM:${id}`);
    const expected = item.phrase;
    const correct = item.acceptedAnswers.some((candidate) => normalizedAnswer(answer) === normalizedAnswer(candidate));
    return {
      id,
      kind,
      correct,
      userAnswer: answer,
      expected,
      meaningZh: item.meaningZh,
      partOfSpeech: "固定搭配",
      commonUsage: item.phrase,
      contextMeaning: `${item.category}中的完整搭配。`,
      explanation: "词组必须写出完整搭配；单词顺序、介词和词形均按资料中的标准答案判断。",
    };
  }

  const item = exercisesById.get(id);
  if (!item) throw new Error(`UNKNOWN_ITEM:${id}`);
  const expected = item.answer;
  const correct = item.acceptedAnswers.some((candidate) => normalizedAnswer(answer) === normalizedAnswer(candidate));
  return {
    id,
    kind,
    correct,
    userAnswer: answer,
    expected,
    meaningZh: item.section,
    partOfSpeech: "例句填空",
    commonUsage: item.sourceAnswer,
    contextMeaning: item.sourceSentence,
    explanation: item.explanation || "请结合句子语法、逻辑和固定搭配填写完整英文答案。",
  };
}

export async function POST(request: Request) {
  try {
    const userId = await requestUserId(request);
    const payload = (await request.json()) as Submission;
    if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId || !Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > 50) {
      return jsonResponse({ error: "提交内容不完整" }, 400);
    }
    const results = payload.items.map((submitted) => {
      if (!submitted || typeof submitted.id !== "string" || !submitted.id || !["word_spelling", "word_cloze", "phrase_spelling", "phrase_exercise"].includes(submitted.kind ?? "") || typeof submitted.answer !== "string") {
        throw new Error("INVALID_ITEM");
      }
      return gradeOne(submitted.id, submitted.kind!, submitted.answer);
    });

    const now = new Date().toISOString();
    try {
      await getDb()
        .insert(attempts)
        .values(results.map((result) => ({
          id: crypto.randomUUID(),
          userId,
          sessionId: payload.sessionId!,
          module: result.kind,
          itemId: result.id,
          answer: result.userAnswer,
          expected: result.expected,
          correct: result.correct,
          createdAt: now,
        })))
        .onConflictDoNothing();
    } catch {
      // Local previews can grade without a migrated D1 database. Production saves attempts.
    }

    return jsonResponse({
      results,
      summary: { total: results.length, correct: results.filter((item) => item.correct).length },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REQUIRED") {
      return jsonResponse({ error: "请先登录", code: "AUTH_REQUIRED" }, 401);
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.message === "INVALID_ITEM")) {
      return jsonResponse({ error: "提交格式不正确" }, 400);
    }
    if (error instanceof Error && error.message.startsWith("UNKNOWN_ITEM")) {
      return jsonResponse({ error: "题目不存在或资料版本不一致" }, 400);
    }
    console.error("Grading request failed", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "评分服务暂时不可用，请稍后重试" }, 503);
  }
}
