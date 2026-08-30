import { configurePassword, issueSessionCookie, passwordIsConfigured, verifySetupToken } from "@/lib/password-auth";

export async function POST(request: Request) {
  try {
    if (await passwordIsConfigured()) {
      return Response.json({ error: "网站密码已经设置，请直接登录", code: "PASSWORD_ALREADY_CONFIGURED" }, { status: 409 });
    }
    const payload = await request.json() as { setupCode?: string; password?: string };
    if (typeof payload.setupCode !== "string" || !(await verifySetupToken(payload.setupCode))) {
      return Response.json({ error: "一次性设置码不正确" }, { status: 401 });
    }
    if (typeof payload.password !== "string" || payload.password.length < 8 || payload.password.length > 128) {
      return Response.json({ error: "密码长度需要为8至128位" }, { status: 400 });
    }
    const result = await configurePassword(payload.password);
    if (result === "already_configured") {
      return Response.json({ error: "网站密码已经设置，请直接登录", code: "PASSWORD_ALREADY_CONFIGURED" }, { status: 409 });
    }
    await issueSessionCookie();
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Password setup failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "暂时无法保存密码，请稍后重试" }, { status: 503 });
  }
}
