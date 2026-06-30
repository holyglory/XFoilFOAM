import crypto from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

export const COOKIE_NAME = "aero_admin";
export const GOOGLE_STATE_COOKIE_NAME = "aero_admin_google_state";
export type AuthMode = "dev" | "prod";
export type AdminSession = { email: string; provider?: "password" | "google"; domain?: string };
export type AdminAuthProviders = {
  google: boolean;
  password: boolean;
};

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function sessionSecret(): string {
  return process.env.ADMIN_SESSION_SECRET || "aero-dev-insecure-secret-change-me";
}

function adminEmail(): string {
  return process.env.ADMIN_EMAIL || "admin@airfoils.pro";
}

function adminPassword(): string {
  return process.env.ADMIN_PASSWORD || "";
}

export function googleClientId(): string {
  return process.env.ADMIN_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
}

function googleClientSecret(): string {
  return process.env.ADMIN_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "";
}

export function googleAllowedDomain(): string {
  return (process.env.ADMIN_GOOGLE_ALLOWED_DOMAIN || "vr.ae").trim().toLowerCase();
}

/** dev = no auth (default off-prod); prod = configured admin provider required.
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

export function googleOAuthConfigured(): boolean {
  return !!googleClientId() && !!googleClientSecret();
}

export function adminAuthProviders(): AdminAuthProviders {
  return {
    google: googleOAuthConfigured(),
    password: !!adminPassword(),
  };
}

export function checkCredentials(email: string, password: string): boolean {
  if (authMode() === "dev") return true;
  const expectedPassword = adminPassword();
  if (!expectedPassword) return false; // prod misconfigured — refuse rather than allow
  return safeEqual(email.trim().toLowerCase(), adminEmail().trim().toLowerCase()) && safeEqual(password, expectedPassword);
}

export function signSession(email: string, ttlMs = 86_400_000, provider: AdminSession["provider"] = "password", domain?: string): string {
  const payload = Buffer.from(JSON.stringify({ email, provider, domain, exp: Date.now() + ttlMs })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token?: string): AdminSession | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { email: string; provider?: "password" | "google"; domain?: string; exp: number };
    if (!p.exp || p.exp < Date.now()) return null;
    return { email: p.email, provider: p.provider, domain: p.domain };
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

function requestOrigin(req: FastifyRequest): string {
  const configured = process.env.ADMIN_PUBLIC_ORIGIN || process.env.PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_API_URL || "";
  if (configured) return configured.replace(/\/+$/g, "");
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0]?.trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0]?.trim();
  const host = forwardedHost || String(req.headers.host || "");
  const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export function googleRedirectUri(req: FastifyRequest): string {
  return process.env.ADMIN_GOOGLE_REDIRECT_URI || `${requestOrigin(req)}/api/admin/oauth/google/callback`;
}

function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/api/")) return "/admin";
  return value;
}

export function signOAuthState(returnTo: unknown, ttlMs = 600_000): string {
  const payload = Buffer.from(
    JSON.stringify({
      nonce: crypto.randomBytes(24).toString("base64url"),
      returnTo: sanitizeReturnTo(returnTo),
      exp: Date.now() + ttlMs,
    }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyOAuthState(state: string | undefined, cookieState: string | undefined): { returnTo: string } | null {
  if (!state || !cookieState || !safeEqual(state, cookieState)) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { returnTo?: unknown; exp?: number };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return { returnTo: sanitizeReturnTo(parsed.returnTo) };
  } catch {
    return null;
  }
}

export function googleAuthorizationUrl(req: FastifyRequest, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", googleRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("hd", googleAllowedDomain());
  return url.toString();
}

type GoogleTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfo = {
  email?: string;
  email_verified?: boolean;
  hd?: string;
  sub?: string;
};

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) {
    const error = json as { error?: string; error_description?: string };
    throw new Error(error.error_description || error.error || `Google OAuth request failed (${res.status})`);
  }
  return json;
}

export function validateGoogleUser(user: GoogleUserInfo): AdminSession {
  const email = String(user.email || "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() || "" : "";
  const allowedDomain = googleAllowedDomain();
  const hostedDomain = String(user.hd || "").trim().toLowerCase();
  if (!email || !user.email_verified) throw new Error("Google account email is not verified");
  if (domain !== allowedDomain) throw new Error(`Google account must belong to ${allowedDomain}`);
  if (hostedDomain && hostedDomain !== allowedDomain) throw new Error(`Google account hosted domain must be ${allowedDomain}`);
  return { email, provider: "google", domain };
}

export async function googleSessionFromCode(req: FastifyRequest, code: string): Promise<AdminSession> {
  if (!googleOAuthConfigured()) throw new Error("Google OAuth is not configured");
  const form = new URLSearchParams();
  form.set("code", code);
  form.set("client_id", googleClientId());
  form.set("client_secret", googleClientSecret());
  form.set("redirect_uri", googleRedirectUri(req));
  form.set("grant_type", "authorization_code");
  const token = await readJson<GoogleTokenResponse>(
    await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }),
  );
  if (!token.access_token) throw new Error("Google OAuth did not return an access token");
  const user = await readJson<GoogleUserInfo>(
    await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
  );
  return validateGoogleUser(user);
}
