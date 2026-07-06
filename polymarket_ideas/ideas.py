"""Turn liquidity + orderflow metrics into scored trade ideas.

Four idea types:

- FLOW_MOMENTUM      taker flow and book pressure agree -> follow the flow
- BOOK_PRESSURE      heavily lopsided resting depth with a tight spread
- FLOW_FADE          heavy one-way flow that failed to move price into a
                     thick opposing wall -> contrarian
- LIQUIDITY_PROVISION wide spread on an active market -> quote both sides

Scores are 0-100. Nothing here is financial advice; it ranks setups, it
does not predict game outcomes.
"""

from __future__ import annotations

from typing import Optional

from .metrics import FlowMetrics, LiquidityMetrics
from .models import Market, TradeIdea

# Tunable thresholds
MIN_FLOW_NOTIONAL = 2_000.0   # $ of taker flow in window before flow signals count
MIN_DEPTH_USD = 1_000.0       # $ within 5c of mid before a market is "tradable"
FLOW_IMB_TRIGGER = 0.25
BOOK_IMB_TRIGGER = 0.40
WIDE_SPREAD = 0.03
TIGHT_SPREAD = 0.02
EXTREME_PRICE_LO = 0.05       # skip near-resolved markets
EXTREME_PRICE_HI = 0.95
MAX_SIZE_DEPTH_FRACTION = 0.10  # size ideas at <=10% of near-mid depth


def _clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def _direction_outcome(market: Market, positive: bool) -> str:
    """Positive flow/pressure means buy outcome0, negative means outcome1."""
    return market.outcomes[0] if positive else market.outcomes[1]


def _entry_price(liq: LiquidityMetrics, positive: bool) -> Optional[float]:
    """Cross the spread in the trade direction: buy token0 at the ask,
    buy token1 at (1 - best bid of token0)."""
    if positive:
        return liq.best_ask
    if liq.best_bid is not None:
        return round(1.0 - liq.best_bid, 4)
    return None


def generate_ideas(market: Market, liq: LiquidityMetrics, flow: FlowMetrics) -> list[TradeIdea]:
    ideas: list[TradeIdea] = []
    if not liq.tradable:
        return ideas
    mid = liq.mid or 0.0
    if not (EXTREME_PRICE_LO <= mid <= EXTREME_PRICE_HI):
        return ideas

    depth_ok = (liq.bid_depth_usd_5c + liq.ask_depth_usd_5c) >= MIN_DEPTH_USD
    flow_ok = flow.total_notional >= MIN_FLOW_NOTIONAL
    max_size = MAX_SIZE_DEPTH_FRACTION * (liq.bid_depth_usd_5c + liq.ask_depth_usd_5c)

    if depth_ok and flow_ok:
        idea = _flow_momentum(market, liq, flow, max_size)
        if idea:
            ideas.append(idea)
        idea = _flow_fade(market, liq, flow, max_size)
        if idea:
            ideas.append(idea)
    if depth_ok:
        idea = _book_pressure(market, liq, flow, max_size)
        if idea:
            ideas.append(idea)
    idea = _liquidity_provision(market, liq, flow)
    if idea:
        ideas.append(idea)
    return ideas


def _flow_momentum(market: Market, liq: LiquidityMetrics, flow: FlowMetrics, max_size: float) -> Optional[TradeIdea]:
    if abs(flow.flow_imbalance) < FLOW_IMB_TRIGGER:
        return None
    positive = flow.flow_imbalance > 0
    # Book must not be leaning hard the other way.
    if liq.book_imbalance * flow.flow_imbalance < -0.15:
        return None

    score = 40.0 * min(abs(flow.flow_imbalance) / 0.6, 1.0)
    score += 20.0 * min(flow.total_notional / 50_000.0, 1.0)
    if liq.book_imbalance * flow.flow_imbalance > 0:
        score += 15.0 * min(abs(liq.book_imbalance) / 0.6, 1.0)
    if flow.recent_accel * flow.flow_imbalance > 0:
        score += 10.0  # flow is building, not fading
    if flow.whale_net_notional * flow.flow_imbalance > 0 and flow.whale_trades > 0:
        score += 10.0
    if liq.spread is not None and liq.spread <= TIGHT_SPREAD:
        score += 5.0

    signals = [
        f"taker flow {flow.flow_imbalance:+.0%} on ${flow.total_notional:,.0f} in {flow.window_hours:.0f}h",
        f"book imbalance {liq.book_imbalance:+.0%} within 5c of mid",
        f"{flow.whale_trades} whale trades, net ${flow.whale_net_notional:+,.0f}",
    ]
    if flow.recent_accel * flow.flow_imbalance > 0:
        signals.append("flow accelerating in most recent third of window")

    outcome = _direction_outcome(market, positive)
    return TradeIdea(
        market=market,
        kind="FLOW_MOMENTUM",
        direction=outcome,
        entry_price=_entry_price(liq, positive),
        score=_clamp(score),
        signals=signals,
        rationale=(
            f"Aggressive taker flow is {abs(flow.flow_imbalance):.0%} one-sided toward "
            f"{outcome} and the resting book is not fighting it. Follow the flow while "
            f"it persists; exit if the imbalance flips."
        ),
        max_size_usd=max_size,
    )


