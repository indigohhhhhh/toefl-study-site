import {
  clearFailedLogins,
  issueSessionCookie,
  loginIsBlocked,
  passwordIsConfigured,
  recordFailedLogin,
  verifyPassword,
} from "@/lib/password-auth";

export async function POST(request: Request) {
  try {
    if (!(await passwordIsConfigured())) {
      return Response.json({ error: "请先创建网站密码", code: "PASSWORD_NOT_CONFIGURED" }, { status: 409 });
    }
    const blockedFor = await loginIsBlocked(request);
    if (blockedFor) {
      return Response.json({ error: `错误次数过多，请在 ${Math.ceil(blockedFor / 60)} 分钟后重试` }, { status: 429, headers: { "retry-after": String(blockedFor) } });
    }
    const payload = await request.json() as { password?: string };
    if (typeof payload.password !== "string" || !(await verifyPassword(payload.password))) {
      await recordFailedLogin(request);
      return Response.json({ error: "密码不正确" }, { status: 401 });
    }
    await clearFailedLogins(request);
    await issueSessionCookie();
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Password login failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "登录服务暂时不可用" }, { status: 503 });
  }
}
