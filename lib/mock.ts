// Deterministic synthetic Polymarket data for the demo mode (?source=mock),
// so the dashboard renders even when the live API is unreachable.

import type { Market, OrderBook, Trade } from "./types";
import { marketFromGamma, orderBookFromClob, tradeFromDataApi } from "./parse";

// Small seeded PRNG (mulberry32) for reproducible mock output.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number, mean: number, sd: number): number {
  const u = 1 - rng();
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function expo(rng: () => number, rate: number): number {
  return -Math.log(1 - rng()) / rate;
}

function mockBook(
  midPx: number,
  spread: number,
  bidMult: number,
  askMult: number,
  rng: () => number
): OrderBook {
  const bids: Record<string, unknown>[] = [];
  const asks: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    const bidPx = +(midPx - spread / 2 - i * 0.01).toFixed(3);
    const askPx = +(midPx + spread / 2 + i * 0.01).toFixed(3);
    if (bidPx > 0) {
      bids.push({
        price: String(bidPx),
        size: String(+((300 + rng() * 1200) * bidMult).toFixed(1)),
      });
    }
    if (askPx < 1) {
      asks.push({
        price: String(askPx),
        size: String(+((300 + rng() * 1200) * askMult).toFixed(1)),
      });
    }
  }
  return orderBookFromClob({ asset_id: "mock", bids, asks });
}

function mockTrades(
  token0: string,
  token1: string,
  buyBias: number,
  midPx: number,
  n: number,
  rng: () => number,
  now: number
): Trade[] {
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    const buysToken0 = rng() < buyBias;
    const asset = rng() < 0.7 ? token0 : token1;
    const side =
      asset === token0
        ? buysToken0
          ? "BUY"
          : "SELL"
        : buysToken0
          ? "SELL"
          : "BUY";
    const centerPx = asset === token0 ? midPx : 1 - midPx;
    const price = +Math.min(0.99, Math.max(0.01, gauss(rng, centerPx, 0.015))).toFixed(3);
    const size = +(expo(rng, 1 / 400) + 20).toFixed(1);
    const t = tradeFromDataApi({
      asset,
      side,
      price,
      size,
      timestamp: Math.trunc(now - rng() * 23 * 3600),
      proxyWallet: `0x${Math.trunc(rng() * 16 ** 8).toString(16).padStart(8, "0")}`,
      outcome: "team",
    });
    if (t) out.push(t);
  }
  return out;
}

interface Scenario {
  title: string;
  outcomes: [string, string];
  mid: number;
  spread: number;
  bias: number;
  bidMult: number;
  askMult: number;
  n: number;
  vol: number;
}

const SCENARIOS: Scenario[] = [
  { title: "Chiefs vs. Bills", outcomes: ["Chiefs", "Bills"], mid: 0.58, spread: 0.01, bias: 0.85, bidMult: 1.6, askMult: 0.7, n: 260, vol: 180_000 },
  { title: "Lakers vs. Celtics", outcomes: ["Lakers", "Celtics"], mid: 0.44, spread: 0.05, bias: 0.5, bidMult: 1.0, askMult: 1.0, n: 140, vol: 65_000 },
  { title: "Yankees vs. Red Sox", outcomes: ["Yankees", "Red Sox"], mid: 0.62, spread: 0.02, bias: 0.12, bidMult: 2.4, askMult: 0.6, n: 200, vol: 90_000 },
  { title: "Arsenal vs. Chelsea", outcomes: ["Arsenal", "Chelsea"], mid: 0.51, spread: 0.015, bias: 0.55, bidMult: 2.2, askMult: 0.7, n: 90, vol: 40_000 },
  { title: "Djokovic vs. Alcaraz", outcomes: ["Djokovic", "Alcaraz"], mid: 0.97, spread: 0.01, bias: 0.5, bidMult: 0.3, askMult: 0.3, n: 15, vol: 3_000 },
];

export interface MockEntry {
  market: Market;
  book: OrderBook;
  trades: Trade[];
}

export function mockUniverse(seed = 7): MockEntry[] {
  const rng = mulberry32(seed);
  const now = Date.now() / 1000;
  const out: MockEntry[] = [];
  SCENARIOS.forEach((s, idx) => {
    const token0 = `mock-token-${idx}-0`;
    const token1 = `mock-token-${idx}-1`;
    const market = marketFromGamma(
      {
        conditionId: `0xmock${idx}`,
        question: `${s.title} - Moneyline`,
        slug: s.title.toLowerCase().replace(/[. ]+/g, "-"),
        outcomes: JSON.stringify(s.outcomes),
        outcomePrices: JSON.stringify([String(s.mid), String(+(1 - s.mid).toFixed(3))]),
        clobTokenIds: JSON.stringify([token0, token1]),
        volume24hr: s.vol,
        liquidity: s.vol / 4,
        endDate: "2026-07-07T23:00:00Z",
      },
      s.title,
      ["sports"]
    );
    if (!market) return;
    out.push({
      market,
      book: mockBook(s.mid, s.spread, s.bidMult, s.askMult, rng),
      trades: mockTrades(token0, token1, s.bias, s.mid, s.n, rng, now),
    });
  });
  return out;
}
