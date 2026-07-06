"""Liquidity and orderflow metrics computed from books and trades.

All directional metrics are normalized to the market's FIRST outcome token
(token0). A taker BUY of token1 is economically a SELL of token0, so it
counts as negative flow.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from statistics import median
from typing import Optional

from .models import OrderBook, Trade

WHALE_TRADE_USD = 500.0


@dataclass
class LiquidityMetrics:
    best_bid: Optional[float] = None
    best_ask: Optional[float] = None
    mid: Optional[float] = None
    spread: Optional[float] = None
    bid_depth_usd_5c: float = 0.0  # $ resting within 5c below mid
    ask_depth_usd_5c: float = 0.0  # $ resting within 5c above mid
    book_imbalance: float = 0.0  # (bid - ask) / (bid + ask), in [-1, 1]
    total_depth_usd: float = 0.0

    @property
    def tradable(self) -> bool:
        return self.mid is not None and self.spread is not None


@dataclass
class FlowMetrics:
    window_hours: float = 24.0
    buy_notional: float = 0.0  # $ of taker buys of token0 (incl. sells of token1)
    sell_notional: float = 0.0
    flow_imbalance: float = 0.0  # (buy - sell) / (buy + sell), in [-1, 1]
    num_trades: int = 0
    avg_trade_usd: float = 0.0
    whale_net_notional: float = 0.0  # signed $ from trades >= WHALE_TRADE_USD
    whale_trades: int = 0
    unique_wallets: int = 0
    recent_accel: float = 0.0  # flow imbalance of most recent third vs whole window
    price_change: float = 0.0  # mid/trade-price change over window, in price units
    signed_trades: list = field(default_factory=list)  # (ts, signed_notional)

    @property
    def total_notional(self) -> float:
        return self.buy_notional + self.sell_notional


def compute_liquidity(book: OrderBook, band: float = 0.05) -> LiquidityMetrics:
    m = LiquidityMetrics(
        best_bid=book.best_bid,
        best_ask=book.best_ask,
        mid=book.mid,
        spread=book.spread,
    )
    if book.mid is None:
        return m
    mid = book.mid
    m.bid_depth_usd_5c = sum(l.notional for l in book.bids if l.price >= mid - band)
    m.ask_depth_usd_5c = sum(l.notional for l in book.asks if l.price <= mid + band)
    total_band = m.bid_depth_usd_5c + m.ask_depth_usd_5c
    if total_band > 0:
        m.book_imbalance = (m.bid_depth_usd_5c - m.ask_depth_usd_5c) / total_band
    m.total_depth_usd = sum(l.notional for l in book.bids) + sum(l.notional for l in book.asks)
    return m


def _signed_notional(trade: Trade, token0_id: str) -> float:
    """Signed $ flow in token0 terms. BUY token0 / SELL token1 -> positive."""
    sign = 1.0 if trade.side == "BUY" else -1.0
    if trade.asset_id != token0_id:
        sign = -sign
    return sign * trade.notional


def compute_flow(
    trades: list[Trade],
    token0_id: str,
    window_hours: float = 24.0,
    now: Optional[float] = None,
    price_history: Optional[list[tuple[int, float]]] = None,
) -> FlowMetrics:
    now = now if now is not None else time.time()
    cutoff = now - window_hours * 3600
    window = [t for t in trades if t.timestamp >= cutoff]
    m = FlowMetrics(window_hours=window_hours)
    m.num_trades = len(window)
    if not window:
        return m

    signed = [(t.timestamp, _signed_notional(t, token0_id)) for t in window]
    m.signed_trades = signed
    m.buy_notional = sum(v for _, v in signed if v > 0)
    m.sell_notional = sum(-v for _, v in signed if v < 0)
    if m.total_notional > 0:
        m.flow_imbalance = (m.buy_notional - m.sell_notional) / m.total_notional
    m.avg_trade_usd = m.total_notional / m.num_trades

    whales = [(ts, v) for ts, v in signed if abs(v) >= WHALE_TRADE_USD]
    m.whale_trades = len(whales)
    m.whale_net_notional = sum(v for _, v in whales)
    m.unique_wallets = len({t.wallet for t in window if t.wallet})

    # Acceleration: is the most recent third of the window more one-sided
    # than the window overall? Positive value = flow building, not fading.
    recent_cutoff = now - (window_hours * 3600) / 3
    recent = [v for ts, v in signed if ts >= recent_cutoff]
    recent_total = sum(abs(v) for v in recent)
    if recent_total > 0:
        recent_imb = sum(recent) / recent_total
        m.recent_accel = recent_imb - m.flow_imbalance

    m.price_change = _price_change(window, token0_id, price_history, cutoff)
    return m


def _price_change(
    window: list[Trade],
    token0_id: str,
    price_history: Optional[list[tuple[int, float]]],
    cutoff: float,
) -> float:
    """Change in token0 price over the window, from history if available,
    otherwise from median trade prices at the two ends of the window."""
    if price_history:
        in_window = [(ts, p) for ts, p in price_history if ts >= cutoff]
        if len(in_window) >= 2:
            return in_window[-1][1] - in_window[0][1]

    def token0_price(trade: Trade) -> float:
        return trade.price if trade.asset_id == token0_id else 1.0 - trade.price

    ordered = sorted(window, key=lambda t: t.timestamp)
    k = max(1, len(ordered) // 5)
    first = median(token0_price(t) for t in ordered[:k])
    last = median(token0_price(t) for t in ordered[-k:])
    return last - first
