import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-tex64_session" : "tex64_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const CLOCK_SKEW_SECONDS = 5 * 60;
const USER_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export type SessionIdentity = {
  userId: string;
  isNew: boolean;
};

export async function requireSession(): Promise<SessionIdentity> {
  const cookieStore = await cookies();
  const current = verifySessionCookie(cookieStore.get(COOKIE_NAME)?.value);
  if (current) return { userId: current, isNew: false };

  const userId = randomUUID();
  cookieStore.set(COOKIE_NAME, createSessionCookie(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return { userId, isNew: true };
}

export function createSessionCookie(userId: string, issuedAt = Math.floor(Date.now() / 1_000)): string {
  if (!USER_ID_PATTERN.test(userId)) throw new Error("Invalid session user id.");
  const payload = `${userId}.${issuedAt}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionCookie(value: string | undefined, now = Math.floor(Date.now() / 1_000)): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId = "", issuedAtInput = "", signature = ""] = parts;
  const issuedAt = Number(issuedAtInput);
  if (
    !USER_ID_PATTERN.test(userId) ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > now + CLOCK_SKEW_SECONDS ||
    now - issuedAt > SESSION_MAX_AGE_SECONDS ||
    !/^[0-9a-f]{64}$/i.test(signature)
  ) return null;

  const expected = Buffer.from(sign(`${userId}.${issuedAtInput}`), "hex");
  const received = Buffer.from(signature, "hex");
  if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received)) return null;
  return userId;
}

function sign(userId: string): string {
  return createHmac("sha256", getSessionSecret()).update(userId).digest("hex");
}

function getSessionSecret(): string {
  const configured = process.env.TEX64_SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TEX64_SESSION_SECRET must be configured in production.");
  }
  return "tex64-local-development-session-secret-only";
}
