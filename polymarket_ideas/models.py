"""Typed containers for market, book, trade, and idea data."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_json_list(value: Any) -> list:
    """Gamma returns list fields either as real lists or JSON-encoded strings."""
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


@dataclass
class Market:
    """A single binary market (one game/prop) from the Gamma API."""

    condition_id: str
    question: str
    slug: str
    event_title: str
    outcomes: list[str]
    outcome_prices: list[float]
    clob_token_ids: list[str]
    volume_24h: float
    liquidity: float
    end_date: str
    tags: list[str] = field(default_factory=list)
    best_bid: Optional[float] = None
    best_ask: Optional[float] = None

    @classmethod
    def from_gamma(cls, raw: dict, event_title: str = "", tags: Optional[list[str]] = None) -> Optional["Market"]:
        token_ids = [str(t) for t in _as_json_list(raw.get("clobTokenIds"))]
        outcomes = [str(o) for o in _as_json_list(raw.get("outcomes"))]
        if len(token_ids) < 2 or len(outcomes) < 2:
            return None
        prices = [_as_float(p) for p in _as_json_list(raw.get("outcomePrices"))]
        return cls(
            condition_id=str(raw.get("conditionId", "")),
            question=str(raw.get("question", "")),
            slug=str(raw.get("slug", "")),
            event_title=event_title or str(raw.get("question", "")),
            outcomes=outcomes,
            outcome_prices=prices,
            clob_token_ids=token_ids,
            volume_24h=_as_float(raw.get("volume24hr")),
            liquidity=_as_float(raw.get("liquidity") or raw.get("liquidityNum")),
            end_date=str(raw.get("endDate", "")),
            tags=tags or [],
            best_bid=_as_float(raw.get("bestBid"), default=None) if raw.get("bestBid") is not None else None,
            best_ask=_as_float(raw.get("bestAsk"), default=None) if raw.get("bestAsk") is not None else None,
        )


@dataclass
class BookLevel:
    price: float
    size: float

    @property
    def notional(self) -> float:
        return self.price * self.size


@dataclass
class OrderBook:
    """Order book for one outcome token, bids sorted desc / asks asc."""

    token_id: str
    bids: list[BookLevel]
    asks: list[BookLevel]

    @classmethod
    def from_clob(cls, raw: dict) -> "OrderBook":
        def levels(key: str) -> list[BookLevel]:
            out = []
            for lvl in raw.get(key) or []:
                price = _as_float(lvl.get("price"))
                size = _as_float(lvl.get("size"))
                if price > 0 and size > 0:
                    out.append(BookLevel(price=price, size=size))
            return out

        bids = sorted(levels("bids"), key=lambda l: l.price, reverse=True)
        asks = sorted(levels("asks"), key=lambda l: l.price)
        return cls(token_id=str(raw.get("asset_id", "")), bids=bids, asks=asks)

    @property
    def best_bid(self) -> Optional[float]:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> Optional[float]:
        return self.asks[0].price if self.asks else None

    @property
    def mid(self) -> Optional[float]:
        if self.best_bid is not None and self.best_ask is not None:
            return (self.best_bid + self.best_ask) / 2.0
        return self.best_bid if self.best_bid is not None else self.best_ask

    @property
    def spread(self) -> Optional[float]:
        if self.best_bid is not None and self.best_ask is not None:
            return self.best_ask - self.best_bid
        return None


@dataclass
class Trade:
    """A taker (aggressor) trade from the Data API."""

    asset_id: str
    side: str  # BUY or SELL, taker side
    price: float
    size: float  # shares
    timestamp: int
    wallet: str = ""
    outcome: str = ""

    @property
    def notional(self) -> float:
        return self.price * self.size

    @classmethod
    def from_data_api(cls, raw: dict) -> Optional["Trade"]:
        side = str(raw.get("side", "")).upper()
        if side not in ("BUY", "SELL"):
            return None
        price = _as_float(raw.get("price"))
        size = _as_float(raw.get("size"))
        if price <= 0 or size <= 0:
            return None
        return cls(
            asset_id=str(raw.get("asset", "")),
            side=side,
            price=price,
            size=size,
            timestamp=int(_as_float(raw.get("timestamp"))),
            wallet=str(raw.get("proxyWallet", "")),
            outcome=str(raw.get("outcome", "")),
        )


@dataclass
class TradeIdea:
    """A scored, directional (or market-making) trade idea."""

    market: Market
    kind: str  # FLOW_MOMENTUM | BOOK_PRESSURE | FLOW_FADE | LIQUIDITY_PROVISION
    direction: str  # outcome name to buy, or "BOTH" for market making
    entry_price: Optional[float]
    score: float  # 0-100
    signals: list[str] = field(default_factory=list)
    rationale: str = ""
    max_size_usd: float = 0.0  # sizing guide based on book depth

    def to_dict(self) -> dict:
        return {
            "market": self.market.question,
            "event": self.market.event_title,
            "slug": self.market.slug,
            "condition_id": self.market.condition_id,
            "kind": self.kind,
            "direction": self.direction,
            "entry_price": self.entry_price,
            "score": round(self.score, 1),
            "signals": self.signals,
            "rationale": self.rationale,
            "max_size_usd": round(self.max_size_usd, 0),
            "volume_24h": round(self.market.volume_24h, 0),
            "end_date": self.market.end_date,
        }
