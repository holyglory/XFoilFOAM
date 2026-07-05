"use client";

import {
  type AirfoilSummary,
  buildNaca4,
  deriveGeometry,
  parseCoordinates,
  parseNaca4,
  type Point,
} from "@aerodb/core";
import { strFromU8, unzipSync } from "fflate";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

import { AirfoilGlyph } from "@/components/AirfoilGlyph";
import { bulkCreateAirfoils, type BulkResult, type CategoryListItem, createAirfoil, getCategories } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

type Tab = "upload" | "single";
type Mode = "naca" | "coords";

interface StagedFile {
  name: string;
  coordinates: string;
  points: Point[] | null;
  error: string | null;
}

// Per-request cap: the bulk route accepts ≤200 items and Fastify's default body
// limit is 1 MB, so we send the staged files in modest chunks and aggregate.
const CHUNK = 40;
const MAX_FILE_BYTES = 512 * 1024;

const fieldStyle: CSSProperties = {
  width: "100%",
  fontFamily: MONO,
  fontSize: 12,
  color: C.text,
  background: C.panel2,
  border: `1px solid ${C.stroke}`,
  borderRadius: 8,
  padding: "9px 11px",
  outline: "none",
};
const labelStyle: CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim, marginBottom: 6 };

/** True for OS/zip cruft we should never treat as an airfoil. */
function isCruft(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return !base || base.startsWith(".") || path.startsWith("__MACOSX") || path.includes("/__MACOSX");
}

function baseName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
}

function stage(name: string, text: string): StagedFile {
  try {
    return { name, coordinates: text, points: parseCoordinates(text).points, error: null };
  } catch (e) {
    return { name, coordinates: text, points: null, error: (e as Error).message };
  }
}

