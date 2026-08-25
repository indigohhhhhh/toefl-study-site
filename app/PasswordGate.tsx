"use client";

import { FormEvent, useState } from "react";

type Mode = "login" | "setup" | "unavailable";

export default function PasswordGate({ initialMode }: { initialMode: Mode }) {
  const [mode, setMode] = useState(initialMode);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (mode === "setup" && password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(mode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "setup" ? { setupCode, password } : { password }),
      });
      const result = await response.json() as { error?: string; code?: string };
      if (response.ok) {
        window.location.replace("/");
        return;
      }
      if (result.code === "PASSWORD_NOT_CONFIGURED") setMode("setup");
      else if (result.code === "PASSWORD_ALREADY_CONFIGURED") setMode("login");
      setError(result.error ?? "暂时无法登录，请稍后再试");
    } catch {
      setError("网络暂时不可用，请检查连接后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand"><span>T</span><div><strong>词航</strong><small>TOEFL STUDY</small></div></div>
        {mode === "unavailable" ? (
          <>
            <span className="auth-kicker">暂时无法连接</span>
            <h1 id="auth-title">学习记录服务暂时不可用</h1>
            <p>请稍后刷新页面。你的浏览器草稿不会因为这个页面而被删除。</p>
            <button className="primary-button auth-submit" type="button" onClick={() => window.location.reload()}>重新尝试</button>
          </>
        ) : (
          <>
            <span className="auth-kicker">{mode === "setup" ? "首次设置" : "私人学习空间"}</span>
            <h1 id="auth-title">{mode === "setup" ? "创建你的网站密码" : "欢迎回来"}</h1>
            <p>{mode === "setup" ? "输入一次性设置码，再创建以后登录使用的密码。永久密码只会在这里提交给服务器。" : "输入网站密码，继续今天的托福学习任务。"}</p>
            <form className="auth-form" onSubmit={submit}>
              {mode === "setup" && (
                <label><span>一次性设置码</span><input autoComplete="one-time-code" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} required /></label>
              )}
              <label><span>{mode === "setup" ? "创建密码" : "网站密码"}</span><input type="password" autoComplete={mode === "setup" ? "new-password" : "current-password"} minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
              {mode === "setup" && (
                <label><span>再次输入密码</span><input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /><small>至少8位；建议使用只有你知道的长密码。</small></label>
              )}
              {error && <div className="form-error" role="alert">{error}</div>}
              <button className="primary-button auth-submit" disabled={busy}>{busy ? "正在处理…" : mode === "setup" ? "保存密码并进入" : "登录"}</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
