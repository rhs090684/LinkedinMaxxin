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
}

export async function scanLive(opts: ScanOptions = {}): Promise<ScanResult> {
  const tag = opts.tag ?? "sports";
  const events = opts.events ?? 25;
  const maxMarkets = opts.markets ?? 18;
  const windowHours = opts.windowHours ?? 24;
  const minVolume = opts.minVolume ?? 1_000;
  const minScore = opts.minScore ?? 30;
  const top = opts.top ?? 20;
  const concurrency = opts.concurrency ?? 6;

  const errors: string[] = [];
  let markets = await getMarkets(tag, events);
  markets = markets
    .filter((m) => m.volume24h >= minVolume)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, maxMarkets);

  const perMarket = await mapPool(markets, concurrency, async (market) => {
    const token0 = market.clobTokenIds[0];
    try {
      const [book, trades, history] = await Promise.all([
        getOrderBook(token0),
        getTrades(market.conditionId),
        getPriceHistory(token0),
      ]);
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
    marketsScanned: markets.length,
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
