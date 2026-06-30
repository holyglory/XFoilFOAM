"use client";

import {
  type AirfoilDetailPayload,
  type AirfoilSummary,
  type CategoryNode,
  type HashtagDTO,
  profilePaths,
} from "@aerodb/core";
import { Archive, CheckSquare, ChevronRight, Folder, MoveRight, Search, SlidersHorizontal, Square, Tags, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { AirfoilGlyph } from "@/components/AirfoilGlyph";
import { adminMe, bulkAirfoils } from "@/lib/admin";
import { getAirfoilDetail, getCategoriesTree, getHashtags, listAirfoils } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

type SortKey = "name" | "family" | "thicknessPct" | "camberPct" | "areaProfile" | "ldmax" | "clmax" | "cdmin";
type MetricKey =
  | "thickness"
  | "area"
  | "upperArea"
  | "upperPositive"
  | "upperNegative"
  | "lowerArea"
  | "lowerPositive"
  | "lowerNegative"
  | "camberArea"
  | "camberPositive"
  | "camberNegative";

type Filters = Record<`${MetricKey}Min` | `${MetricKey}Max`, string>;

const EMPTY_FILTERS: Filters = {
  thicknessMin: "",
  thicknessMax: "",
  areaMin: "",
  areaMax: "",
  upperAreaMin: "",
  upperAreaMax: "",
  upperPositiveMin: "",
  upperPositiveMax: "",
  upperNegativeMin: "",
  upperNegativeMax: "",
  lowerAreaMin: "",
  lowerAreaMax: "",
  lowerPositiveMin: "",
  lowerPositiveMax: "",
  lowerNegativeMin: "",
  lowerNegativeMax: "",
  camberAreaMin: "",
  camberAreaMax: "",
  camberPositiveMin: "",
  camberPositiveMax: "",
  camberNegativeMin: "",
  camberNegativeMax: "",
};

const COLS: { key: SortKey; label: string; fmt: (a: AirfoilSummary) => string; num: boolean }[] = [
  { key: "name", label: "NAME", fmt: (a) => a.name, num: false },
  { key: "family", label: "CATEGORY", fmt: (a) => a.family, num: false },
  { key: "thicknessPct", label: "t/c", fmt: (a) => a.thicknessPct.toFixed(1), num: true },
  { key: "camberPct", label: "CAMB", fmt: (a) => a.camberPct.toFixed(1), num: true },
  { key: "areaProfile", label: "AREA", fmt: (a) => a.areaProfile.toFixed(3), num: true },
  { key: "ldmax", label: "L/D", fmt: (a) => solvedMetric(a.ldmax, 1), num: true },
  { key: "cdmin", label: "Cd", fmt: (a) => solvedMetric(a.cdmin, 4), num: true },
];

const METRIC_LABELS: Record<MetricKey, string> = {
  thickness: "Thickness %",
  area: "Profile area",
  upperArea: "Upper signed area",
  upperPositive: "Upper positive area",
  upperNegative: "Upper negative area",
  lowerArea: "Lower signed area",
  lowerPositive: "Lower positive area",
  lowerNegative: "Lower negative area",
  camberArea: "Camber signed area",
  camberPositive: "Camber positive area",
  camberNegative: "Camber negative area",
};

function num(v: string): number | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function solvedMetric(value: number | null | undefined, digits: number): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function flattenCategories(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flattenCategories(n.children)]);
}

