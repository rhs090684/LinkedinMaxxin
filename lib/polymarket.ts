// HTTP clients for Polymarket's three public, no-auth APIs.
//
// Gamma  https://gamma-api.polymarket.com  -> events/markets metadata (sports)
// CLOB   https://clob.polymarket.com       -> order books, price history
// Data   https://data-api.polymarket.com   -> recent taker trades (orderflow)

import type { Market, OrderBook, Trade } from "./types";
import { marketFromGamma, orderBookFromClob, tradeFromDataApi } from "./parse";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const DATA_BASE = "https://data-api.polymarket.com";

async function getJson(url: string, timeoutMs = 6_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "polymarket-trade-ideas/0.2" },
      cache: "no-store",
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} for ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function getSportsEvents(
  tagSlug = "sports",
  limit = 25
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  let offset = 0;
  const page = Math.min(limit, 100);
  while (events.length < limit) {
    const params = new URLSearchParams({
      tag_slug: tagSlug,
      closed: "false",
      active: "true",
      order: "volume24hr",
      ascending: "false",
      limit: String(page),
      offset: String(offset),
    });
    const batch = (await getJson(`${GAMMA_BASE}/events?${params}`)) as unknown;
    if (!Array.isArray(batch) || batch.length === 0) break;
    events.push(...(batch as Record<string, unknown>[]));
    if (batch.length < page) break;
    offset += page;
  }
  return events.slice(0, limit);
}

export async function getMarkets(
  tagSlug = "sports",
  limit = 25
): Promise<Market[]> {
  const events = await getSportsEvents(tagSlug, limit);
  const markets: Market[] = [];
  for (const event of events) {
    const title = String(event.title ?? "");
    const tags = ((event.tags as Record<string, unknown>[]) ?? [])
      .filter((t) => t && typeof t === "object")
      .map((t) => String(t.slug ?? ""));
    for (const raw of (event.markets as Record<string, unknown>[]) ?? []) {
      if (raw.closed || raw.archived) continue;
      if (raw.enableOrderBook === false) continue;
      const market = marketFromGamma(raw, title, tags);
      if (market) markets.push(market);
    }
  }
  return markets;
}

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const raw = (await getJson(
    `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`
  )) as Record<string, unknown>;
  return orderBookFromClob(raw);
}

export async function getPriceHistory(
  tokenId: string,
  interval = "1d",
  fidelity = 30
): Promise<[number, number][]> {
  try {
    const params = new URLSearchParams({
      market: tokenId,
      interval,
      fidelity: String(fidelity),
    });
    const raw = (await getJson(
      `${CLOB_BASE}/prices-history?${params}`
    )) as Record<string, unknown>;
    const history = (raw.history as Record<string, unknown>[]) ?? [];
    return history
      .filter((p) => "t" in p && "p" in p)
      .map((p) => [Number(p.t), Number(p.p)] as [number, number]);
  } catch {
    return [];
  }
}

export async function getTrades(
  conditionId: string,
  limit = 500
): Promise<Trade[]> {
  try {
    const params = new URLSearchParams({
      market: conditionId,
      limit: String(Math.min(limit, 500)),
      takerOnly: "true",
    });
    const raw = (await getJson(`${DATA_BASE}/trades?${params}`)) as unknown;
    if (!Array.isArray(raw)) return [];
    const trades: Trade[] = [];
    for (const item of raw as Record<string, unknown>[]) {
      const t = tradeFromDataApi(item);
      if (t) trades.push(t);
    }
    return trades;
  } catch {
    return [];
  }
}

// Simple concurrency pool so a full scan doesn't fire N requests at once.
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