def _book_pressure(market: Market, liq: LiquidityMetrics, flow: FlowMetrics, max_size: float) -> Optional[TradeIdea]:
    if abs(liq.book_imbalance) < BOOK_IMB_TRIGGER:
        return None
    if liq.spread is None or liq.spread > WIDE_SPREAD:
        return None
    # Skip if flow contradicts the book strongly - handled by fade instead.
    if flow.total_notional >= MIN_FLOW_NOTIONAL and liq.book_imbalance * flow.flow_imbalance < -0.15:
        return None
    positive = liq.book_imbalance > 0

    score = 35.0 * min(abs(liq.book_imbalance) / 0.7, 1.0)
    score += 15.0 * min((liq.bid_depth_usd_5c + liq.ask_depth_usd_5c) / 25_000.0, 1.0)
    if flow.flow_imbalance * liq.book_imbalance > 0 and flow.total_notional >= MIN_FLOW_NOTIONAL:
        score += 15.0
    if liq.spread <= 0.01:
        score += 5.0

    outcome = _direction_outcome(market, positive)
    heavy, light = (
        (liq.bid_depth_usd_5c, liq.ask_depth_usd_5c) if positive else (liq.ask_depth_usd_5c, liq.bid_depth_usd_5c)
    )
    return TradeIdea(
        market=market,
        kind="BOOK_PRESSURE",
        direction=outcome,
        entry_price=_entry_price(liq, positive),
        score=_clamp(score),
        signals=[
            f"resting depth ${heavy:,.0f} vs ${light:,.0f} within 5c of mid ({liq.book_imbalance:+.0%})",
            f"spread {liq.spread:.3f} ({(liq.spread or 0) * 100:.1f}c)",
        ],
        rationale=(
            f"The book is stacked toward {outcome}: far more resting dollars support that side "
            f"near mid, so downside is cushioned while a modest flow shift can push price through "
            f"the thin side."
        ),
        max_size_usd=max_size,
    )


def _flow_fade(market: Market, liq: LiquidityMetrics, flow: FlowMetrics, max_size: float) -> Optional[TradeIdea]:
    """Heavy one-way flow that could NOT move price and ran into a wall."""
    if abs(flow.flow_imbalance) < 0.35:
        return None
    # Price must have failed to follow the flow (< 1.5c move in flow direction).
    if flow.price_change * flow.flow_imbalance > 0.015:
        return None
    # Book must lean against the flow (the wall absorbing it).
    if liq.book_imbalance * flow.flow_imbalance > -0.25:
        return None
    # Flow already dying off strengthens the fade.
    positive = flow.flow_imbalance < 0  # fade means buying the opposite side

    score = 30.0 * min(abs(flow.flow_imbalance) / 0.7, 1.0)
    score += 20.0 * min(abs(liq.book_imbalance) / 0.6, 1.0)
    score += 10.0 * min(flow.total_notional / 30_000.0, 1.0)
    if flow.recent_accel * flow.flow_imbalance < 0:
        score += 10.0  # the one-way flow is already fading

    outcome = _direction_outcome(market, positive)
    return TradeIdea(
        market=market,
        kind="FLOW_FADE",
        direction=outcome,
        entry_price=_entry_price(liq, positive),
        score=_clamp(score),
        signals=[
            f"taker flow {flow.flow_imbalance:+.0%} on ${flow.total_notional:,.0f} but price moved {flow.price_change:+.3f}",
            f"opposing book wall: imbalance {liq.book_imbalance:+.0%}",
        ],
        rationale=(
            f"Heavy one-way taker flow failed to move price and is being absorbed by a thick "
            f"opposing wall - a classic exhaustion setup. Fade it by buying {outcome}."
        ),
        max_size_usd=max_size,
    )


def _liquidity_provision(market: Market, liq: LiquidityMetrics, flow: FlowMetrics) -> Optional[TradeIdea]:
    if liq.spread is None or liq.spread < WIDE_SPREAD:
        return None
    if market.volume_24h < 5_000.0 and flow.total_notional < 2_000.0:
        return None

    score = 25.0 * min(liq.spread / 0.08, 1.0)
    score += 25.0 * min(market.volume_24h / 100_000.0, 1.0)
    score += 10.0 * min(flow.num_trades / 200.0, 1.0)
    # Two-sided flow is what a market maker wants.
    score += 10.0 * (1.0 - min(abs(flow.flow_imbalance), 1.0))

    return TradeIdea(
        market=market,
        kind="LIQUIDITY_PROVISION",
        direction="BOTH",
        entry_price=liq.mid,
        score=_clamp(score),
        signals=[
            f"spread {liq.spread * 100:.1f}c with ${market.volume_24h:,.0f} 24h volume",
            f"{flow.num_trades} trades in window, flow imbalance {flow.flow_imbalance:+.0%}",
        ],
        rationale=(
            f"Spread is {liq.spread * 100:.1f}c on an actively traded game. Quoting inside the "
            f"spread on both sides earns the spread from two-sided taker flow; keep quotes "
            f"balanced and pull them near game start / news."
        ),
        max_size_usd=liq.total_depth_usd * 0.05,
    )


def rank_ideas(ideas: list[TradeIdea], min_score: float = 30.0, top: int = 20) -> list[TradeIdea]:
    kept = [i for i in ideas if i.score >= min_score]
    kept.sort(key=lambda i: i.score, reverse=True)
    return kept[:top]