export function AddAirfoilsPanel() {
  const [tab, setTab] = useState<Tab>("upload");
  const [categories, setCategories] = useState<CategoryListItem[]>([]);
  const [categorySlug, setCategorySlug] = useState("");

  // upload (folder / zip / files)
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  // single (NACA / coords)
  const [mode, setMode] = useState<Mode>("naca");
  const [name, setName] = useState("");
  const [digits, setDigits] = useState("2412");
  const [coords, setCoords] = useState("");
  const digitsRef = useRef<HTMLInputElement | null>(null);
  const coordsRef = useRef<HTMLTextAreaElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCategories().then(setCategories).catch(() => {});
  }, []);

  const preview = useMemo(() => {
    try {
      if (mode === "naca") {
        const p = parseNaca4(digits);
        return { points: buildNaca4(p).contour, t: p.t * 100, m: p.m * 100, error: null as string | null };
      }
      if (!coords.trim()) return null;
      const parsed = parseCoordinates(coords);
      const geo = deriveGeometry(parsed.points);
      return { points: parsed.points, t: geo.thicknessPct, m: geo.camberPct, error: null as string | null };
    } catch (e) {
      return { points: null, t: 0, m: 0, error: (e as Error).message };
    }
  }, [mode, digits, coords]);

  const reset = () => {
    setBulkResult(null);
    setProgress(null);
    setError(null);
  };

  const onFolder = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    reset();
    const picked = Array.from(list).filter(
      (f) => f.size > 0 && f.size <= MAX_FILE_BYTES && !isCruft(f.webkitRelativePath || f.name),
    );
    const staged = await Promise.all(picked.map(async (f) => stage(baseName(f.name), await f.text())));
    setFiles(staged);
    setSourceLabel(`folder · ${staged.length} file${staged.length === 1 ? "" : "s"}`);
  };

  const onZip = async (file: File | null | undefined) => {
    if (!file) return;
    reset();
    try {
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const staged: StagedFile[] = [];
      for (const [path, data] of Object.entries(entries)) {
        if (path.endsWith("/") || data.length === 0 || data.length > MAX_FILE_BYTES || isCruft(path)) continue;
        staged.push(stage(baseName(path), strFromU8(data)));
      }
      setFiles(staged);
      setSourceLabel(`${file.name} · ${staged.length} file${staged.length === 1 ? "" : "s"}`);
    } catch (e) {
      setError(`could not read zip: ${(e as Error).message}`);
    }
  };

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    reset();
    const staged = await Promise.all(Array.from(list).map(async (f) => stage(baseName(f.name), await f.text())));
    setFiles(staged);
    setSourceLabel(`${staged.length} file${staged.length === 1 ? "" : "s"}`);
  };

  // Every staged file is treated as an airfoil description and sent to the database;
  // the server parses/validates each and reports which succeeded vs failed.
  const importAll = async () => {
    const items = files
      .map((f) => ({ name: f.name, coordinates: f.coordinates }))
      .filter((i) => i.coordinates.trim().length > 0);
    if (items.length === 0) {
      setError("no files to import");
      return;
    }
    setBusy(true);
    setError(null);
    setBulkResult(null);
    setProgress({ done: 0, total: items.length });
    const agg: BulkResult = { created: [], errors: [] };
    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK);
      try {
        const r = await bulkCreateAirfoils(slice, categorySlug || undefined);
        agg.created.push(...r.created);
        agg.errors.push(...r.errors);
      } catch (e) {
        // A whole-chunk failure (network/validation) must not abort the run or
        // discard what already persisted — record it per-file and keep going.
        const msg = (e as Error).message;
        for (const it of slice) agg.errors.push({ name: it.name || "(unnamed)", error: msg });
      }
      setProgress({ done: Math.min(i + CHUNK, items.length), total: items.length });
      // live-updating summary so progress is visible across many chunks
      setBulkResult({ created: [...agg.created], errors: [...agg.errors] });
    }
    setBusy(false);
  };

  const submitSingle = async () => {
    if (mode === "coords" && !coords.trim()) {
      setError("Coordinates are required");
      coordsRef.current?.focus();
      return;
    }
    if (preview?.error) {
      setError(preview.error);
      (mode === "naca" ? digitsRef.current : coordsRef.current)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === "naca"
          ? { name: name.trim() || `NACA ${digits.replace(/[^0-9]/g, "")}`, naca: parseNaca4(digits), categorySlug: categorySlug || undefined }
          : { name: name.trim() || undefined, coordinates: coords, categorySlug: categorySlug || undefined };
      const created = await createAirfoil(body);
      setBulkResult({ created: [created], errors: [] });
      setName("");
      setCoords("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const validCount = files.filter((f) => f.points).length;

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>Add airfoils</h2>
      <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, marginBottom: 16 }}>
        Import a local folder or a .zip — every file is treated as an airfoil description and added to the database.
      </div>

      <div style={{ ...card, maxWidth: 680 }}>
        {/* tabs + category */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: C.panel2, border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: 3, gap: 2 }}>
            {(["upload", "single"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => { setTab(t); reset(); }}
                style={{ fontFamily: MONO, fontSize: 11, border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", background: tab === t ? C.tabActive : "transparent", color: tab === t ? C.teal : C.muted, fontWeight: tab === t ? 600 : 400 }}
              >
                {t === "upload" ? "Folder / Zip" : "Single"}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle as CSSProperties}>CATEGORY</span>
            <select value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} style={{ ...fieldStyle, width: 200 }}>
              <option value="">Custom (default)</option>
              {categories
                .filter((c) => c.slug !== "custom")
                .map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {" ".repeat(c.depth * 2)}
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
        </div>

        {tab === "upload" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <label style={pickBtn}>
                ▢ Choose folder…
                <input ref={setFolderAttrs} type="file" multiple onChange={(e) => onFolder(e.target.files)} style={{ display: "none" }} />
              </label>
              <label style={pickBtn}>
                🗜 Choose .zip…
                <input type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={(e) => onZip(e.target.files?.[0])} style={{ display: "none" }} />
              </label>
              <label style={pickBtnGhost}>
                …or individual files
                <input type="file" multiple accept=".dat,.txt,.csv" onChange={(e) => onFiles(e.target.files)} style={{ display: "none" }} />
              </label>
            </div>

            {sourceLabel && (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                {sourceLabel} · <span style={{ color: C.teal }}>{validCount} parse-valid</span>
                {files.length - validCount > 0 && <span style={{ color: C.red }}> · {files.length - validCount} unparsed</span>}
              </div>
            )}

            {files.length > 0 && (
              <div style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 10, overflow: "hidden", maxHeight: 300, overflowY: "auto" }}>
                {files.map((f, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", borderBottom: `1px solid ${C.borderRow}` }}>
                    {f.points ? <AirfoilGlyph points={f.points} width={40} height={18} /> : <span style={{ width: 40, flex: "none" }} />}
                    <span style={{ flex: 1, fontFamily: MONO, fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: f.points ? C.teal : C.red }}>{f.points ? `${f.points.length} pts` : f.error || "parse error"}</span>
                  </div>
                ))}
              </div>
            )}

            {error && <div style={{ fontFamily: MONO, fontSize: 11, color: C.red }}>{error}</div>}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                {busy && progress ? `importing ${progress.done}/${progress.total}…` : `${files.length} file${files.length === 1 ? "" : "s"} staged`}
              </span>
              <button type="button" disabled={busy || files.length === 0} title={files.length === 0 ? "Choose files before importing" : undefined} onClick={importAll} style={primaryBtn(busy || files.length === 0)}>
                {busy ? "Importing…" : `Import ${files.length} file${files.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", background: C.panel2, border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: 3, gap: 2, width: "fit-content" }}>
              {(["naca", "coords"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  style={{ fontFamily: MONO, fontSize: 11, border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", background: mode === m ? C.tabActive : "transparent", color: mode === m ? C.teal : C.muted, fontWeight: mode === m ? 600 : 400 }}
                >
                  {m === "naca" ? "NACA 4-digit" : "Coordinates"}
                </button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 150px", gap: 14, alignItems: "start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={labelStyle}>NAME{mode === "coords" ? " (optional)" : ""}</div>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "naca" ? `NACA ${digits.replace(/[^0-9]/g, "")}` : "from file / first line"} style={fieldStyle} />
                </div>
                {mode === "naca" ? (
                  <div>
                    <div style={labelStyle}>4-DIGIT CODE</div>
                    <input ref={digitsRef} value={digits} onChange={(e) => setDigits(e.target.value)} placeholder="e.g. 2412" style={fieldStyle} />
                  </div>
                ) : (
                  <div>
                    <div style={labelStyle}>COORDINATES (Selig or Lednicer .dat)</div>
                    <textarea ref={coordsRef} value={coords} onChange={(e) => setCoords(e.target.value)} placeholder={"NACA 0012\n1.000000 0.001260\n0.950000 ..."} rows={8} style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.4 }} />
                  </div>
                )}
              </div>
              <div style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 10, background: C.panel2, textAlign: "center" }}>
                <div style={{ ...labelStyle, marginBottom: 8 }}>PREVIEW</div>
                {preview?.error ? (
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.red, lineHeight: 1.4 }}>{preview.error}</div>
                ) : preview?.points ? (
                  <>
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <AirfoilGlyph points={preview.points} width={128} height={56} />
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
                      t/c {preview.t.toFixed(1)}%<br />
                      camber {preview.m.toFixed(1)}%
                    </div>
                  </>
                ) : (
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>paste coordinates…</div>
                )}
              </div>
            </div>

            {error && <div style={{ fontFamily: MONO, fontSize: 11, color: C.red }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" disabled={busy} onClick={submitSingle} style={primaryBtn(busy)}>
                {busy ? "Adding…" : "Add airfoil"}
              </button>
            </div>
          </div>
        )}

        {bulkResult && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.borderSoft}` }}>
            <div style={{ fontFamily: MONO, fontSize: 12, color: C.teal }}>
              ✓ added {bulkResult.created.length} airfoil{bulkResult.created.length === 1 ? "" : "s"}
              {bulkResult.errors.length > 0 && <span style={{ color: C.red }}> · {bulkResult.errors.length} failed</span>}
            </div>
            {bulkResult.errors.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 160, overflowY: "auto", border: `1px solid ${C.borderRow}`, borderRadius: 8 }}>
                {bulkResult.errors.slice(0, 50).map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, padding: "5px 10px", fontFamily: MONO, fontSize: 10, borderBottom: `1px solid ${C.borderRow}` }}>
                    <span style={{ color: C.muted, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                    <span style={{ color: C.red }}>{e.error}</span>
                  </div>
                ))}
                {bulkResult.errors.length > 50 && (
                  <div style={{ padding: "5px 10px", fontFamily: MONO, fontSize: 10, color: C.dim }}>…and {bulkResult.errors.length - 50} more</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// webkitdirectory/directory are non-standard attributes (not in React's input
// types); set them imperatively so the folder picker selects a directory.
function setFolderAttrs(el: HTMLInputElement | null) {
  if (!el) return;
  el.setAttribute("webkitdirectory", "");
  el.setAttribute("directory", "");
}

const card: CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 };

const pickBtn: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 600,
  color: C.teal,
  background: C.panel2,
  border: `1px solid ${C.tealBorder}`,
  borderRadius: 9,
  padding: "12px 16px",
  cursor: "pointer",
};
const pickBtnGhost: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12,
  color: C.muted,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 9,
  padding: "12px 16px",
  cursor: "pointer",
};

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 600,
    color: C.tealInk,
    background: C.teal,
    border: `1px solid ${C.teal}`,
    borderRadius: 8,
    padding: "9px 16px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
