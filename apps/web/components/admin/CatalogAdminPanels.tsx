"use client";

import type { CategoryNode, HashtagDTO } from "@aerodb/core";
import { Check, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  createAdminCategory,
  createAdminHashtag,
  deleteAdminCategory,
  deleteAdminHashtag,
  getAdminCategoryTree,
  getAdminHashtags,
  reorderAdminCategory,
  updateAdminCategory,
  updateAdminHashtag,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

type DropPosition = "before" | "inside" | "after";

export function CategoriesAdminPanel() {
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [editName, setEditName] = useState("");
  const [editParent, setEditParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newNameError, setNewNameError] = useState("");
  const [editNameError, setEditNameError] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string; position: DropPosition } | null>(null);
  const newNameRef = useRef<HTMLInputElement | null>(null);
  const editNameRef = useRef<HTMLInputElement | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  const rows = useMemo(() => flatten(tree), [tree]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const refresh = async () => setTree(await getAdminCategoryTree());

  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    if (selected) {
      setEditNameError("");
      setEditName(selected.name);
      const parentPath = selected.path.split("/").slice(0, -1).join("/");
      setEditParent(rows.find((r) => r.path === parentPath)?.id ?? "");
    }
  }, [selected, rows]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createCategory = () => {
    if (!newName.trim()) {
      setNewNameError("Name is required");
      newNameRef.current?.focus();
      return;
    }
    setNewNameError("");
    act(async () => {
      await createAdminCategory({ name: newName, parentId: newParent || null });
      setNewName("");
      setNewParent("");
    });
  };

  const saveCategory = () => {
    if (!selected) return;
    if (!editName.trim()) {
      setEditNameError("Name is required");
      editNameRef.current?.focus();
      return;
    }
    setEditNameError("");
    act(() => updateAdminCategory(selected.id, { name: editName, parentId: editParent || null }));
  };

  const dropPosition = (event: React.DragEvent<HTMLElement>): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    if (y < rect.height * 0.4) return "before";
    if (y > rect.height * 0.6) return "after";
    return "inside";
  };

  const canDropOn = (dragId: string, target: CategoryNode) => {
    const dragged = rows.find((r) => r.id === dragId);
    return !!dragged && dragged.id !== target.id && !target.path.startsWith(dragged.path + "/");
  };

  const onDropCategory = async (target: CategoryNode, position: DropPosition, event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const dragId = draggedIdRef.current ?? draggedId ?? event.dataTransfer.getData("text/plain");
    const resolvedPosition = dropHint?.targetId === target.id ? dropHint.position : position;
    draggedIdRef.current = null;
    setDraggedId(null);
    setDropHint(null);
    if (!dragId || !canDropOn(dragId, target)) return;
    setSelectedId(dragId);
    await act(() => reorderAdminCategory({ draggedId: dragId, targetId: target.id, position: resolvedPosition }));
  };

  return (
    <div>
      <SectionHeader title="Categories" subtitle="Create, rename, remove, and move catalog branches." />
      {err && <ErrorLine text={err} />}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 1fr) 360px", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <div style={{ ...label, display: "flex", justifyContent: "space-between", gap: 10 }}>
            <span>TREE</span>
            <span style={{ color: draggedId ? C.teal : C.dimmest }}>{draggedId ? "drop before · inside · after" : "drag to reorder"}</span>
          </div>
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              draggable={!busy}
              data-testid={`admin-category-${r.slug}`}
              aria-grabbed={draggedId === r.id}
              onClick={() => setSelectedId(r.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", r.id);
                draggedIdRef.current = r.id;
                setDraggedId(r.id);
                setDropHint(null);
              }}
              onDragEnd={() => {
                window.setTimeout(() => {
                  draggedIdRef.current = null;
                  setDraggedId(null);
                  setDropHint(null);
                }, 0);
              }}
              onDragOver={(event) => {
                const dragId = draggedId ?? event.dataTransfer.getData("text/plain");
                if (!dragId || !canDropOn(dragId, r)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropHint({ targetId: r.id, position: dropPosition(event) });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropHint(null);
              }}
              onDrop={(event) => onDropCategory(r, dropPosition(event), event)}
              style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "18px 1fr auto",
                gap: 8,
                alignItems: "center",
                textAlign: "left",
                fontFamily: MONO,
                fontSize: 12,
                color: selectedId === r.id ? C.teal : C.muted,
                background: selectedId === r.id ? C.rowActive : "transparent",
                border: `1px solid ${
                  dropHint?.targetId === r.id ? C.tealBorder : selectedId === r.id ? C.tealBorder : "transparent"
                }`,
                boxShadow: dropHint?.targetId === r.id && dropHint.position === "inside" ? `inset 0 0 0 1px ${C.tealBorder}` : "none",
                borderRadius: 7,
                padding: `8px 10px 8px ${10 + r.depth * 16}px`,
                cursor: "pointer",
                opacity: draggedId === r.id ? 0.52 : 1,
                position: "relative",
              }}
            >
              {dropHint?.targetId === r.id && dropHint.position !== "inside" && (
                <span
                  style={{
                    position: "absolute",
                    left: 8 + r.depth * 16,
                    right: 8,
                    height: 2,
                    top: dropHint.position === "before" ? 1 : "auto",
                    bottom: dropHint.position === "after" ? 1 : "auto",
                    background: C.teal,
                    borderRadius: 999,
                  }}
                />
              )}
              <GripVertical size={14} color={C.dim} aria-hidden />
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                {dropHint?.targetId === r.id && (
                  <span style={{ fontSize: 9, color: C.teal, border: `1px solid ${C.tealBorder}`, borderRadius: 4, padding: "1px 5px" }}>
                    {dropHint.position}
                  </span>
                )}
              </span>
              <span style={{ color: C.dim }}>{r.directAirfoilCount}/{r.airfoilCount}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={card}>
            <div style={label}>CREATE</div>
            <input ref={newNameRef} data-testid="new-category-name" value={newName} onChange={(e) => { setNewName(e.target.value); if (newNameError) setNewNameError(e.target.value.trim() ? "" : newNameError); }} placeholder="category name" aria-invalid={!!newNameError} style={{ ...input, borderColor: newNameError ? C.red : C.stroke }} />
            {newNameError && <InlineError text={newNameError} />}
            <select data-testid="new-category-parent" value={newParent} onChange={(e) => setNewParent(e.target.value)} style={{ ...input, marginTop: 8 }}>
              <option value="">root category</option>
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {"  ".repeat(r.depth)}
                  {r.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={createCategory}
              style={{ ...primaryBtn, marginTop: 10, width: "100%" }}
            >
              <Plus size={14} /> create category
            </button>
          </div>

          <div style={card}>
            <div style={label}>EDIT</div>
            {!selected ? (
              <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>Select a category.</div>
            ) : (
              <>
                <input ref={editNameRef} data-testid="edit-category-name" value={editName} onChange={(e) => { setEditName(e.target.value); if (editNameError) setEditNameError(e.target.value.trim() ? "" : editNameError); }} aria-invalid={!!editNameError} style={{ ...input, borderColor: editNameError ? C.red : C.stroke }} />
                {editNameError && <InlineError text={editNameError} />}
                <select data-testid="edit-category-parent" value={editParent} onChange={(e) => setEditParent(e.target.value)} style={{ ...input, marginTop: 8 }}>
                  <option value="">root category</option>
                  {rows
                    .filter((r) => r.id !== selected.id && !r.path.startsWith(selected.path + "/"))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {"  ".repeat(r.depth)}
                        {r.name}
                      </option>
                    ))}
                </select>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button type="button" disabled={busy} onClick={saveCategory} style={primaryBtn}>
                    <Check size={14} /> save
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => window.confirm(`Delete ${selected.name}?`) && act(() => deleteAdminCategory(selected.id))}
                    style={{ ...ghostBtn, color: C.red }}
                  >
                    <Trash2 size={14} /> delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function HashtagsAdminPanel() {
  const [items, setItems] = useState<HashtagDTO[]>([]);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newNameError, setNewNameError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const newNameRef = useRef<HTMLInputElement | null>(null);

  const refresh = async () => setItems((await getAdminHashtags()).items);
  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createHashtag = () => {
    if (!newName.trim()) {
      setNewNameError("Name is required");
      newNameRef.current?.focus();
      return;
    }
    setNewNameError("");
    act(async () => {
      await createAdminHashtag(newName);
      setNewName("");
    });
  };

  const saveHashtag = (item: HashtagDTO) => {
    const next = editing[item.id] ?? item.name;
    if (!next.trim()) {
      setRowErrors((current) => ({ ...current, [item.id]: "Name is required" }));
      window.setTimeout(() => document.querySelector<HTMLInputElement>(`[data-testid="hashtag-name-${item.slug}"]`)?.focus(), 0);
      return;
    }
    setRowErrors((current) => {
      const copy = { ...current };
      delete copy[item.id];
      return copy;
    });
    act(() => updateAdminHashtag(item.id, next));
  };

  return (
    <div>
      <SectionHeader title="Hashtags" subtitle="Managed hashtag vocabulary for profiles and filters." />
      {err && <ErrorLine text={err} />}
      <div style={{ display: "grid", gridTemplateColumns: "360px minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <div style={label}>ADD HASHTAG</div>
          <input ref={newNameRef} data-testid="new-hashtag-name" value={newName} onChange={(e) => { setNewName(e.target.value); if (newNameError) setNewNameError(e.target.value.trim() ? "" : newNameError); }} placeholder="hashtag name" aria-invalid={!!newNameError} style={{ ...input, borderColor: newNameError ? C.red : C.stroke }} />
          {newNameError && <InlineError text={newNameError} />}
          <button
            type="button"
            disabled={busy}
            onClick={createHashtag}
            style={{ ...primaryBtn, marginTop: 10, width: "100%" }}
          >
            <Plus size={14} /> add hashtag
          </button>
        </div>
        <div style={{ ...card, padding: 0 }}>
          <div style={{ ...label, padding: "14px 16px 0" }}>HASHTAGS</div>
          {items.map((h) => (
            <div key={h.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "start", padding: "10px 16px", borderTop: `1px solid ${C.borderRow}` }}>
              <div>
                <input
                  data-testid={`hashtag-name-${h.slug}`}
                  value={editing[h.id] ?? h.name}
                  onChange={(e) => {
                    setEditing((old) => ({ ...old, [h.id]: e.target.value }));
                    if (rowErrors[h.id] && e.target.value.trim()) {
                      setRowErrors((current) => {
                        const copy = { ...current };
                        delete copy[h.id];
                        return copy;
                      });
                    }
                  }}
                  aria-invalid={!!rowErrors[h.id]}
                  style={{ ...input, borderColor: rowErrors[h.id] ? C.red : C.stroke }}
                />
                {rowErrors[h.id] && <InlineError text={rowErrors[h.id]} />}
              </div>
              <button type="button" disabled={busy} onClick={() => saveHashtag(h)} style={ghostBtn}>
                <Pencil size={14} /> save
              </button>
              <button type="button" disabled={busy} onClick={() => window.confirm(`Delete #${h.name}?`) && act(() => deleteAdminHashtag(h.id))} style={{ ...ghostBtn, color: C.red }}>
                <Trash2 size={14} /> delete
              </button>
            </div>
          ))}
          {items.length === 0 && <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim, padding: 16 }}>No hashtags yet.</div>}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>{title}</h2>
      <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginTop: 4 }}>{subtitle}</div>
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 12 }}>{text}</div>;
}

function InlineError({ text }: { text: string }) {
  return <div role="alert" style={{ fontFamily: MONO, fontSize: 10, color: C.red, marginTop: 4 }}>{text}</div>;
}

const card: React.CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 };
const label: React.CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim, marginBottom: 8 };
const input: React.CSSProperties = {
  width: "100%",
  fontFamily: MONO,
  fontSize: 12,
  color: C.text,
  background: C.panel2,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "8px 10px",
  outline: "none",
};
const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 600,
  color: C.tealInk,
  background: C.teal,
  border: `1px solid ${C.teal}`,
  borderRadius: 7,
  padding: "8px 12px",
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  fontFamily: MONO,
  fontSize: 11,
  color: C.muted,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "7px 10px",
  cursor: "pointer",
};