export function BrowseView({
  initialItems,
  categories: initialCategories,
  hashtags: initialHashtags,
}: {
  initialItems: AirfoilSummary[];
  categories: CategoryNode[];
  hashtags: HashtagDTO[];
}) {
  const [items, setItems] = useState(initialItems);
  const [categories, setCategories] = useState(initialCategories);
  const [hashtags, setHashtags] = useState(initialHashtags);
  const [authed, setAuthed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [q, setQ] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("ldmax");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [includeSubcategories, setIncludeSubcategories] = useState(true);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filterHashtags, setFilterHashtags] = useState<string[]>([]);
  const [focusedMetric, setFocusedMetric] = useState<MetricKey | null>(null);
  const [selected, setSelected] = useState(initialItems[0]?.slug ?? "");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [bulkHashtagIds, setBulkHashtagIds] = useState<string[]>([]);
  const [visible, setVisible] = useState(150);
  const [choosingDetail, setChoosingDetail] = useState(false);
  const browseRequestSeq = useRef(0);
  const router = useRouter();

  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);
  const rootCount = useMemo(() => categories.reduce((sum, n) => sum + n.airfoilCount, 0), [categories]);
  const visibleIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const selectedVisibleCount = [...selectedIds].filter((id) => visibleIds.has(id)).length;

  useEffect(() => {
    setHydrated(true);
    setChoosingDetail(new URLSearchParams(window.location.search).get("chooseDetail") === "1");
  }, []);

  useEffect(() => {
    adminMe()
      .then((me) => setAuthed(me.authed))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const requestSeq = ++browseRequestSeq.current;
    const t = setTimeout(async () => {
      try {
        setErr(null);
        const next = await listAirfoils({
          q,
          category: selectedCategory || undefined,
          includeSubcategories,
          sort: apiSort(sortKey),
          dir,
          hashtags: filterHashtags,
          thicknessMin: num(filters.thicknessMin),
          thicknessMax: num(filters.thicknessMax),
          areaMin: num(filters.areaMin),
          areaMax: num(filters.areaMax),
          upperAreaMin: num(filters.upperAreaMin),
          upperAreaMax: num(filters.upperAreaMax),
          upperPositiveMin: num(filters.upperPositiveMin),
          upperPositiveMax: num(filters.upperPositiveMax),
          upperNegativeMin: num(filters.upperNegativeMin),
          upperNegativeMax: num(filters.upperNegativeMax),
          lowerAreaMin: num(filters.lowerAreaMin),
          lowerAreaMax: num(filters.lowerAreaMax),
          lowerPositiveMin: num(filters.lowerPositiveMin),
          lowerPositiveMax: num(filters.lowerPositiveMax),
          lowerNegativeMin: num(filters.lowerNegativeMin),
          lowerNegativeMax: num(filters.lowerNegativeMax),
          camberAreaMin: num(filters.camberAreaMin),
          camberAreaMax: num(filters.camberAreaMax),
          camberPositiveMin: num(filters.camberPositiveMin),
          camberPositiveMax: num(filters.camberPositiveMax),
          camberNegativeMin: num(filters.camberNegativeMin),
          camberNegativeMax: num(filters.camberNegativeMax),
        });
        if (requestSeq !== browseRequestSeq.current) return;
        setItems(next);
        setVisible(150);
        setSelected((slug) => (next.some((a) => a.slug === slug) ? slug : next[0]?.slug ?? ""));
        setSelectedIds((ids) => new Set([...ids].filter((id) => next.some((a) => a.id === id))));
      } catch (e) {
        if (requestSeq !== browseRequestSeq.current) return;
        setErr((e as Error).message);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q, selectedCategory, includeSubcategories, filters, filterHashtags, sortKey, dir]);

  const refreshMeta = async () => {
    const [tree, tagRows] = await Promise.all([getCategoriesTree(), getHashtags()]);
    setCategories(tree);
    setHashtags(tagRows);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refreshMeta();
      const next = await listAirfoils({
        q,
        category: selectedCategory || undefined,
        includeSubcategories,
        sort: apiSort(sortKey),
        dir,
        hashtags: filterHashtags,
        thicknessMin: num(filters.thicknessMin),
        thicknessMax: num(filters.thicknessMax),
        areaMin: num(filters.areaMin),
        areaMax: num(filters.areaMax),
        upperAreaMin: num(filters.upperAreaMin),
        upperAreaMax: num(filters.upperAreaMax),
        upperPositiveMin: num(filters.upperPositiveMin),
        upperPositiveMax: num(filters.upperPositiveMax),
        upperNegativeMin: num(filters.upperNegativeMin),
        upperNegativeMax: num(filters.upperNegativeMax),
        lowerAreaMin: num(filters.lowerAreaMin),
        lowerAreaMax: num(filters.lowerAreaMax),
        lowerPositiveMin: num(filters.lowerPositiveMin),
        lowerPositiveMax: num(filters.lowerPositiveMax),
        lowerNegativeMin: num(filters.lowerNegativeMin),
        lowerNegativeMax: num(filters.lowerNegativeMax),
        camberAreaMin: num(filters.camberAreaMin),
        camberAreaMax: num(filters.camberAreaMax),
        camberPositiveMin: num(filters.camberPositiveMin),
        camberPositiveMax: num(filters.camberPositiveMax),
        camberNegativeMin: num(filters.camberNegativeMin),
        camberNegativeMax: num(filters.camberNegativeMax),
      });
      setItems(next);
      setSelectedIds(new Set());
      setBulkHashtagIds([]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSort = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setDir(k === "name" || k === "family" ? "asc" : "desc");
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openDetail = (slug: string) => {
    window.localStorage.setItem("aerodb-last-detail-slug", slug);
    router.push(`/airfoils/${slug}`);
  };

  return (
    <>
      <style jsx global>{`
        .browse-surface {
          display: grid;
          grid-template-columns: 220px minmax(0, 1fr) 352px;
          gap: 18px;
          align-items: start;
        }
        .browse-categories,
        .browse-preview {
          position: sticky;
          top: 68px;
        }
        .browse-categories {
          display: flex;
          flex-direction: column;
          max-height: calc(100vh - 88px);
          overflow: hidden;
          min-height: 0;
        }
        .browse-category-scroll {
          overflow-y: auto;
          overflow-x: hidden;
          min-height: 0;
          overscroll-behavior: contain;
          scrollbar-width: thin;
          padding: 4px 0 8px;
        }
        .airfoil-row {
          display: grid;
          grid-template-columns: 34px 1.45fr 1fr 0.62fr 0.62fr 0.7fr 0.72fr 0.82fr;
          align-items: center;
          min-width: 0;
        }
        .airfoil-cell,
        .airfoil-col-button,
        .airfoil-name-wrap {
          min-width: 0;
        }
        .airfoil-name-cell {
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
        }
        .browse-tag-chip {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          max-width: 110px;
          font-size: 9px;
          color: var(--aero-teal);
          border: 1px solid var(--aero-teal-border);
          border-radius: 5px;
          padding: 1px 4px;
        }
        .browse-tag-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .browse-tag-remove {
          width: 14px;
          height: 14px;
          display: none;
          align-items: center;
          justify-content: center;
          border: 0;
          border-radius: 4px;
          padding: 0;
          color: var(--aero-red);
          background: transparent;
          cursor: pointer;
          flex: 0 0 auto;
        }
        .browse-tag-chip:hover .browse-tag-remove,
        .browse-tag-chip:focus-within .browse-tag-remove {
          display: inline-flex;
        }
        .bulk-toolbar {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: nowrap;
          overflow-x: auto;
          scrollbar-width: thin;
          background: var(--aero-panel);
          border: 1px solid var(--aero-teal-border);
          border-radius: 8px;
          padding: 8px;
          margin-bottom: 10px;
        }
        .bulk-popover-anchor {
          position: relative;
          display: inline-flex;
          flex: 0 0 auto;
        }
        .bulk-popover {
          position: absolute;
          z-index: 20;
          top: calc(100% + 6px);
          left: 0;
          width: min(310px, 78vw);
          max-height: 310px;
          overflow: auto;
          background: var(--aero-panel);
          border: 1px solid var(--aero-border);
          border-radius: 8px;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
          padding: 8px;
        }
        .bulk-tag-input {
          width: 180px;
          min-width: 140px;
        }
        @media (max-width: 760px) {
          .bulk-action-label {
            display: none;
          }
          .bulk-tag-input {
            width: 132px;
          }
        }
        @media (max-width: 1180px) {
          .browse-surface {
            grid-template-columns: 220px minmax(0, 1fr);
          }
          .browse-preview {
            display: none;
          }
        }
        @media (max-width: 920px) {
          .browse-surface {
            grid-template-columns: minmax(0, 1fr);
          }
          .browse-categories {
            position: static;
            max-height: min(360px, 42vh);
          }
          .airfoil-row {
            grid-template-columns: 30px minmax(0, 1fr) 56px 56px 68px;
          }
          .airfoil-col-family,
          .airfoil-col-areaProfile,
          .airfoil-col-cdmin {
            display: none;
          }
        }
        @media (max-width: 560px) {
          .airfoil-row {
            grid-template-columns: 26px minmax(0, 1fr) 64px;
          }
          .airfoil-col-thicknessPct,
          .airfoil-col-camberPct {
            display: none;
          }
          .airfoil-glyph {
            display: none;
          }
        }
      `}</style>
      <div data-testid="browse-surface" data-hydrated={hydrated ? "true" : "false"} className="browse-surface">
      <aside className="browse-categories" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <div style={{ padding: "11px 12px", borderBottom: `1px solid ${C.borderSoft}`, fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", color: C.dim }}>
          CATEGORIES
        </div>
        <div className="browse-category-scroll">
          <CategoryButton root selected={!selectedCategory} count={rootCount} label="All categories" onClick={() => setSelectedCategory("")} />
          {categories.map((node) => (
            <CategoryTree key={node.id} node={node} selected={selectedCategory} onSelect={setSelectedCategory} />
          ))}
        </div>
      </aside>

      <main style={{ minWidth: 0 }}>
        {choosingDetail && (
          <div data-testid="choose-detail-state" style={{ fontFamily: MONO, fontSize: 11, color: C.teal, border: `1px solid ${C.tealBorder}`, borderRadius: 8, padding: "8px 10px", marginBottom: 10, background: C.tealFill }}>
            Choose an airfoil to open its Detail page.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) auto", gap: 8, marginBottom: 8 }}>
          <label style={{ position: "relative", display: "block" }}>
            <Search size={14} style={{ position: "absolute", left: 10, top: 10, color: C.dim }} />
            <input
              data-testid="airfoil-name-filter"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="filter by airfoil name..."
              style={inputStyle({ paddingLeft: 32 })}
            />
          </label>
          <button
            type="button"
            aria-label="Advanced filters"
            title="Advanced filters"
            data-testid="advanced-filters-button"
            onClick={() => setAdvanced((v) => !v)}
            style={iconBtn(advanced)}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 10, fontFamily: MONO, fontSize: 11, color: C.muted }}>
          <input
            data-testid="include-subcategories"
            type="checkbox"
            checked={includeSubcategories}
            onChange={(e) => setIncludeSubcategories(e.target.checked)}
          />
          include subcategories
        </label>

        {advanced && (
          <div data-testid="advanced-filters-panel" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              <RangeFields metric="thickness" filters={filters} setFilters={setFilters} focusedMetric={focusedMetric} setFocusedMetric={setFocusedMetric} min={0} max={30} step={0.1} />
              <RangeFields metric="area" filters={filters} setFilters={setFilters} focusedMetric={focusedMetric} setFocusedMetric={setFocusedMetric} min={0} max={0.4} step={0.001} />
            </div>
            <SurfaceFilters title="UPPER SURFACE" keys={["upperArea", "upperPositive", "upperNegative"]} filters={filters} setFilters={setFilters} focusedMetric={focusedMetric} setFocusedMetric={setFocusedMetric} />
            <SurfaceFilters title="LOWER SURFACE" keys={["lowerArea", "lowerPositive", "lowerNegative"]} filters={filters} setFilters={setFilters} focusedMetric={focusedMetric} setFocusedMetric={setFocusedMetric} />
            <SurfaceFilters title="MEAN CAMBER" keys={["camberArea", "camberPositive", "camberNegative"]} filters={filters} setFilters={setFilters} focusedMetric={focusedMetric} setFocusedMetric={setFocusedMetric} />
            <div style={{ marginTop: 12 }}>
              <div style={miniLabel}>HASHTAGS</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {hashtags.map((h) => {
                  const selected = filterHashtags.includes(h.slug);
                  return (
                    <button
                      key={h.id}
                      type="button"
                      data-testid={`hashtag-filter-${h.slug}`}
                      onClick={() =>
                        setFilterHashtags((old) =>
                          old.includes(h.slug) ? old.filter((x) => x !== h.slug) : [...old, h.slug],
                        )
                      }
                      style={pillBtn(selected)}
                    >
                      #{h.name}
                    </button>
                  );
                })}
              </div>
            </div>
            {focusedMetric && <AreaInfographic metric={focusedMetric} />}
          </div>
        )}

        {err && <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 10 }}>{err}</div>}

        {authed && selectedVisibleCount > 0 && (
          <BulkToolbar
            count={selectedVisibleCount}
            busy={busy}
            categories={flatCategories}
            hashtags={hashtags}
            hashtagIds={bulkHashtagIds}
            setHashtagIds={setBulkHashtagIds}
            onSelectAll={() => setSelectedIds(new Set(items.map((a) => a.id)))}
            onSelectNone={() => setSelectedIds(new Set())}
            onMoveTo={(categoryId) => act(() => bulkAirfoils({ ids: [...selectedIds], action: "move", categoryId }))}
            onArchive={() => window.confirm(`Archive ${selectedVisibleCount} selected airfoils?`) && act(() => bulkAirfoils({ ids: [...selectedIds], action: "archive" }))}
            onRemove={() => window.confirm(`Remove ${selectedVisibleCount} selected airfoils?`) && act(() => bulkAirfoils({ ids: [...selectedIds], action: "remove" }))}
            onAssignTags={() => bulkHashtagIds.length > 0 && act(() => bulkAirfoils({ ids: [...selectedIds], action: "assignHashtags", hashtagIds: bulkHashtagIds }))}
            onRemoveTags={() => bulkHashtagIds.length > 0 && act(() => bulkAirfoils({ ids: [...selectedIds], action: "removeHashtags", hashtagIds: bulkHashtagIds }))}
          />
        )}

        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div
            className="airfoil-row"
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: "0.06em",
              color: C.dim,
              padding: "10px 14px",
              borderBottom: `1px solid ${C.borderSoft}`,
            }}
          >
            <span />
            {COLS.map((c) => (
              <button key={c.key} type="button" className={`airfoil-col-button airfoil-col-${c.key}`} onClick={() => onSort(c.key)} style={sortButton(c.num, sortKey === c.key)}>
                {c.label}
                {sortKey === c.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
              </button>
            ))}
          </div>
          {items.slice(0, visible).map((a) => {
            const checked = selectedIds.has(a.id);
            const checkVisible = authed && (checked || selectedIds.size > 0 || hoveredId === a.id);
            return (
              <div
                key={a.slug}
                data-testid={`airfoil-row-${a.slug}`}
                className="airfoil-row"
                role="button"
                tabIndex={0}
                onClick={() => openDetail(a.slug)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openDetail(a.slug);
                }}
                onMouseEnter={() => {
                  setSelected(a.slug);
                  setHoveredId(a.id);
                }}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  padding: "9px 14px",
                  borderBottom: `1px solid ${C.borderRow}`,
                  cursor: "pointer",
                  background: selected === a.slug ? C.rowActive : "transparent",
                }}
              >
                <button
                  type="button"
                  aria-label={checked ? `Deselect ${a.name}` : `Select ${a.name}`}
                  data-testid={`select-airfoil-${a.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSelected(a.id);
                  }}
                  style={{ ...checkBtn, opacity: checkVisible ? 1 : 0, pointerEvents: checkVisible ? "auto" : "none" }}
                >
                  {checked ? <CheckSquare size={15} /> : <Square size={15} />}
                </button>
                <span className="airfoil-name-cell airfoil-cell airfoil-col-name">
                  <span className="airfoil-glyph">
                    <AirfoilGlyph points={a.points} />
                  </span>
                  <span className="airfoil-name-wrap">
                    <span style={{ color: C.text, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                      {a.name}
                    </span>
                    {a.hashtags.length > 0 && (
                      <span style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                        {a.hashtags.map((h) => (
                          <span key={h.id} className="browse-tag-chip">
                            <span className="browse-tag-text">#{h.name}</span>
                            {authed && (
                              <button
                                type="button"
                                className="browse-tag-remove"
                                aria-label={`Remove ${h.name} from ${a.name}`}
                                title={`Remove ${h.name}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  act(() => bulkAirfoils({ ids: [a.id], action: "removeHashtags", hashtagIds: [h.id] }));
                                }}
                              >
                                <X size={10} />
                              </button>
                            )}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </span>
                <span className="airfoil-cell airfoil-col-family" style={{ color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.family}</span>
                <span className="airfoil-cell airfoil-col-thicknessPct" style={{ textAlign: "right", color: C.text }}>{a.thicknessPct.toFixed(1)}</span>
                <span className="airfoil-cell airfoil-col-camberPct" style={{ textAlign: "right", color: C.text }}>{a.camberPct.toFixed(1)}</span>
                <span className="airfoil-cell airfoil-col-areaProfile" style={{ textAlign: "right", color: C.muted }}>{a.areaProfile.toFixed(3)}</span>
                <span
                  className="airfoil-cell airfoil-col-ldmax"
                  title={
                    a.ldmax == null
                      ? "No fitted polar cache is available yet"
                      : `Best-fit ${a.fitStatus ?? "polar"} from ${a.polarCount} point${a.polarCount === 1 ? "" : "s"}`
                  }
                  style={{ textAlign: "right", color: a.ldmax == null ? C.dim : C.teal }}
                >
                  {solvedMetric(a.ldmax, 1)}
                </span>
                <span
                  className="airfoil-cell airfoil-col-cdmin"
                  title={
                    a.cdmin == null
                      ? "No fitted polar cache is available yet"
                      : `Best-fit ${a.fitStatus ?? "polar"} from ${a.polarCount} point${a.polarCount === 1 ? "" : "s"}`
                  }
                  style={{ textAlign: "right", color: C.muted }}
                >
                  {solvedMetric(a.cdmin, 4)}
                </span>
              </div>
            );
          })}
          {items.length === 0 && <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim, padding: "18px 14px" }}>no airfoils match.</div>}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, fontFamily: MONO, fontSize: 11, color: C.dim }}>
          <span>
            showing {Math.min(visible, items.length)} of {items.length}
          </span>
          {items.length > visible && (
            <button type="button" onClick={() => setVisible((v) => v + 300)} style={smallButton}>
              Load more
            </button>
          )}
        </div>
      </main>

      <PreviewPane slug={selected} summary={items.find((item) => item.slug === selected)} />
      </div>
    </>
  );
}

