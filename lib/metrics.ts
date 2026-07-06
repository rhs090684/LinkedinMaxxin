// Liquidity and orderflow metrics computed from books and trades.
//
// All directional metrics are normalized to the market's FIRST outcome token
// (token0). A taker BUY of token1 is economically a SELL of token0, so it
// counts as negative flow.

import type { OrderBook, Trade, LiquidityMetrics, FlowMetrics } from "./types";
import { bestBid, bestAsk, mid, spread } from "./parse";

export const WHALE_TRADE_USD = 500;

export function computeLiquidity(book: OrderBook, band = 0.05): LiquidityMetrics {
  const m = mid(book);
  const base: LiquidityMetrics = {
    bestBid: bestBid(book),
    bestAsk: bestAsk(book),
    mid: m,
    spread: spread(book),
    bidDepthUsd5c: 0,
    askDepthUsd5c: 0,
    bookImbalance: 0,
    totalDepthUsd: 0,
    tradable: m !== null && spread(book) !== null,
  };
  if (m === null) return base;

  base.bidDepthUsd5c = book.bids
    .filter((l) => l.price >= m - band)
    .reduce((s, l) => s + l.price * l.size, 0);
  base.askDepthUsd5c = book.asks
    .filter((l) => l.price <= m + band)
    .reduce((s, l) => s + l.price * l.size, 0);
  const bandTotal = base.bidDepthUsd5c + base.askDepthUsd5c;
  if (bandTotal > 0) {
    base.bookImbalance = (base.bidDepthUsd5c - base.askDepthUsd5c) / bandTotal;
  }
  base.totalDepthUsd =
    book.bids.reduce((s, l) => s + l.price * l.size, 0) +
    book.asks.reduce((s, l) => s + l.price * l.size, 0);
  return base;
}

// Signed $ flow in token0 terms. BUY token0 / SELL token1 -> positive.
function signedNotional(trade: Trade, token0Id: string): number {
  let sign = trade.side === "BUY" ? 1 : -1;
  if (trade.assetId !== token0Id) sign = -sign;
  return sign * trade.price * trade.size;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const midIdx = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[midIdx]
    : (sorted[midIdx - 1] + sorted[midIdx]) / 2;
}

function priceChange(
  window: Trade[],
  token0Id: string,
  priceHistory: [number, number][] | undefined,
  cutoff: number
): number {
  if (priceHistory && priceHistory.length) {
    const inWindow = priceHistory.filter(([ts]) => ts >= cutoff);
    if (inWindow.length >= 2) {
      return inWindow[inWindow.length - 1][1] - inWindow[0][1];
    }
  }
  const token0Price = (t: Trade) =>
    t.assetId === token0Id ? t.price : 1 - t.price;
  const ordered = [...window].sort((a, b) => a.timestamp - b.timestamp);
  const k = Math.max(1, Math.floor(ordered.length / 5));
  const first = median(ordered.slice(0, k).map(token0Price));
  const last = median(ordered.slice(-k).map(token0Price));
  return last - first;
}

export function computeFlow(
  trades: Trade[],
  token0Id: string,
  opts: {
    windowHours?: number;
    now?: number;
    priceHistory?: [number, number][];
  } = {}
): FlowMetrics {
  const windowHours = opts.windowHours ?? 24;
  const now = opts.now ?? Date.now() / 1000;
  const cutoff = now - windowHours * 3600;
  const window = trades.filter((t) => t.timestamp >= cutoff);

  const m: FlowMetrics = {
    windowHours,
    buyNotional: 0,
    sellNotional: 0,
    totalNotional: 0,
    flowImbalance: 0,
    numTrades: window.length,
    avgTradeUsd: 0,
    whaleNetNotional: 0,
    whaleTrades: 0,
    uniqueWallets: 0,
    recentAccel: 0,
    priceChange: 0,
  };
  if (!window.length) return m;

  const signed: [number, number][] = window.map((t) => [
    t.timestamp,
    signedNotional(t, token0Id),
  ]);
  m.buyNotional = signed.filter(([, v]) => v > 0).reduce((s, [, v]) => s + v, 0);
  m.sellNotional = signed
    .filter(([, v]) => v < 0)
    .reduce((s, [, v]) => s - v, 0);
  m.totalNotional = m.buyNotional + m.sellNotional;
  if (m.totalNotional > 0) {
    m.flowImbalance = (m.buyNotional - m.sellNotional) / m.totalNotional;
  }
  m.avgTradeUsd = m.totalNotional / m.numTrades;

  const whales = signed.filter(([, v]) => Math.abs(v) >= WHALE_TRADE_USD);
  m.whaleTrades = whales.length;
  m.whaleNetNotional = whales.reduce((s, [, v]) => s + v, 0);
  m.uniqueWallets = new Set(
    window.map((t) => t.wallet).filter(Boolean)
  ).size;

  // Acceleration: is the most recent third of the window more one-sided
  // than the window overall? Positive = flow building, not fading.
  const recentCutoff = now - (windowHours * 3600) / 3;
  const recent = signed.filter(([ts]) => ts >= recentCutoff).map(([, v]) => v);
  const recentTotal = recent.reduce((s, v) => s + Math.abs(v), 0);
  if (recentTotal > 0) {
    const recentImb = recent.reduce((s, v) => s + v, 0) / recentTotal;
    m.recentAccel = recentImb - m.flowImbalance;
  }

  m.priceChange = priceChange(window, token0Id, opts.priceHistory, cutoff);
  return m;
}
