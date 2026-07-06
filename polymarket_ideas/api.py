"""HTTP clients for Polymarket's public APIs.

Three read-only, no-auth APIs are used:

- Gamma API   https://gamma-api.polymarket.com  -> events/markets metadata (sports tags)
- CLOB API    https://clob.polymarket.com       -> order books, price history
- Data API    https://data-api.polymarket.com   -> recent taker trades (orderflow)
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .models import Market, OrderBook, Trade

log = logging.getLogger(__name__)

GAMMA_BASE = "https://gamma-api.polymarket.com"
CLOB_BASE = "https://clob.polymarket.com"
DATA_BASE = "https://data-api.polymarket.com"


def _session() -> requests.Session:
    sess = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    adapter = HTTPAdapter(max_retries=retry)
    sess.mount("https://", adapter)
    sess.headers.update({"User-Agent": "polymarket-trade-ideas/0.1"})
    return sess


class PolymarketClient:
    """Thin client over the three public Polymarket APIs."""

    def __init__(self, timeout: float = 15.0, throttle_s: float = 0.15):
        self.sess = _session()
        self.timeout = timeout
        self.throttle_s = throttle_s
        self._last_call = 0.0

    def _get(self, url: str, params: Optional[dict] = None):
        # Basic politeness throttle so scanning many markets doesn't hammer the API.
        wait = self.throttle_s - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()
        resp = self.sess.get(url, params=params, timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ Gamma

    def get_sports_events(self, tag_slug: str = "sports", limit: int = 50) -> list[dict]:
        """Active (not closed) events for a tag, ordered by 24h volume."""
        events: list[dict] = []
        offset = 0
        page = min(limit, 100)
        while len(events) < limit:
            batch = self._get(
                f"{GAMMA_BASE}/events",
                params={
                    "tag_slug": tag_slug,
                    "closed": "false",
                    "active": "true",
                    "order": "volume24hr",
                    "ascending": "false",
                    "limit": page,
                    "offset": offset,
                },
            )
            if not isinstance(batch, list) or not batch:
                break
            events.extend(batch)
            if len(batch) < page:
                break
            offset += page
        return events[:limit]

    def get_markets(self, tag_slug: str = "sports", limit: int = 50) -> list[Market]:
        """Flatten events into Market objects, keeping only tradable binaries."""
        markets: list[Market] = []
        for event in self.get_sports_events(tag_slug=tag_slug, limit=limit):
            title = str(event.get("title", ""))
            tags = [str(t.get("slug", "")) for t in (event.get("tags") or []) if isinstance(t, dict)]
            for raw in event.get("markets") or []:
                if raw.get("closed") or raw.get("archived"):
                    continue
                if raw.get("enableOrderBook") is False:
                    continue
                market = Market.from_gamma(raw, event_title=title, tags=tags)
                if market is not None:
                    markets.append(market)
        return markets

    # ------------------------------------------------------------------- CLOB

    def get_order_book(self, token_id: str) -> OrderBook:
        raw = self._get(f"{CLOB_BASE}/book", params={"token_id": token_id})
        return OrderBook.from_clob(raw)

    def get_price_history(self, token_id: str, interval: str = "1d", fidelity: int = 30) -> list[tuple[int, float]]:
        """[(unix_ts, price), ...] for one token; empty list on failure."""
        try:
            raw = self._get(
                f"{CLOB_BASE}/prices-history",
                params={"market": token_id, "interval": interval, "fidelity": fidelity},
            )
        except requests.RequestException as exc:
            log.warning("price history failed for %s: %s", token_id, exc)
            return []
        points = raw.get("history") or []
        return [(int(p["t"]), float(p["p"])) for p in points if "t" in p and "p" in p]

    # --------------------------------------------------------------- Data API

    def get_trades(self, condition_id: str, limit: int = 500) -> list[Trade]:
        """Recent taker trades for a market (both outcome tokens)."""
        try:
            raw = self._get(
                f"{DATA_BASE}/trades",
                params={"market": condition_id, "limit": min(limit, 500), "takerOnly": "true"},
            )
        except requests.RequestException as exc:
            log.warning("trades fetch failed for %s: %s", condition_id, exc)
            return []
        trades = []
        for item in raw if isinstance(raw, list) else []:
            trade = Trade.from_data_api(item)
            if trade is not None:
                trades.append(trade)
        return trades
