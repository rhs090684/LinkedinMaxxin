// Parsing helpers that turn raw Polymarket API payloads into typed objects.

import type { Market, OrderBook, Trade, BookLevel } from "./types";

export function asFloat(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

// Gamma returns list fields either as real arrays or JSON-encoded strings.
export function asJsonList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function marketFromGamma(
  raw: Record<string, unknown>,
  eventTitle = "",
  tags: string[] = []
): Market | null {
  const tokenIds = asJsonList(raw.clobTokenIds).map((t) => String(t));
  const outcomes = asJsonList(raw.outcomes).map((o) => String(o));
  if (tokenIds.length < 2 || outcomes.length < 2) return null;
  const prices = asJsonList(raw.outcomePrices).map((p) => asFloat(p));
  const question = String(raw.question ?? "");
  return {
    conditionId: String(raw.conditionId ?? ""),
    question,
    slug: String(raw.slug ?? ""),
    eventTitle: eventTitle || question,
    outcomes,
    outcomePrices: prices,
    clobTokenIds: tokenIds,
    volume24h: asFloat(raw.volume24hr),
    liquidity: asFloat(raw.liquidity ?? raw.liquidityNum),
    endDate: String(raw.endDate ?? ""),
    tags,
  };
}

export function orderBookFromClob(raw: Record<string, unknown>): OrderBook {
  const levels = (key: string): BookLevel[] => {
    const out: BookLevel[] = [];
    for (const lvl of (raw[key] as Record<string, unknown>[]) ?? []) {
      const price = asFloat(lvl.price);
      const size = asFloat(lvl.size);
      if (price > 0 && size > 0) out.push({ price, size });
    }
    return out;
  };
  const bids = levels("bids").sort((a, b) => b.price - a.price);
  const asks = levels("asks").sort((a, b) => a.price - b.price);
  return { tokenId: String(raw.asset_id ?? ""), bids, asks };
}

export function tradeFromDataApi(raw: Record<string, unknown>): Trade | null {
  const side = String(raw.side ?? "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") return null;
  const price = asFloat(raw.price);
  const size = asFloat(raw.size);
  if (price <= 0 || size <= 0) return null;
  return {
    assetId: String(raw.asset ?? ""),
    side: side as "BUY" | "SELL",
    price,
    size,
    timestamp: Math.trunc(asFloat(raw.timestamp)),
    wallet: String(raw.proxyWallet ?? ""),
    outcome: String(raw.outcome ?? ""),
  };
}

// Order-book derived helpers
export function bestBid(book: OrderBook): number | null {
  return book.bids.length ? book.bids[0].price : null;
}
export function bestAsk(book: OrderBook): number | null {
  return book.asks.length ? book.asks[0].price : null;
}
export function mid(book: OrderBook): number | null {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (b !== null && a !== null) return (b + a) / 2;
  return b !== null ? b : a;
}
export function spread(book: OrderBook): number | null {
  const b = bestBid(book);
  const a = bestAsk(book);
  return b !== null && a !== null ? a - b : null;
}