function apiSort(k: SortKey): string {
  if (k === "thicknessPct") return "thickness";
  if (k === "camberPct") return "camber";
  if (k === "areaProfile") return "area";
  return k;
}

function CategoryTree({ node, selected, onSelect }: { node: CategoryNode; selected: string; onSelect: (slug: string) => void }) {
  return (
    <div>
      <CategoryButton node={node} selected={selected === node.slug} label={node.name} count={node.airfoilCount} onClick={() => onSelect(node.slug)} />
      {node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <CategoryTree key={child.id} node={child} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryButton({
  node,
  root,
  selected,
  count,
  label,
  onClick,
}: {
  node?: CategoryNode;
  root?: boolean;
  selected: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={root ? "category-root" : `category-${node?.slug}`}
      onClick={onClick}
      style={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr) auto",
        gap: 6,
        alignItems: "center",
        padding: `7px 10px 7px ${10 + (node?.depth ?? 0) * 13}px`,
        border: "none",
        borderLeft: `2px solid ${selected ? C.teal : "transparent"}`,
        background: selected ? C.rowActive : "transparent",
        color: selected ? C.teal : C.muted,
        cursor: "pointer",
        fontFamily: MONO,
        fontSize: 11,
        textAlign: "left",
      }}
    >
      {root ? <Folder size={14} /> : <ChevronRight size={13} />}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ color: C.dim }}>{count}</span>
    </button>
  );
}

