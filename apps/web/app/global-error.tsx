"use client";

// Last-resort boundary: catches errors in the root layout itself. It replaces the
// whole document, so it renders its own <html>/<body> and can't rely on the theme
// CSS variables — colors are hardcoded to the dark palette.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#070a0e",
          color: "#e6edf3",
          fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: 24, maxWidth: 460 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Airfoils.Pro hit a fatal error</h1>
          <p style={{ fontSize: 14, color: "#8a97a4", margin: "0 0 18px" }}>
            The application shell failed to render.
          </p>
          <pre
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              color: "#586572",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: "0 0 18px",
            }}
          >
            {error?.message || "Unknown error"}
            {error?.digest ? ` · digest ${error.digest}` : ""}
          </pre>
          <button
            onClick={() => reset()}
            style={{
              padding: "9px 18px",
              borderRadius: 8,
              border: "none",
              background: "#2dd4bf",
              color: "#04201c",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
