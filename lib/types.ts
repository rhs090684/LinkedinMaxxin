// Shared types for the Polymarket sports trade-idea engine.

export interface Market {
  conditionId: string;
  question: string;
  slug: string;
  eventTitle: string;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  volume24h: number;
  liquidity: number;
  endDate: string;
  tags: string[];
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bids: BookLevel[]; // sorted desc by price
  asks: BookLevel[]; // sorted asc by price
}

export interface Trade {
  assetId: string;
  side: "BUY" | "SELL"; // taker/aggressor side
  price: number;
  size: number; // shares
  timestamp: number; // unix seconds
  wallet: string;
  outcome: string;
}

export interface LiquidityMetrics {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  bidDepthUsd5c: number;
  askDepthUsd5c: number;
  bookImbalance: number; // [-1, 1]
  totalDepthUsd: number;
  tradable: boolean;
}

export interface FlowMetrics {
  windowHours: number;
  buyNotional: number;
  sellNotional: number;
  totalNotional: number;
  flowImbalance: number; // [-1, 1]
  numTrades: number;
  avgTradeUsd: number;
  whaleNetNotional: number;
  whaleTrades: number;
  uniqueWallets: number;
  recentAccel: number;
  priceChange: number;
}

export type IdeaKind =
  | "FLOW_MOMENTUM"
  | "BOOK_PRESSURE"
  | "FLOW_FADE"
  | "LIQUIDITY_PROVISION";

export interface TradeIdea {
  question: string;
  eventTitle: string;
  slug: string;
  conditionId: string;
  kind: IdeaKind;
  direction: string; // outcome name, or "BOTH"
  entryPrice: number | null;
  score: number; // 0-100
  signals: string[];
  rationale: string;
  maxSizeUsd: number;
  volume24h: number;
  endDate: string;
}

export interface ScanResult {
  generatedAt: string;
  marketsScanned: number;
  source: "live" | "mock";
  disclaimer: string;
  ideas: TradeIdea[];
  errors?: string[];
}
