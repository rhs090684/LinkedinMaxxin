"""Console / JSON / Markdown rendering of ranked trade ideas."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from .models import TradeIdea

KIND_LABELS = {
    "FLOW_MOMENTUM": "Flow momentum",
    "BOOK_PRESSURE": "Book pressure",
    "FLOW_FADE": "Flow fade",
    "LIQUIDITY_PROVISION": "Market making",
}

DISCLAIMER = (
    "Ideas rank orderflow/liquidity setups only - they do not model teams, injuries, or news, "
    "and are not financial advice."
)


def render_console(ideas: list[TradeIdea], scanned: int) -> str:
    lines = []
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append(f"Polymarket sports trade ideas - {stamp} - scanned {scanned} markets")
    lines.append("=" * 100)
    if not ideas:
        lines.append("No setups cleared the score threshold. Try --min-score or a busier slate.")
        return "\n".join(lines)
    for rank, idea in enumerate(ideas, 1):
        entry = f"{idea.entry_price:.3f}" if idea.entry_price is not None else "n/a"
        header = (
            f"#{rank:<2} [{idea.score:5.1f}] {KIND_LABELS.get(idea.kind, idea.kind):<14} "
            f"{'BUY ' + idea.direction if idea.direction != 'BOTH' else 'QUOTE BOTH SIDES'} @ {entry}"
        )
        lines.append(header)
        lines.append(f"    {idea.market.question}  (24h vol ${idea.market.volume_24h:,.0f})")
        for sig in idea.signals:
            lines.append(f"      - {sig}")
        lines.append(f"    why: {idea.rationale}")
        lines.append(f"    sizing guide: <= ${idea.max_size_usd:,.0f} (10% of near-mid depth)")
        lines.append("-" * 100)
    lines.append(DISCLAIMER)
    return "\n".join(lines)


def render_json(ideas: list[TradeIdea], scanned: int) -> str:
    return json.dumps(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "markets_scanned": scanned,
            "disclaimer": DISCLAIMER,
            "ideas": [i.to_dict() for i in ideas],
        },
        indent=2,
    )


def render_markdown(ideas: list[TradeIdea], scanned: int) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Polymarket Sports Trade Ideas",
        f"_Generated {stamp} - {scanned} markets scanned_",
        "",
        "| # | Score | Type | Trade | Entry | Market | 24h Vol | Max Size |",
        "|---|-------|------|-------|-------|--------|---------|----------|",
    ]
    for rank, idea in enumerate(ideas, 1):
        trade = f"BUY {idea.direction}" if idea.direction != "BOTH" else "Quote both sides"
        entry = f"{idea.entry_price:.3f}" if idea.entry_price is not None else "n/a"
        lines.append(
            f"| {rank} | {idea.score:.0f} | {KIND_LABELS.get(idea.kind, idea.kind)} | {trade} | {entry} "
            f"| {idea.market.question} | ${idea.market.volume_24h:,.0f} | ${idea.max_size_usd:,.0f} |"
        )
    lines.append("")
    for rank, idea in enumerate(ideas, 1):
        lines.append(f"### {rank}. {idea.market.question}")
        lines.append(f"**{KIND_LABELS.get(idea.kind, idea.kind)}** - score {idea.score:.0f}")
        lines.append("")
        for sig in idea.signals:
            lines.append(f"- {sig}")
        lines.append("")
        lines.append(idea.rationale)
        lines.append("")
    lines.append(f"> {DISCLAIMER}")
    return "\n".join(lines)
