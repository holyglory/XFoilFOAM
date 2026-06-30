"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { C, MONO, SANS } from "@/lib/tokens";

// Persists across this boundary's remounts so auto-retry backs off instead of
// hammering reset() in a tight loop while the API stays down.
let autoAttempts = 0;
let lastFailAt = 0;

/**
 * Root error boundary. Almost every render error here is the control-plane API
 * being unreachable (e.g. the dev `api` server isn't up yet). Instead of the blank
 * page Next shows for an uncaught Server Component throw, render a clear, recoverable
 * state that retries on its own and offers a manual retry.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [secs, setSecs] = useState<number | null>(null);
  const router = useRouter();

  // reset() alone re-renders the boundary but reuses the cached (errored) RSC
  // payload, so the Server Component never refetches. router.refresh() invalidates
  // that cache and refetches; pairing them in a transition is what actually recovers.
  const retry = () => startTransition(() => {
    router.refresh();
    reset();
  });

  useEffect(() => {
    const now = Date.now();
    // A gap since the last failure means this is a fresh incident — reset backoff.
    if (now - lastFailAt > 60_000) autoAttempts = 0;
    lastFailAt = now;

    if (autoAttempts >= 5) {
      setSecs(null);
      return; // stop auto-retrying; the user can still retry manually
    }
    const delayMs = Math.min(3000 * 2 ** autoAttempts, 20_000);
    autoAttempts += 1;

    setSecs(Math.round(delayMs / 1000));
    const tick = setInterval(() => setSecs((s) => (s && s > 1 ? s - 1 : s)), 1000);
    const t = setTimeout(() => {
      clearInterval(tick);
      retry();
    }, delayMs);
    return () => {
      clearInterval(tick);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryNow = () => {
    autoAttempts = 0;
    retry();
  };

  const looksLikeApiDown = /fetch failed|ECONNREFUSED|Failed to fetch|NetworkError|load failed/i.test(
    `${error?.message} ${(error as { cause?: { code?: string } })?.cause?.code ?? ""}`,
  );

  return (
    <AppShell active="">
      <div
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "96px 22px 56px",
          fontFamily: SANS,
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 46,
            height: 46,
            borderRadius: 12,
            border: `1px solid ${C.border}`,
            background: C.panel,
            color: C.amber,
            fontSize: 22,
            marginBottom: 18,
          }}
          aria-hidden
        >
          ⚠
        </div>
        <h1 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", color: C.text }}>
          {looksLikeApiDown ? "Can’t reach the API" : "Something went wrong"}
        </h1>
        <p style={{ margin: "0 0 4px", fontSize: 14, lineHeight: 1.5, color: C.muted }}>
          {looksLikeApiDown
            ? "The control-plane API didn’t respond. In local dev it may still be starting up — this usually clears in a moment."
            : "This page hit an unexpected error while loading."}
        </p>

        <div
          style={{
            margin: "20px auto 0",
            maxWidth: 460,
            padding: "10px 14px",
            border: `1px solid ${C.borderSoft}`,
            borderRadius: 8,
            background: C.panel2,
            fontFamily: MONO,
            fontSize: 12,
            color: C.dim,
            wordBreak: "break-word",
          }}
        >
          {error?.message || "Unknown error"}
          {error?.digest ? <span style={{ color: C.dimmer }}> · digest {error.digest}</span> : null}
        </div>

        <div style={{ marginTop: 22, display: "flex", gap: 10, justifyContent: "center", alignItems: "center" }}>
          <button
            onClick={retryNow}
            style={{
              padding: "9px 18px",
              borderRadius: 8,
              border: "none",
              background: C.teal,
              color: C.tealInk,
              fontFamily: MONO,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Retry now
          </button>
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>
            {secs != null ? `retrying in ${secs}s…` : "automatic retries paused"}
          </span>
        </div>

        {looksLikeApiDown ? (
          <p style={{ marginTop: 22, fontFamily: MONO, fontSize: 11, color: C.dimmer }}>
            If this persists, make sure the <span style={{ color: C.muted }}>api</span> dev server is running on :4000.
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}
