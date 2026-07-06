import { test } from "node:test";
import assert from "node:assert/strict";

import { computeLiquidity, computeFlow } from "../lib/metrics";
import { generateIdeas, rankIdeas } from "../lib/ideas";
import { orderBookFromClob, marketFromGamma } from "../lib/parse";
import { scanMock } from "../lib/scan";
import type {
  Market,
  Trade,
  LiquidityMetrics,
  FlowMetrics,
} from "../lib/types";

const NOW = Date.now() / 1000;
const T0 = "token-0";
const T1 = "token-1";

function book(bids: [number, number][], asks: [number, number][]) {
  return orderBookFromClob({
    asset_id: T0,
    bids: bids.map(([p, s]) => ({ price: String(p), size: String(s) })),
    asks: asks.map(([p, s]) => ({ price: String(p), size: String(s) })),
  });
}

function trade(
  asset: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  ageH = 1,
  wallet = "0xabc"
): Trade {
  return {
    assetId: asset,
    side,
    price,
    size,
    timestamp: Math.trunc(NOW - ageH * 3600),
    wallet,
    outcome: "",
  };
}

// ---- parsing / metrics ----

test("book parsing sorts and computes mid/spread", () => {
  const b = book(
    [
      [0.5, 100],
      [0.55, 100],
    ],
    [
      [0.6, 100],
      [0.57, 100],
    ]
  );
  const liq = computeLiquidity(b);
  assert.equal(liq.bestBid, 0.55);
  assert.equal(liq.bestAsk, 0.57);
  assert.ok(Math.abs((liq.mid ?? 0) - 0.56) < 1e-9);
  assert.ok(Math.abs((liq.spread ?? 0) - 0.02) < 1e-9);
});

test("liquidity depth and imbalance", () => {
  const b = book(
    [
      [0.55, 1000],
      [0.53, 1000],
      [0.4, 9999],
    ],
    [[0.57, 500]]
  );
  const liq = computeLiquidity(b);
  assert.ok(Math.abs(liq.bidDepthUsd5c - (0.55 * 1000 + 0.53 * 1000)) < 1e-6);
  assert.ok(Math.abs(liq.askDepthUsd5c - 0.57 * 500) < 1e-6);
  assert.ok(liq.bookImbalance > 0.5);
  assert.ok(liq.totalDepthUsd > liq.bidDepthUsd5c + liq.askDepthUsd5c);
});

test("flow sign normalization across tokens", () => {
  const trades = [
    trade(T0, "BUY", 0.55, 1000),
    trade(T1, "SELL", 0.45, 1000), // sell token1 == buy token0
    trade(T0, "SELL", 0.55, 200),
  ];
  const flow = computeFlow(trades, T0, { now: NOW });
  assert.ok(Math.abs(flow.buyNotional - (550 + 450)) < 1e-6);
  assert.ok(Math.abs(flow.sellNotional - 110) < 1e-6);
  assert.ok(flow.flowImbalance > 0.7);
});

test("flow window excludes old trades", () => {
  const trades = [
    trade(T0, "BUY", 0.5, 100, 1),
    trade(T0, "BUY", 0.5, 100, 48),
  ];
  const flow = computeFlow(trades, T0, { windowHours: 24, now: NOW });
  assert.equal(flow.numTrades, 1);
});

test("whale detection", () => {
  const trades = [
    trade(T0, "BUY", 0.5, 2000, 1, "0x1"),
    trade(T0, "SELL", 0.5, 50, 1, "0x2"),
  ];
  const flow = computeFlow(trades, T0, { now: NOW });
  assert.equal(flow.whaleTrades, 1);
  assert.ok(Math.abs(flow.whaleNetNotional - 1000) < 1e-6);
  assert.equal(flow.uniqueWallets, 2);
});

test("gamma market parsing handles JSON-string fields", () => {
  const m = marketFromGamma(
    {
      conditionId: "0xabc",
      question: "Chiefs vs. Bills",
      slug: "chiefs-bills",
      outcomes: '["Chiefs", "Bills"]',
      outcomePrices: '["0.58", "0.42"]',
      clobTokenIds: '["11", "22"]',
      volume24hr: "12345.6",
      liquidity: 5000,
      endDate: "2026-07-07",
    },
    "NFL"
  );
  assert.ok(m);
  assert.deepEqual(m!.outcomes, ["Chiefs", "Bills"]);
  assert.deepEqual(m!.clobTokenIds, ["11", "22"]);
  assert.ok(Math.abs(m!.volume24h - 12345.6) < 1e-6);
});

test("gamma market rejects missing tokens", () => {
  assert.equal(
    marketFromGamma({ outcomes: '["Yes","No"]', clobTokenIds: "[]" }),
    null
  );
});

// ---- idea generation ----

