// Orchestrates a full scan: fetch markets, compute metrics, generate ideas.

import type { ScanResult, TradeIdea } from "./types";
import { computeLiquidity, computeFlow } from "./metrics";
import { generateIdeas, rankIdeas } from "./ideas";
import {
  getMarkets,
  getOrderBook,
  getPriceHistory,
  getTrades,
  mapPool,
} from "./polymarket";
import { mockUniverse } from "./mock";

const DISCLAIMER =
  "Ideas rank orderflow/liquidity setups only - they do not model teams, injuries, or news, and are not financial advice.";

export interface ScanOptions {
  tag?: string;
  events?: number;
  markets?: number;
  windowHours?: number;
  minVolume?: number;
  minScore?: number;
  top?: number;
  concurrency?: number;
  // Wall-clock budget (ms) for the whole live scan. Kept under the Vercel
  // function limit so we return partial results instead of a 504 timeout.
  budgetMs?: number;
}

export async function scanLive(opts: ScanOptions = {}): Promise<ScanResult> {
  const tag = opts.tag ?? "sports";
  const events = opts.events ?? 20;
  const maxMarkets = opts.markets ?? 10;
  const windowHours = opts.windowHours ?? 24;
  const minVolume = opts.minVolume ?? 1_000;
  const minScore = opts.minScore ?? 30;
  const top = opts.top ?? 20;
  // Scan every selected market in one parallel batch by default.
  const concurrency = opts.concurrency ?? maxMarkets;
  const budgetMs = opts.budgetMs ?? 8_000;

  const deadline = Date.now() + budgetMs;
  const errors: string[] = [];
  let markets = await getMarkets(tag, events);
  markets = markets
    .filter((m) => m.volume24h >= minVolume)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, maxMarkets);

  let scanned = 0;
  const perMarket = await mapPool(markets, concurrency, async (market) => {
    // Skip markets we can no longer finish before the function is killed.
    if (Date.now() > deadline) return [] as TradeIdea[];
    const token0 = market.clobTokenIds[0];
    try {
      const [book, trades, history] = await Promise.all([
        getOrderBook(token0),
        getTrades(market.conditionId),
        getPriceHistory(token0),
      ]);
      scanned++;
      const liq = computeLiquidity(book);
      const flow = computeFlow(trades, token0, {
        windowHours,
        priceHistory: history,
      });
      return generateIdeas(market, liq, flow);
    } catch (e) {
      errors.push(`${market.slug}: ${(e as Error).message}`);
      return [] as TradeIdea[];
    }
  });

  const ideas = rankIdeas(perMarket.flat(), minScore, top);
  return {
    generatedAt: new Date().toISOString(),
    marketsScanned: scanned,
    source: "live",
    disclaimer: DISCLAIMER,
    ideas,
    errors: errors.length ? errors : undefined,
  };
}

export function scanMock(opts: ScanOptions = {}): ScanResult {
  const windowHours = opts.windowHours ?? 24;
  const minVolume = opts.minVolume ?? 1_000;
  const minScore = opts.minScore ?? 30;
  const top = opts.top ?? 20;

  const universe = mockUniverse();
  const all: TradeIdea[] = [];
  for (const entry of universe) {
    if (entry.market.volume24h < minVolume) continue;
    const liq = computeLiquidity(entry.book);
    const flow = computeFlow(entry.trades, entry.market.clobTokenIds[0], {
      windowHours,
    });
    all.push(...generateIdeas(entry.market, liq, flow));
  }
  return {
    generatedAt: new Date().toISOString(),
    marketsScanned: universe.length,
    source: "mock",
    disclaimer: DISCLAIMER,
    ideas: rankIdeas(all, minScore, top),
  };
}