function SurfaceFilters(props: {
  title: string;
  keys: MetricKey[];
  filters: Filters;
  setFilters: (f: Filters) => void;
  focusedMetric: MetricKey | null;
  setFocusedMetric: (m: MetricKey | null) => void;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={miniLabel}>{props.title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        {props.keys.map((key) => (
          <RangeFields key={key} metric={key} filters={props.filters} setFilters={props.setFilters} focusedMetric={props.focusedMetric} setFocusedMetric={props.setFocusedMetric} min={-0.2} max={0.2} step={0.001} />
        ))}
      </div>
    </div>
  );
}

function RangeFields({
  metric,
  filters,
  setFilters,
  focusedMetric,
  setFocusedMetric,
  min,
  max,
  step,
}: {
  metric: MetricKey;
  filters: Filters;
  setFilters: (f: Filters) => void;
  focusedMetric: MetricKey | null;
  setFocusedMetric: (m: MetricKey | null) => void;
  min: number;
  max: number;
  step: number;
}) {
  const minKey = `${metric}Min` as keyof Filters;
  const maxKey = `${metric}Max` as keyof Filters;
  const minValue = num(filters[minKey]) ?? min;
  const maxValue = num(filters[maxKey]) ?? max;
  const invalid = num(filters[minKey]) !== undefined && num(filters[maxKey]) !== undefined && minValue > maxValue;
  const set = (key: keyof Filters, value: string) => setFilters({ ...filters, [key]: value });
  return (
    <div>
      <div style={miniLabel}>{METRIC_LABELS[metric]}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <input
          data-testid={`${metric}-min`}
          value={filters[minKey]}
          onFocus={() => setFocusedMetric(metric)}
          onChange={(e) => set(minKey, e.target.value)}
          placeholder="min"
          inputMode="decimal"
          style={inputStyle({ fontSize: 11, padding: "7px 8px", borderColor: invalid ? C.red : C.stroke })}
        />
        <input
          data-testid={`${metric}-max`}
          value={filters[maxKey]}
          onFocus={() => setFocusedMetric(metric)}
          onChange={(e) => set(maxKey, e.target.value)}
          placeholder="max"
          inputMode="decimal"
          style={inputStyle({ fontSize: 11, padding: "7px 8px", borderColor: invalid ? C.red : C.stroke })}
        />
      </div>
      {focusedMetric === metric && (
        <div data-testid={`${metric}-range`} style={{ display: "grid", gap: 5, marginTop: 6 }}>
          <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, minValue))} onChange={(e) => set(minKey, e.target.value)} />
          <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, maxValue))} onChange={(e) => set(maxKey, e.target.value)} />
        </div>
      )}
      {invalid && <div style={{ fontFamily: MONO, fontSize: 10, color: C.red, marginTop: 4 }}>min must be &lt;= max</div>}
    </div>
  );
}

