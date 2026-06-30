import type { HashtagDTO } from "@aerodb/core";
import { airfoilHashtags, hashtags } from "@aerodb/db";
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "../db";

export function slugifyHashtag(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tag"
  );
}

export function toHashtagDTO(row: { id: string; slug: string; name: string }): HashtagDTO {
  return { id: row.id, slug: row.slug, name: row.name };
}

export async function listHashtags(): Promise<HashtagDTO[]> {
  const rows = await db.select({ id: hashtags.id, slug: hashtags.slug, name: hashtags.name }).from(hashtags).orderBy(asc(hashtags.name));
  return rows.map(toHashtagDTO);
}

export async function ensureHashtags(names: string[]): Promise<HashtagDTO[]> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const out: HashtagDTO[] = [];
  for (const name of clean) {
    const [row] = await db
      .insert(hashtags)
      .values({ slug: slugifyHashtag(name), name })
      .onConflictDoUpdate({ target: hashtags.slug, set: { name } })
      .returning({ id: hashtags.id, slug: hashtags.slug, name: hashtags.name });
    out.push(toHashtagDTO(row));
  }
  return out;
}

export async function syncAirfoilHashtagNames(airfoilId: string, names: string[]): Promise<HashtagDTO[]> {
  const rows = await ensureHashtags(names);
  await db.delete(airfoilHashtags).where(eq(airfoilHashtags.airfoilId, airfoilId));
  for (const row of rows) {
    await db.insert(airfoilHashtags).values({ airfoilId, hashtagId: row.id }).onConflictDoNothing();
  }
  return rows;
}

export async function hashtagsByAirfoilIds(ids: string[]): Promise<Map<string, HashtagDTO[]>> {
  const map = new Map<string, HashtagDTO[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      airfoilId: airfoilHashtags.airfoilId,
      id: hashtags.id,
      slug: hashtags.slug,
      name: hashtags.name,
    })
    .from(airfoilHashtags)
    .innerJoin(hashtags, eq(airfoilHashtags.hashtagId, hashtags.id))
    .where(inArray(airfoilHashtags.airfoilId, ids))
    .orderBy(asc(hashtags.name));
  for (const row of rows) {
    const list = map.get(row.airfoilId) ?? [];
    list.push(toHashtagDTO(row));
    map.set(row.airfoilId, list);
  }
  return map;
}
