// Turn liquidity + orderflow metrics into scored trade ideas.
//
// Four idea types: FLOW_MOMENTUM, BOOK_PRESSURE, FLOW_FADE, LIQUIDITY_PROVISION.
// Scores are 0-100. Nothing here predicts game outcomes; it ranks setups.

import type {
  Market,
  LiquidityMetrics,
  FlowMetrics,
  TradeIdea,
} from "./types";

const MIN_FLOW_NOTIONAL = 2_000;
const MIN_DEPTH_USD = 1_000;
const FLOW_IMB_TRIGGER = 0.25;
const BOOK_IMB_TRIGGER = 0.4;
const WIDE_SPREAD = 0.03;
const TIGHT_SPREAD = 0.02;
const EXTREME_PRICE_LO = 0.05;
const EXTREME_PRICE_HI = 0.95;
const MAX_SIZE_DEPTH_FRACTION = 0.1;

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
const usd = (x: number) =>
  `$${Math.round(x).toLocaleString("en-US")}`;
const signedUsd = (x: number) =>
  `${x >= 0 ? "+" : "-"}$${Math.round(Math.abs(x)).toLocaleString("en-US")}`;

function directionOutcome(market: Market, positive: boolean): string {
  return positive ? market.outcomes[0] : market.outcomes[1];
}

// Cross the spread in the trade direction.
function entryPrice(liq: LiquidityMetrics, positive: boolean): number | null {
  if (positive) return liq.bestAsk;
  if (liq.bestBid !== null) return Math.round((1 - liq.bestBid) * 10000) / 10000;
  return null;
}

function baseIdea(
  market: Market,
  kind: TradeIdea["kind"],
  direction: string,
  entry: number | null,
  score: number,
  signals: string[],
  rationale: string,
  maxSizeUsd: number
): TradeIdea {
  return {
    question: market.question,
    eventTitle: market.eventTitle,
    slug: market.slug,
    conditionId: market.conditionId,
    kind,
    direction,
    entryPrice: entry,
    score: clamp(score),
    signals,
    rationale,
    maxSizeUsd: Math.round(maxSizeUsd),
    volume24h: market.volume24h,
    endDate: market.endDate,
  };
}

export function generateIdeas(
  market: Market,
  liq: LiquidityMetrics,
  flow: FlowMetrics
): TradeIdea[] {
  const ideas: TradeIdea[] = [];
  if (!liq.tradable || liq.mid === null) return ideas;
  const m = liq.mid;
  if (m < EXTREME_PRICE_LO || m > EXTREME_PRICE_HI) return ideas;

  const nearMidDepth = liq.bidDepthUsd5c + liq.askDepthUsd5c;
  const depthOk = nearMidDepth >= MIN_DEPTH_USD;
  const flowOk = flow.totalNotional >= MIN_FLOW_NOTIONAL;
  const maxSize = MAX_SIZE_DEPTH_FRACTION * nearMidDepth;

  if (depthOk && flowOk) {
    const mom = flowMomentum(market, liq, flow, maxSize);
    if (mom) ideas.push(mom);
    const fade = flowFade(market, liq, flow, maxSize);
    if (fade) ideas.push(fade);
  }
  if (depthOk) {
    const bp = bookPressure(market, liq, flow, maxSize);
    if (bp) ideas.push(bp);
  }
  const mm = liquidityProvision(market, liq, flow);
  if (mm) ideas.push(mm);
  return ideas;
}

function flowMomentum(
  market: Market,
  liq: LiquidityMetrics,
  flow: FlowMetrics,
  maxSize: number
): TradeIdea | null {
  if (Math.abs(flow.flowImbalance) < FLOW_IMB_TRIGGER) return null;
  const positive = flow.flowImbalance > 0;
  if (liq.bookImbalance * flow.flowImbalance < -0.15) return null;

  let score = 40 * Math.min(Math.abs(flow.flowImbalance) / 0.6, 1);
  score += 20 * Math.min(flow.totalNotional / 50_000, 1);
  if (liq.bookImbalance * flow.flowImbalance > 0) {
    score += 15 * Math.min(Math.abs(liq.bookImbalance) / 0.6, 1);
  }
  if (flow.recentAccel * flow.flowImbalance > 0) score += 10;
  if (flow.whaleNetNotional * flow.flowImbalance > 0 && flow.whaleTrades > 0) {
    score += 10;
  }
  if (liq.spread !== null && liq.spread <= TIGHT_SPREAD) score += 5;

  const outcome = directionOutcome(market, positive);
  const signals = [
    `taker flow ${pct(flow.flowImbalance)} on ${usd(flow.totalNotional)} in ${flow.windowHours.toFixed(0)}h`,
    `book imbalance ${pct(liq.bookImbalance)} within 5c of mid`,
    `${flow.whaleTrades} whale trades, net ${signedUsd(flow.whaleNetNotional)}`,
  ];
  if (flow.recentAccel * flow.flowImbalance > 0) {
    signals.push("flow accelerating in most recent third of window");
  }
  return baseIdea(
    market,
    "FLOW_MOMENTUM",
    outcome,
    entryPrice(liq, positive),
    score,
    signals,
    `Aggressive taker flow is ${Math.round(Math.abs(flow.flowImbalance) * 100)}% one-sided toward ${outcome} and the resting book is not fighting it. Follow the flow while it persists; exit if the imbalance flips.`,
    maxSize
  );
}

