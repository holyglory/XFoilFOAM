import crypto from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

const SECRET = process.env.ADMIN_SESSION_SECRET || "aero-dev-insecure-secret-change-me";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@aerodb.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

export const COOKIE_NAME = "aero_admin";
export type AuthMode = "dev" | "prod";

/** dev = no auth (default off-prod); prod = email/password required.
 *  Overridable with ADMIN_AUTH_DISABLED / ADMIN_AUTH_REQUIRED for testing. */
export function authMode(): AuthMode {
  if (process.env.ADMIN_AUTH_DISABLED === "true") return "dev";
  if (process.env.ADMIN_AUTH_REQUIRED === "true") return "prod";
  return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function checkCredentials(email: string, password: string): boolean {
  if (authMode() === "dev") return true;
  if (!ADMIN_PASSWORD) return false; // prod misconfigured — refuse rather than allow
  return safeEqual(email.trim().toLowerCase(), ADMIN_EMAIL.trim().toLowerCase()) && safeEqual(password, ADMIN_PASSWORD);
}

export function signSession(email: string, ttlMs = 86_400_000): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + ttlMs })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token?: string): { email: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { email: string; exp: number };
    if (!p.exp || p.exp < Date.now()) return null;
    return { email: p.email };
  } catch {
    return null;
  }
}

function cookieOf(req: FastifyRequest): string | undefined {
  return (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[COOKIE_NAME];
}

/** Fastify preHandler: allow in dev, require a valid session cookie in prod. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (authMode() === "dev") return;
  if (verifySession(cookieOf(req))) return;
  await reply.code(401).send({ error: "admin authentication required" });
}

export function sessionEmail(req: FastifyRequest): string | null {
  return verifySession(cookieOf(req))?.email ?? null;
}
