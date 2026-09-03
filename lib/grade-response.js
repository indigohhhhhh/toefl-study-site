/** @typedef {import("./study-types").GradeResult} GradeResult */

export class GradingResponseError extends Error {
  /** @param {string} message @param {boolean} [needsLogin] */
  constructor(message, needsLogin = false) {
    super(message);
    this.name = "GradingResponseError";
    this.needsLogin = needsLogin;
  }
}

/**
 * Never treat a login page, proxy error page, or incomplete response as a grade.
 * @param {Response} response
 * @param {Array<{ id: string; kind: string }>} submittedItems
 * @returns {Promise<GradeResult[]>}
 */
export async function readGradeResults(response, submittedItems) {
  if (response.status === 401) {
    throw new GradingResponseError("登录状态已失效。答案草稿已保留，请重新登录后提交。", true);
  }
  if (response.status === 403) {
    const rayId = response.headers.get("cf-ray");
    const reference = rayId && /^[a-z0-9-]{1,64}$/i.test(rayId) ? `（Cloudflare Ray ID：${rayId}）` : "";
    throw new GradingResponseError(`访问被网站安全防护拦截。答案草稿已保留，请勿连续提交；稍后仍无法访问时，请联系平台支持。${reference}`);
  }
  if (response.redirected || response.type === "opaqueredirect") {
    throw new GradingResponseError("评分请求被转到了其他页面。答案草稿已保留，请刷新并重新登录后重试。", true);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
    throw new GradingResponseError("评分服务暂时返回了异常页面。答案草稿已保留，请稍后重试提交。");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GradingResponseError("评分结果没有完整接收。答案草稿已保留，请重试提交。");
  }
  if (!response.ok) {
    const message = response.status === 400 && typeof payload?.error === "string"
      ? payload.error
      : "评分服务暂时不可用，请稍后重试";
    throw new GradingResponseError(`${message}。答案草稿已保留。`);
  }

  const expectedKeys = new Set(submittedItems.map((item) => `${item.kind}:${item.id}`));
  const results = payload?.results;
  const returnedKeys = new Set();
  const textFields = ["id", "kind", "userAnswer", "expected", "meaningZh", "partOfSpeech", "commonUsage", "contextMeaning", "explanation"];
  const valid = Array.isArray(results)
    && results.length === submittedItems.length
    && results.every((result) => {
      if (!result || typeof result.correct !== "boolean" || !textFields.every((field) => typeof result[field] === "string")) return false;
      const key = `${result.kind}:${result.id}`;
      if (!expectedKeys.has(key) || returnedKeys.has(key)) return false;
      returnedKeys.add(key);
      return true;
    });
  if (!valid) {
    throw new GradingResponseError("收到的评分结果与本组题目不一致。答案草稿已保留，请重试提交。");
  }
  return results;
}
