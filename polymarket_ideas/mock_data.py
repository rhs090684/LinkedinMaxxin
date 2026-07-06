"""Deterministic synthetic Polymarket data for offline demos and tests.

Shapes mirror the real Gamma / CLOB / Data API payloads so the rest of
the pipeline runs unchanged with --mock.
"""

from __future__ import annotations

import json
import random
import time


def _book(mid: float, spread: float, bid_mult: float, ask_mult: float, rng: random.Random) -> dict:
    bids, asks = [], []
    for i in range(10):
        bid_px = round(mid - spread / 2 - i * 0.01, 3)
        ask_px = round(mid + spread / 2 + i * 0.01, 3)
        if bid_px > 0:
            bids.append({"price": str(bid_px), "size": str(round(rng.uniform(300, 1500) * bid_mult, 1))})
        if ask_px < 1:
            asks.append({"price": str(ask_px), "size": str(round(rng.uniform(300, 1500) * ask_mult, 1))})
    return {"bids": bids, "asks": asks}


def _trades(token0: str, token1: str, buy_bias: float, mid: float, n: int, rng: random.Random, now: float) -> list[dict]:
    out = []
    for _ in range(n):
        buys_token0 = rng.random() < buy_bias
        asset = token0 if rng.random() < 0.7 else token1
        side = ("BUY" if buys_token0 else "SELL") if asset == token0 else ("SELL" if buys_token0 else "BUY")
        price = round(min(0.99, max(0.01, rng.gauss(mid if asset == token0 else 1 - mid, 0.015))), 3)
        size = round(rng.expovariate(1 / 400.0) + 20, 1)
        out.append(
            {
                "asset": asset,
                "side": side,
                "price": price,
                "size": size,
                "timestamp": int(now - rng.uniform(0, 23 * 3600)),
                "proxyWallet": f"0x{rng.randrange(16**8):08x}",
                "outcome": "team",
            }
        )
    return out


# name, mid, spread, buy_bias (taker flow toward outcome0), bid_mult, ask_mult, n_trades, vol24h
_SCENARIOS = [
    # Strong one-way flow + supportive book -> FLOW_MOMENTUM
    ("Chiefs vs. Bills", ["Chiefs", "Bills"], 0.58, 0.01, 0.85, 1.6, 0.7, 260, 180_000),
    # Balanced flow, wide spread -> LIQUIDITY_PROVISION
    ("Lakers vs. Celtics", ["Lakers", "Celtics"], 0.44, 0.05, 0.50, 1.0, 1.0, 140, 65_000),
    # Heavy selling absorbed by a bid wall, price flat -> FLOW_FADE candidate
    ("Yankees vs. Red Sox", ["Yankees", "Red Sox"], 0.62, 0.02, 0.12, 2.4, 0.6, 200, 90_000),
    # Stacked book, tight spread, quiet flow -> BOOK_PRESSURE
    ("Arsenal vs. Chelsea", ["Arsenal", "Chelsea"], 0.51, 0.015, 0.55, 2.2, 0.7, 90, 40_000),
    # Thin, near-resolved market -> should be filtered out
    ("Djokovic vs. Alcaraz", ["Djokovic", "Alcaraz"], 0.97, 0.01, 0.5, 0.3, 0.3, 15, 3_000),
]


def mock_universe(seed: int = 7) -> list[dict]:
    """Returns [{event, market_raw, book0, trades}] entries mimicking API payloads."""
    rng = random.Random(seed)
    now = time.time()
    universe = []
    for idx, (title, outcomes, mid, spread, bias, bmult, amult, n, vol) in enumerate(_SCENARIOS):
        token0, token1 = f"mock-token-{idx}-0", f"mock-token-{idx}-1"
        market_raw = {
            "conditionId": f"0xmock{idx}",
            "question": f"{title} - Moneyline",
            "slug": title.lower().replace(" ", "-").replace(".", ""),
            "outcomes": json.dumps(outcomes),
            "outcomePrices": json.dumps([str(mid), str(round(1 - mid, 3))]),
            "clobTokenIds": json.dumps([token0, token1]),
            "volume24hr": vol,
            "liquidity": vol / 4,
            "endDate": "2026-07-07T23:00:00Z",
        }
        universe.append(
            {
                "event_title": title,
                "tags": ["sports"],
                "market_raw": market_raw,
                "book0": _book(mid, spread, bmult, amult, rng),
                "trades": _trades(token0, token1, bias, mid, n, rng, now),
            }
        )
    return universe
