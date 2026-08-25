import { clearSessionCookie } from "@/lib/password-auth";

export async function POST() {
  await clearSessionCookie();
  return Response.json({ ok: true });
}