function market(mid = 0.55, vol = 50_000): Market {
  return {
    conditionId: "0xabc",
    question: "Chiefs vs. Bills - Moneyline",
    slug: "chiefs-bills",
    eventTitle: "Chiefs vs. Bills",
    outcomes: ["Chiefs", "Bills"],
    outcomePrices: [mid, 1 - mid],
    clobTokenIds: ["11", "22"],
    volume24h: vol,
    liquidity: vol / 4,
    endDate: "2026-07-07",
    tags: ["sports"],
  };
}

function liq(
  mid = 0.55,
  spread = 0.01,
  bidUsd = 8000,
  askUsd = 8000
): LiquidityMetrics {
  const total = bidUsd + askUsd;
  return {
    bestBid: mid - spread / 2,
    bestAsk: mid + spread / 2,
    mid,
    spread,
    bidDepthUsd5c: bidUsd,
    askDepthUsd5c: askUsd,
    bookImbalance: total ? (bidUsd - askUsd) / total : 0,
    totalDepthUsd: total * 2,
    tradable: true,
  };
}

function flow(
  imb = 0,
  notional = 20_000,
  priceChange = 0,
  accel = 0,
  whaleNet = 0
): FlowMetrics {
  const buy = (notional * (1 + imb)) / 2;
  return {
    windowHours: 24,
    buyNotional: buy,
    sellNotional: notional - buy,
    totalNotional: notional,
    flowImbalance: imb,
    numTrades: 150,
    avgTradeUsd: notional / 150,
    whaleNetNotional: whaleNet,
    whaleTrades: whaleNet ? 3 : 0,
    uniqueWallets: 60,
    recentAccel: accel,
    priceChange,
  };
}

const kinds = (ideas: { kind: string }[]) => new Set(ideas.map((i) => i.kind));

test("flow momentum fires and points at flow side", () => {
  const ideas = generateIdeas(
    market(),
    liq(0.55, 0.01, 10_000, 6_000),
    flow(0.5, 20_000, 0, 0.1, 5_000)
  );
  const mom = ideas.filter((i) => i.kind === "FLOW_MOMENTUM");
  assert.ok(mom.length, `expected momentum, got ${[...kinds(ideas)]}`);
  assert.equal(mom[0].direction, "Chiefs");
  assert.ok(mom[0].score > 50);
});

test("negative flow targets second outcome", () => {
  const ideas = generateIdeas(
    market(),
    liq(0.55, 0.01, 5_000, 9_000),
    flow(-0.5)
  );
  const mom = ideas.filter((i) => i.kind === "FLOW_MOMENTUM");
  assert.ok(mom.length && mom[0].direction === "Bills");
});

test("momentum blocked by strongly opposing book", () => {
  const ideas = generateIdeas(
    market(),
    liq(0.55, 0.01, 2_000, 14_000),
    flow(0.5)
  );
  assert.ok(!kinds(ideas).has("FLOW_MOMENTUM"));
});

test("book pressure fires on stacked tight book", () => {
  const ideas = generateIdeas(
    market(),
    liq(0.55, 0.01, 15_000, 3_000),
    flow(0.05, 3_000)
  );
  assert.ok(kinds(ideas).has("BOOK_PRESSURE"));
});

test("flow fade fires when flow hits wall without price move", () => {
  const ideas = generateIdeas(
    market(),
    liq(0.55, 0.01, 16_000, 4_000),
    flow(-0.6, 20_000, 0.001, 0.2)
  );
  const fades = ideas.filter((i) => i.kind === "FLOW_FADE");
  assert.ok(fades.length, `expected fade, got ${[...kinds(ideas)]}`);
  assert.equal(fades[0].direction, "Chiefs");
});

test("liquidity provision on wide spread", () => {
  const ideas = generateIdeas(
    market(0.55, 80_000),
    liq(0.44, 0.05),
    flow(0.05, 10_000)
  );
  const mm = ideas.filter((i) => i.kind === "LIQUIDITY_PROVISION");
  assert.ok(mm.length && mm[0].direction === "BOTH");
});

test("extreme-priced markets are skipped", () => {
  const ideas = generateIdeas(market(0.97), liq(0.97), flow(0.6));
  assert.equal(ideas.length, 0);
});

test("thin markets produce no directional ideas", () => {
  const ideas = generateIdeas(
    market(0.55, 500),
    liq(0.55, 0.01, 200, 200),
    flow(0.6, 300)
  );
  const directional = new Set(["FLOW_MOMENTUM", "BOOK_PRESSURE", "FLOW_FADE"]);
  assert.ok([...kinds(ideas)].every((k) => !directional.has(k)));
});

test("rank filters and sorts", () => {
  const ideas = generateIdeas(
    market(),
    liq(0.55, 0.01, 10_000, 6_000),
    flow(0.5, 20_000, 0, 0, 5_000)
  );
  const ranked = rankIdeas(ideas, 30, 5);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
  assert.ok(ranked.every((i) => i.score >= 30));
});

test("mock pipeline end to end", () => {
  const result = scanMock({ minScore: 30, top: 15 });
  assert.equal(result.marketsScanned, 5);
  assert.ok(result.ideas.length > 0);
  assert.ok(result.ideas.every((i) => !i.question.includes("Djokovic")));
});
