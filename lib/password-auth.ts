import { env } from "cloudflare:workers";
import { cookies, headers } from "next/headers";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { authLoginAttempts, siteAuth, userStates } from "@/db/schema";

export const SESSION_COOKIE_NAME = "toefl_session";
export const SINGLE_USER_ID = "password-owner";
export const SITE_AUTH_ID = "primary";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 180_000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

type RuntimeSecrets = {
  SITE_SESSION_SECRET?: string;
  SITE_SETUP_TOKEN?: string;
};

function runtimeSecrets(): RuntimeSecrets {
  return env as unknown as RuntimeSecrets;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function passwordIsConfigured(): Promise<boolean> {
  const [row] = await getDb().select({ id: siteAuth.id }).from(siteAuth).where(eq(siteAuth.id, SITE_AUTH_ID)).limit(1);
  return Boolean(row);
}

export async function verifySetupToken(candidate: string): Promise<boolean> {
  const expected = runtimeSecrets().SITE_SETUP_TOKEN;
  if (!expected || !candidate) return false;
  const [candidateHash, expectedHash] = await Promise.all([sha256(candidate), sha256(expected)]);
  return equalBytes(candidateHash, expectedHash);
}

export async function configurePassword(password: string): Promise<"created" | "already_configured"> {
  const db = getDb();
  if (await passwordIsConfigured()) return "already_configured";

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  const now = new Date().toISOString();
  await db.insert(siteAuth).values({
    id: SITE_AUTH_ID,
    passwordHash: bytesToBase64Url(hash),
    passwordSalt: bytesToBase64Url(salt),
    passwordIterations: PASSWORD_ITERATIONS,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  const [configured] = await db.select({ id: siteAuth.id }).from(siteAuth).where(eq(siteAuth.id, SITE_AUTH_ID)).limit(1);
  if (!configured) throw new Error("PASSWORD_SETUP_FAILED");

  const [ownerState] = await db.select({ userId: userStates.userId }).from(userStates).where(eq(userStates.userId, SINGLE_USER_ID)).limit(1);
  if (!ownerState) {
    const [latest] = await db.select().from(userStates).orderBy(desc(userStates.updatedAt)).limit(1);
    if (latest) {
      await db.insert(userStates).values({ ...latest, userId: SINGLE_USER_ID }).onConflictDoNothing();
    }
  }
  return "created";
}

export async function verifyPassword(password: string): Promise<boolean> {
  const [row] = await getDb().select().from(siteAuth).where(eq(siteAuth.id, SITE_AUTH_ID)).limit(1);
  if (!row) return false;
  const salt = base64UrlToBytes(row.passwordSalt);
  const expected = base64UrlToBytes(row.passwordHash);
  if (!salt || !expected) return false;
  const actual = await derivePassword(password, salt, row.passwordIterations);
  return equalBytes(actual, expected);
}

export async function issueSessionCookie(): Promise<void> {
  const secret = runtimeSecrets().SITE_SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET_MISSING");
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    sub: SINGLE_USER_ID,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  })));
  const signature = bytesToBase64Url(await hmac(payload, secret));
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, `${payload}.${signature}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export async function verifySessionValue(value: string | undefined): Promise<boolean> {
  const secret = runtimeSecrets().SITE_SESSION_SECRET;
  if (!secret || !value) return false;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return false;
  const actualSignature = base64UrlToBytes(signature);
  if (!actualSignature || !equalBytes(actualSignature, await hmac(payload, secret))) return false;
  const payloadBytes = base64UrlToBytes(payload);
  if (!payloadBytes) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as { sub?: string; exp?: number };
    return parsed.sub === SINGLE_USER_ID && typeof parsed.exp === "number" && parsed.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export async function currentPasswordSession(): Promise<boolean> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host")?.split(":")[0];
  if ((host === "localhost" || host === "127.0.0.1") && !runtimeSecrets().SITE_SESSION_SECRET) return true;
  const cookieStore = await cookies();
  return verifySessionValue(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export async function requestPasswordUserId(request: Request): Promise<string> {
  const host = new URL(request.url).hostname;
  if ((host === "localhost" || host === "127.0.0.1") && !runtimeSecrets().SITE_SESSION_SECRET) return "local-preview";
  const cookieHeader = request.headers.get("cookie") ?? "";
  const value = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))?.slice(SESSION_COOKIE_NAME.length + 1);
  if (await verifySessionValue(value)) return SINGLE_USER_ID;
  throw new Error("AUTH_REQUIRED");
}

async function requestFingerprint(request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  return bytesToBase64Url(await sha256(`${ip}\n${userAgent}`));
}

export async function loginIsBlocked(request: Request): Promise<number | null> {
  const fingerprint = await requestFingerprint(request);
  const [row] = await getDb().select().from(authLoginAttempts).where(eq(authLoginAttempts.fingerprint, fingerprint)).limit(1);
  if (!row?.blockedUntil) return null;
  const remaining = new Date(row.blockedUntil).getTime() - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : null;
}

export async function recordFailedLogin(request: Request): Promise<void> {
  const db = getDb();
  const fingerprint = await requestFingerprint(request);
  const [row] = await db.select().from(authLoginAttempts).where(eq(authLoginAttempts.fingerprint, fingerprint)).limit(1);
  const nowMs = Date.now();
  const withinWindow = row && nowMs - new Date(row.firstFailedAt).getTime() < RATE_WINDOW_MS;
  const failedCount = withinWindow ? row.failedCount + 1 : 1;
  const now = new Date(nowMs).toISOString();
  const blockedUntil = failedCount >= MAX_FAILED_ATTEMPTS ? new Date(nowMs + RATE_WINDOW_MS).toISOString() : null;
  await db.insert(authLoginAttempts).values({
    fingerprint,
    failedCount,
    firstFailedAt: withinWindow ? row.firstFailedAt : now,
    blockedUntil,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: authLoginAttempts.fingerprint,
    set: { failedCount, firstFailedAt: withinWindow ? row.firstFailedAt : now, blockedUntil, updatedAt: now },
  });
}

export async function clearFailedLogins(request: Request): Promise<void> {
  const fingerprint = await requestFingerprint(request);
  await getDb().delete(authLoginAttempts).where(eq(authLoginAttempts.fingerprint, fingerprint));
}