function bookPressure(
  market: Market,
  liq: LiquidityMetrics,
  flow: FlowMetrics,
  maxSize: number
): TradeIdea | null {
  if (Math.abs(liq.bookImbalance) < BOOK_IMB_TRIGGER) return null;
  if (liq.spread === null || liq.spread > WIDE_SPREAD) return null;
  if (
    flow.totalNotional >= MIN_FLOW_NOTIONAL &&
    liq.bookImbalance * flow.flowImbalance < -0.15
  ) {
    return null;
  }
  const positive = liq.bookImbalance > 0;

  let score = 35 * Math.min(Math.abs(liq.bookImbalance) / 0.7, 1);
  score += 15 * Math.min((liq.bidDepthUsd5c + liq.askDepthUsd5c) / 25_000, 1);
  if (
    flow.flowImbalance * liq.bookImbalance > 0 &&
    flow.totalNotional >= MIN_FLOW_NOTIONAL
  ) {
    score += 15;
  }
  if (liq.spread <= 0.01) score += 5;

  const outcome = directionOutcome(market, positive);
  const [heavy, light] = positive
    ? [liq.bidDepthUsd5c, liq.askDepthUsd5c]
    : [liq.askDepthUsd5c, liq.bidDepthUsd5c];
  return baseIdea(
    market,
    "BOOK_PRESSURE",
    outcome,
    entryPrice(liq, positive),
    score,
    [
      `resting depth ${usd(heavy)} vs ${usd(light)} within 5c of mid (${pct(liq.bookImbalance)})`,
      `spread ${liq.spread.toFixed(3)} (${(liq.spread * 100).toFixed(1)}c)`,
    ],
    `The book is stacked toward ${outcome}: far more resting dollars support that side near mid, so downside is cushioned while a modest flow shift can push price through the thin side.`,
    maxSize
  );
}

function flowFade(
  market: Market,
  liq: LiquidityMetrics,
  flow: FlowMetrics,
  maxSize: number
): TradeIdea | null {
  if (Math.abs(flow.flowImbalance) < 0.35) return null;
  if (flow.priceChange * flow.flowImbalance > 0.015) return null;
  if (liq.bookImbalance * flow.flowImbalance > -0.25) return null;
  const positive = flow.flowImbalance < 0; // fade -> buy the opposite side

  let score = 30 * Math.min(Math.abs(flow.flowImbalance) / 0.7, 1);
  score += 20 * Math.min(Math.abs(liq.bookImbalance) / 0.6, 1);
  score += 10 * Math.min(flow.totalNotional / 30_000, 1);
  if (flow.recentAccel * flow.flowImbalance < 0) score += 10;

  const outcome = directionOutcome(market, positive);
  return baseIdea(
    market,
    "FLOW_FADE",
    outcome,
    entryPrice(liq, positive),
    score,
    [
      `taker flow ${pct(flow.flowImbalance)} on ${usd(flow.totalNotional)} but price moved ${flow.priceChange >= 0 ? "+" : ""}${flow.priceChange.toFixed(3)}`,
      `opposing book wall: imbalance ${pct(liq.bookImbalance)}`,
    ],
    `Heavy one-way taker flow failed to move price and is being absorbed by a thick opposing wall - a classic exhaustion setup. Fade it by buying ${outcome}.`,
    maxSize
  );
}

function liquidityProvision(
  market: Market,
  liq: LiquidityMetrics,
  flow: FlowMetrics
): TradeIdea | null {
  if (liq.spread === null || liq.spread < WIDE_SPREAD) return null;
  if (market.volume24h < 5_000 && flow.totalNotional < 2_000) return null;

  let score = 25 * Math.min(liq.spread / 0.08, 1);
  score += 25 * Math.min(market.volume24h / 100_000, 1);
  score += 10 * Math.min(flow.numTrades / 200, 1);
  score += 10 * (1 - Math.min(Math.abs(flow.flowImbalance), 1));

  return baseIdea(
    market,
    "LIQUIDITY_PROVISION",
    "BOTH",
    liq.mid,
    score,
    [
      `spread ${(liq.spread * 100).toFixed(1)}c with ${usd(market.volume24h)} 24h volume`,
      `${flow.numTrades} trades in window, flow imbalance ${pct(flow.flowImbalance)}`,
    ],
    `Spread is ${(liq.spread * 100).toFixed(1)}c on an actively traded game. Quoting inside the spread on both sides earns the spread from two-sided taker flow; keep quotes balanced and pull them near game start / news.`,
    liq.totalDepthUsd * 0.05
  );
}

export function rankIdeas(
  ideas: TradeIdea[],
  minScore = 30,
  top = 20
): TradeIdea[] {
  return ideas
    .filter((i) => i.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