function AreaInfographic({ metric }: { metric: MetricKey }) {
  const positive = metric.includes("Positive");
  const negative = metric.includes("Negative");
  const camber = metric.includes("camber");
  const lower = metric.includes("lower");
  return (
    <div data-testid="area-infographic" style={{ marginTop: 12, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: 10, background: C.panel2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", color: C.dim }}>
        <SlidersHorizontal size={13} />
        {METRIC_LABELS[metric].toUpperCase()}
      </div>
      <svg viewBox="0 0 360 110" width="100%" height="110" role="img" aria-label={`${METRIC_LABELS[metric]} area highlight`} style={{ display: "block" }}>
        <line x1="18" y1="56" x2="342" y2="56" stroke="var(--aero-border-rule)" strokeWidth="1" strokeDasharray="4 4" />
        <path d="M20 56 C80 20 220 22 340 56 L340 56 C220 72 90 70 20 56 Z" fill="rgba(45,212,191,0.08)" stroke="var(--aero-dim)" />
        {!negative && !lower && !camber && <path d="M20 56 C80 20 220 22 340 56 L340 56 Z" fill="rgba(45,212,191,0.32)" />}
        {!positive && lower && <path d="M20 56 C90 70 220 72 340 56 L340 56 Z" fill="rgba(245,165,36,0.28)" />}
        {camber && <path d="M20 56 C110 46 215 46 340 56" fill="none" stroke="var(--aero-amber)" strokeWidth="3" />}
        {positive && <path d="M20 56 C90 34 225 34 340 56 L340 56 Z" fill="rgba(45,212,191,0.34)" />}
        {negative && <path d="M20 56 C90 72 220 72 340 56 L340 56 Z" fill="rgba(239,68,68,0.24)" />}
      </svg>
    </div>
  );
}

function BulkToolbar(props: {
  count: number;
  busy: boolean;
  categories: CategoryNode[];
  hashtags: HashtagDTO[];
  hashtagIds: string[];
  setHashtagIds: (ids: string[]) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onMoveTo: (categoryId: string) => void;
  onArchive: () => void;
  onRemove: () => void;
  onAssignTags: () => void;
  onRemoveTags: () => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const filteredCategories = props.categories.filter((c) => `${c.name} ${c.path}`.toLowerCase().includes(categoryQuery.toLowerCase()));
  const filteredTags = props.hashtags.filter((h) => `${h.name} ${h.slug}`.toLowerCase().includes(tagQuery.toLowerCase()));
  const selectedTagNames = props.hashtags.filter((h) => props.hashtagIds.includes(h.id)).map((h) => h.name);
  const toggleTag = (id: string) => {
    props.setHashtagIds(props.hashtagIds.includes(id) ? props.hashtagIds.filter((x) => x !== id) : [...props.hashtagIds, id]);
  };

  return (
    <div data-testid="bulk-toolbar" className="bulk-toolbar">
      <span style={{ fontFamily: MONO, fontSize: 11, color: C.teal, marginRight: 4, whiteSpace: "nowrap", flex: "0 0 auto" }}>{props.count} selected</span>
      <button type="button" disabled={props.busy} onClick={props.onSelectAll} style={toolbarBtn} aria-label="Select all" title="Select all">
        <CheckSquare size={14} /> <span className="bulk-action-label">all</span>
      </button>
      <button type="button" disabled={props.busy} onClick={props.onSelectNone} style={toolbarBtn} aria-label="Select none" title="Select none">
        <X size={14} /> <span className="bulk-action-label">none</span>
      </button>
      <span className="bulk-popover-anchor">
        <button type="button" disabled={props.busy} onClick={() => setMoveOpen((v) => !v)} style={toolbarBtn} aria-label="Move to category" title="Move to category">
          <MoveRight size={14} /> <span className="bulk-action-label">Move to</span>
        </button>
        {moveOpen && (
          <div className="bulk-popover" data-testid="bulk-move-popover">
            <input
              value={categoryQuery}
              onChange={(e) => setCategoryQuery(e.target.value)}
              autoFocus
              placeholder="search category..."
              style={inputStyle({ fontSize: 11, padding: "7px 8px", marginBottom: 8 })}
            />
            {filteredCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setMoveOpen(false);
                  props.onMoveTo(c.id);
                }}
                style={{ width: "100%", textAlign: "left", fontFamily: MONO, fontSize: 11, color: C.text, background: "transparent", border: "none", borderBottom: `1px solid ${C.borderRow}`, padding: "7px 4px", cursor: "pointer" }}
              >
                <span style={{ color: C.dim }}>{"  ".repeat(c.depth)}</span>{c.name}
              </button>
            ))}
          </div>
        )}
      </span>
      <span className="bulk-popover-anchor">
        <input
          data-testid="bulk-hashtag-search"
          className="bulk-tag-input"
          value={tagQuery}
          onChange={(e) => {
            setTagQuery(e.target.value);
            setTagOpen(true);
          }}
          onFocus={() => setTagOpen(true)}
          placeholder={selectedTagNames.length ? selectedTagNames.map((name) => `#${name}`).join(", ") : "hashtags..."}
          style={selectStyle}
        />
        {tagOpen && (
          <div className="bulk-popover" data-testid="bulk-hashtag-popover">
            {filteredTags.map((h) => {
              const on = props.hashtagIds.includes(h.id);
              return (
                <button
                  key={h.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleTag(h.id)}
                  style={{ width: "100%", display: "flex", justifyContent: "space-between", gap: 8, textAlign: "left", fontFamily: MONO, fontSize: 11, color: on ? C.teal : C.text, background: on ? C.rowActive : "transparent", border: "none", borderBottom: `1px solid ${C.borderRow}`, padding: "7px 4px", cursor: "pointer" }}
                >
                  <span>#{h.name}</span>
                  {on && <CheckSquare size={13} />}
                </button>
              );
            })}
          </div>
        )}
      </span>
      <button type="button" disabled={props.busy || props.hashtagIds.length === 0} onClick={props.onAssignTags} style={toolbarBtn}>
        <Tags size={14} /> <span className="bulk-action-label">assign</span>
      </button>
      <button type="button" disabled={props.busy || props.hashtagIds.length === 0} onClick={props.onRemoveTags} style={toolbarBtn} aria-label="Remove selected hashtags" title="Remove selected hashtags">
        <Tags size={14} /> <span className="bulk-action-label">untag</span>
      </button>
      <button type="button" disabled={props.busy} onClick={props.onArchive} style={toolbarBtn} aria-label="Archive selected airfoils" title="Archive">
        <Archive size={14} /> <span className="bulk-action-label">archive</span>
      </button>
      <button type="button" disabled={props.busy} onClick={props.onRemove} style={{ ...toolbarBtn, color: C.red }} aria-label="Remove selected airfoils" title="Remove">
        <Trash2 size={14} /> <span className="bulk-action-label">remove</span>
      </button>
    </div>
  );
}

