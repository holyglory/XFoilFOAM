import { desc, inArray } from "drizzle-orm";

import type { DB } from "./client";
import { simCampaigns } from "./schema";
import {
  campaignOpenTierCounts,
  campaignReviewBucketRows,
  type CampaignReviewBucketRow,
  type CampaignTierCounts,
} from "./urans-ladder";

export interface StaleWhileRefreshValue<T> {
  value: T;
  asOf: Date;
  stale: boolean;
  refreshing: boolean;
  lastError: string | null;
}

interface CacheEntry<T> {
  value?: T;
  asOfMs?: number;
  lastAccessMs: number;
  refreshPromise?: Promise<T>;
  lastError: string | null;
}

export interface StaleWhileRefreshStats {
  hits: number;
  misses: number;
  staleHits: number;
  refreshes: number;
  size: number;
}

/** Small deterministic single-flight cache used by expensive polled read
 * models. A stale value returns immediately while exactly one refresh runs;
 * refresh failure preserves the last truthful value instead of replacing it
 * with invented zeros. */
export class StaleWhileRefreshCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private staleHits = 0;
  private refreshes = 0;

  constructor(
    private readonly options: {
      ttlMs: number;
      maxEntries: number;
      now?: () => number;
    },
  ) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
      throw new Error("cache ttlMs must be positive");
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0)
      throw new Error("cache maxEntries must be a positive integer");
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(protectedKey: string): void {
    while (this.entries.size > this.options.maxEntries) {
      const candidate = [...this.entries.entries()]
        .filter(([key, entry]) => key !== protectedKey && !entry.refreshPromise)
        .sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs)[0];
      if (!candidate) return;
      this.entries.delete(candidate[0]);
    }
  }

  private startRefresh(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const entry = this.entries.get(key) ?? {
      lastAccessMs: now,
      lastError: null,
    };
    entry.lastAccessMs = now;
    if (entry.refreshPromise) return entry.refreshPromise;
    this.refreshes += 1;
    const refreshPromise = load()
      .then((value) => {
        entry.value = value;
        entry.asOfMs = this.now();
        entry.lastAccessMs = entry.asOfMs;
        entry.lastError = null;
        entry.refreshPromise = undefined;
        this.entries.set(key, entry);
        this.prune(key);
        return value;
      })
      .catch((error: unknown) => {
        entry.lastError =
          error instanceof Error ? error.message : String(error);
        entry.refreshPromise = undefined;
        if (entry.value === undefined) this.entries.delete(key);
        throw error;
      });
    entry.refreshPromise = refreshPromise;
    this.entries.set(key, entry);
    this.prune(key);
    return refreshPromise;
  }

  async get(
    key: string,
    load: () => Promise<T>,
  ): Promise<StaleWhileRefreshValue<T>> {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry?.value !== undefined && entry.asOfMs !== undefined) {
      this.hits += 1;
      entry.lastAccessMs = now;
      const stale = now - entry.asOfMs >= this.options.ttlMs;
      if (stale) {
        this.staleHits += 1;
        void this.startRefresh(key, load).catch(() => undefined);
      }
      return {
        value: entry.value,
        asOf: new Date(entry.asOfMs),
        stale,
        refreshing: Boolean(entry.refreshPromise),
        lastError: entry.lastError,
      };
    }
    this.misses += 1;
    const value = await this.startRefresh(key, load);
    const refreshed = this.entries.get(key);
    return {
      value,
      asOf: new Date(refreshed?.asOfMs ?? this.now()),
      stale: false,
      refreshing: false,
      lastError: null,
    };
  }

  async warm(key: string, load: () => Promise<T>): Promise<void> {
    const entry = this.entries.get(key);
    const now = this.now();
    if (
      entry?.value !== undefined &&
      entry.asOfMs !== undefined &&
      now - entry.asOfMs < this.options.ttlMs
    )
      return;
    await this.startRefresh(key, load);
  }

  async waitForRefresh(key: string): Promise<void> {
    await this.entries.get(key)?.refreshPromise;
  }

  has(key: string): boolean {
    return this.entries.get(key)?.value !== undefined;
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.staleHits = 0;
    this.refreshes = 0;
  }

  stats(): StaleWhileRefreshStats {
    return {
      hits: this.hits,
      misses: this.misses,
      staleHits: this.staleHits,
      refreshes: this.refreshes,
      size: this.entries.size,
    };
  }
}

export interface CampaignDerivedSummaryMetrics {
  tierCounts: CampaignTierCounts;
  reviewBucketRows: CampaignReviewBucketRow[];
}

const CAMPAIGN_DERIVED_METRICS_TTL_MS = 15_000;
const campaignDerivedMetricsCache =
  new StaleWhileRefreshCache<CampaignDerivedSummaryMetrics>({
    ttlMs: CAMPAIGN_DERIVED_METRICS_TTL_MS,
    maxEntries: 100,
  });

async function loadCampaignDerivedSummaryMetrics(
  db: DB,
  campaignId: string,
): Promise<CampaignDerivedSummaryMetrics> {
  const [tierCounts, reviewBucketRows] = await Promise.all([
    campaignOpenTierCounts(db, campaignId),
    campaignReviewBucketRows(db, campaignId),
  ]);
  return { tierCounts, reviewBucketRows };
}

export async function readCampaignDerivedSummaryMetrics(
  db: DB,
  campaignId: string,
  conditionGeneration: number,
): Promise<StaleWhileRefreshValue<CampaignDerivedSummaryMetrics>> {
  if (process.env.NODE_ENV === "test") {
    return {
      value: await loadCampaignDerivedSummaryMetrics(db, campaignId),
      asOf: new Date(),
      stale: false,
      refreshing: false,
      lastError: null,
    };
  }
  const cacheKey = `${campaignId}:${conditionGeneration}`;
  return campaignDerivedMetricsCache.get(cacheKey, () =>
    loadCampaignDerivedSummaryMetrics(db, campaignId),
  );
}

/** Warm the bounded set of operator-relevant campaigns before the production
 * API begins accepting traffic. Tests and development skip this startup hook
 * so parallel fixture campaigns cannot leak into one another. */
export async function warmActiveCampaignDerivedSummaryMetrics(
  db: DB,
  limit = 8,
): Promise<number> {
  const campaigns = await db
    .select({
      id: simCampaigns.id,
      conditionGeneration: simCampaigns.currentConditionGeneration,
    })
    .from(simCampaigns)
    .where(inArray(simCampaigns.status, ["active", "attention"]))
    .orderBy(desc(simCampaigns.priority), simCampaigns.createdAt)
    .limit(Math.max(1, Math.min(100, Math.trunc(limit))));
  let cursor = 0;
  const worker = async () => {
    while (cursor < campaigns.length) {
      const campaign = campaigns[cursor++];
      if (!campaign) return;
      await campaignDerivedMetricsCache.warm(
        `${campaign.id}:${campaign.conditionGeneration}`,
        () => loadCampaignDerivedSummaryMetrics(db, campaign.id),
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(2, campaigns.length) }, () => worker()),
  );
  return campaigns.length;
}

export function resetCampaignDerivedSummaryMetricsCacheForTests(): void {
  campaignDerivedMetricsCache.clear();
}

export function campaignDerivedSummaryMetricsCacheStats(): StaleWhileRefreshStats {
  return campaignDerivedMetricsCache.stats();
}
