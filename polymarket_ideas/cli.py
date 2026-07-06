"""CLI entry point: scan Polymarket sports markets and print ranked trade ideas.

Examples:
    python -m polymarket_ideas                       # scan the whole sports tag
    python -m polymarket_ideas --tag nba --events 30
    python -m polymarket_ideas --output json --out-file ideas.json
    python -m polymarket_ideas --mock                # offline demo with synthetic data
"""

from __future__ import annotations

import argparse
import logging
import sys

from .ideas import generate_ideas, rank_ideas
from .metrics import compute_flow, compute_liquidity
from .models import Market, OrderBook, Trade, TradeIdea
from .report import render_console, render_json, render_markdown

log = logging.getLogger("polymarket_ideas")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="polymarket_ideas",
        description="Generate orderflow/liquidity-based trade ideas for Polymarket sports markets.",
    )
    p.add_argument("--tag", default="sports", help="Gamma tag slug: sports, nba, nfl, mlb, epl, ... (default: sports)")
    p.add_argument("--events", type=int, default=25, help="Max events to pull from Gamma (default: 25)")
    p.add_argument("--markets", type=int, default=40, help="Max markets (by 24h volume) to deep-scan (default: 40)")
    p.add_argument("--window", type=float, default=24.0, help="Orderflow lookback window in hours (default: 24)")
    p.add_argument("--min-volume", type=float, default=1_000.0, help="Skip markets under this 24h volume (default: 1000)")
    p.add_argument("--min-score", type=float, default=30.0, help="Minimum idea score to show (default: 30)")
    p.add_argument("--top", type=int, default=15, help="Max ideas to show (default: 15)")
    p.add_argument("--output", choices=["console", "json", "md"], default="console")
    p.add_argument("--out-file", help="Also write the report to this path")
    p.add_argument("--mock", action="store_true", help="Run offline on synthetic data (no network)")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def scan_live(args) -> tuple[list[TradeIdea], int]:
    from .api import PolymarketClient

    client = PolymarketClient()
    markets = client.get_markets(tag_slug=args.tag, limit=args.events)
    markets = [m for m in markets if m.volume_24h >= args.min_volume]
    markets.sort(key=lambda m: m.volume_24h, reverse=True)
    markets = markets[: args.markets]
    log.info("deep-scanning %d markets", len(markets))

    ideas: list[TradeIdea] = []
    for market in markets:
        token0 = market.clob_token_ids[0]
        try:
            book = client.get_order_book(token0)
        except Exception as exc:  # noqa: BLE001 - skip broken markets, keep scanning
            log.warning("book fetch failed for %s: %s", market.slug, exc)
            continue
        trades = client.get_trades(market.condition_id)
        history = client.get_price_history(token0)
        liq = compute_liquidity(book)
        flow = compute_flow(trades, token0, window_hours=args.window, price_history=history)
        ideas.extend(generate_ideas(market, liq, flow))
    return ideas, len(markets)


def scan_mock(args) -> tuple[list[TradeIdea], int]:
    from .mock_data import mock_universe

    ideas: list[TradeIdea] = []
    universe = mock_universe()
    for entry in universe:
        market = Market.from_gamma(entry["market_raw"], event_title=entry["event_title"], tags=entry["tags"])
        if market is None or market.volume_24h < args.min_volume:
            continue
        book = OrderBook.from_clob(entry["book0"])
        trades = [t for t in (Trade.from_data_api(r) for r in entry["trades"]) if t is not None]
        liq = compute_liquidity(book)
        flow = compute_flow(trades, market.clob_token_ids[0], window_hours=args.window)
        ideas.extend(generate_ideas(market, liq, flow))
    return ideas, len(universe)


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    try:
        ideas, scanned = scan_mock(args) if args.mock else scan_live(args)
    except Exception as exc:  # noqa: BLE001
        print(f"error: scan failed: {exc}", file=sys.stderr)
        return 1

    ranked = rank_ideas(ideas, min_score=args.min_score, top=args.top)
    renderer = {"console": render_console, "json": render_json, "md": render_markdown}[args.output]
    report = renderer(ranked, scanned)
    print(report)
    if args.out_file:
        with open(args.out_file, "w", encoding="utf-8") as fh:
            fh.write(report + "\n")
        print(f"\nwritten to {args.out_file}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