function PreviewPane({ slug, summary }: { slug: string; summary?: AirfoilSummary }) {
  const [detail, setDetail] = useState<AirfoilDetailPayload | null>(null);
  useEffect(() => {
    if (!slug) {
      setDetail(null);
      return;
    }
    let cancel = false;
    getAirfoilDetail(slug).then((d) => !cancel && setDetail(d));
    return () => {
      cancel = true;
    };
  }, [slug]);

  if (!detail) {
    return (
    <div className="browse-preview" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, fontFamily: MONO, fontSize: 12, color: C.dim }}>
        hover a row...
      </div>
    );
  }
  const { profilePath, camberPath } = profilePaths(detail.geometry);
  const acceptedPointCount = summary?.polarCount ?? detail.polars.reduce((count, polar) => count + polar.points.length, 0);
  const mrows: [string, string][] = [
    ["(L/D)max", solvedMetric(summary?.ldmax, 1)],
    ["Cd,min", solvedMetric(summary?.cdmin, 4)],
    ["Cl,max", solvedMetric(summary?.clmax, 2)],
    ["accepted points", String(acceptedPointCount)],
    ["Area", detail.geometry.areaProfile.toFixed(4)],
  ];
  return (
    <div className="browse-preview" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "11px 14px", borderBottom: `1px solid ${C.borderSoft}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{detail.name}</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
            {acceptedPointCount > 0 ? `best-fit ${summary?.fitStatus ?? "polar"}` : "no fitted polar"}
          </span>
        </div>
        {detail.hashtags.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 7 }}>
            {detail.hashtags.map((h) => (
              <span key={h.id} style={{ fontFamily: MONO, fontSize: 10, color: C.teal, border: `1px solid ${C.tealBorder}`, borderRadius: 5, padding: "2px 5px" }}>
                #{h.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: "8px 12px 4px" }}>
        <svg width="100%" viewBox="0 0 340 150" style={{ display: "block" }}>
          <line x1="14" y1="80" x2="326" y2="80" style={{ stroke: C.borderRule }} strokeWidth="1" strokeDasharray="3 4" />
          <path d={profilePath} fill="rgba(45,212,191,0.10)" style={{ stroke: C.teal }} strokeWidth="1.6" strokeLinejoin="round" />
          <path d={camberPath} fill="none" style={{ stroke: C.amber }} strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
        </svg>
      </div>
      <div style={{ padding: "4px 14px 12px" }}>
        {mrows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11, padding: "5px 0", borderBottom: `1px solid ${C.borderRow}` }}>
            <span style={{ color: C.muted }}>{k}</span>
            <span style={{ color: C.text }}>{v}</span>
          </div>
        ))}
        <Link href={`/airfoils/${detail.slug}`} style={{ display: "block", marginTop: 12, textAlign: "center", fontFamily: MONO, fontSize: 12, color: C.tealInk, background: C.teal, borderRadius: 8, padding: "9px 0", fontWeight: 600 }}>
          View detail &amp; simulate
        </Link>
      </div>
    </div>
  );
}

const miniLabel = { fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", color: C.dim, marginBottom: 6 };
const checkBtn = { width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", color: C.teal, background: "transparent", border: "none", cursor: "pointer", padding: 0 };
const toolbarBtn = { display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 11, color: C.muted, background: C.panel3, border: `1px solid ${C.stroke}`, borderRadius: 7, padding: "6px 9px", cursor: "pointer" };
const smallButton = { fontFamily: MONO, fontSize: 11, color: C.teal, background: C.panel3, border: `1px solid ${C.tealBorder}`, borderRadius: 7, padding: "6px 12px", cursor: "pointer" };
const selectStyle = { fontFamily: MONO, fontSize: 11, color: C.text, background: C.panel2, border: `1px solid ${C.stroke}`, borderRadius: 7, padding: "6px 8px", outline: "none" };

function inputStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    width: "100%",
    fontFamily: MONO,
    fontSize: 12,
    color: C.text,
    background: C.panel,
    border: `1px solid ${C.stroke}`,
    borderRadius: 8,
    padding: "9px 12px",
    outline: "none",
    ...extra,
  };
}

function iconBtn(active: boolean): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: active ? C.teal : C.muted,
    background: active ? C.tealFill : C.panel,
    border: `1px solid ${active ? C.tealBorder : C.stroke}`,
    borderRadius: 8,
    cursor: "pointer",
  };
}

function sortButton(numCol: boolean, active: boolean): React.CSSProperties {
  return {
    textAlign: numCol ? "right" : "left",
    background: "none",
    border: "none",
    cursor: "pointer",
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: "0.06em",
    color: active ? C.teal : C.dim,
    padding: 0,
  };
}

function pillBtn(active: boolean): React.CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 10,
    color: active ? C.tealInk : C.teal,
    background: active ? C.teal : C.tealFill,
    border: `1px solid ${C.tealBorder}`,
    borderRadius: 6,
    padding: "5px 7px",
    cursor: "pointer",
  };
}
