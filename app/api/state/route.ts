import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userStates } from "@/db/schema";
import { requestUserId } from "@/lib/server-auth";
import type { StudyState } from "@/lib/study-types";

function authError(error: unknown) {
  return error instanceof Error && error.message === "AUTH_REQUIRED";
}

export async function GET(request: Request) {
  try {
    const userId = requestUserId(request);
    const [row] = await getDb().select().from(userStates).where(eq(userStates.userId, userId)).limit(1);
    return Response.json({ state: row ? JSON.parse(row.stateJson) : null, storage: "cloud" });
  } catch (error) {
    if (authError(error)) return Response.json({ error: "请先登录" }, { status: 401 });
    return Response.json({ state: null, storage: "browser" });
  }
}

export async function PUT(request: Request) {
  try {
    const userId = requestUserId(request);
    const raw = await request.text();
    if (raw.length > 2_000_000) return Response.json({ error: "备份记录过大" }, { status: 413 });
    const payload = JSON.parse(raw) as { state?: StudyState };
    if (!payload.state || payload.state.version !== 1) {
      return Response.json({ error: "不支持的学习记录格式" }, { status: 400 });
    }
    const now = new Date().toISOString();
    const state = { ...payload.state, updatedAt: now };
    await getDb()
      .insert(userStates)
      .values({ userId, stateJson: JSON.stringify(state), version: 1, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: userStates.userId,
        set: { stateJson: JSON.stringify(state), version: 1, updatedAt: now },
      });
    return Response.json({ state, storage: "cloud" });
  } catch (error) {
    if (authError(error)) return Response.json({ error: "请先登录" }, { status: 401 });
    return Response.json({ error: "云端暂时不可用，草稿仍保存在本机", storage: "browser" }, { status: 503 });
  }
}
