from polymarket_ideas.ideas import generate_ideas, rank_ideas
from polymarket_ideas.metrics import FlowMetrics, LiquidityMetrics
from polymarket_ideas.models import Market


def make_market(mid=0.55, vol=50_000.0):
    return Market(
        condition_id="0xabc",
        question="Chiefs vs. Bills - Moneyline",
        slug="chiefs-bills",
        event_title="Chiefs vs. Bills",
        outcomes=["Chiefs", "Bills"],
        outcome_prices=[mid, 1 - mid],
        clob_token_ids=["11", "22"],
        volume_24h=vol,
        liquidity=vol / 4,
        end_date="2026-07-07",
    )


def make_liq(mid=0.55, spread=0.01, bid_usd=8_000.0, ask_usd=8_000.0):
    total = bid_usd + ask_usd
    return LiquidityMetrics(
        best_bid=mid - spread / 2,
        best_ask=mid + spread / 2,
        mid=mid,
        spread=spread,
        bid_depth_usd_5c=bid_usd,
        ask_depth_usd_5c=ask_usd,
        book_imbalance=(bid_usd - ask_usd) / total if total else 0.0,
        total_depth_usd=total * 2,
    )


def make_flow(imb=0.0, notional=20_000.0, price_change=0.0, accel=0.0, whale_net=0.0):
    buy = notional * (1 + imb) / 2
    sell = notional - buy
    return FlowMetrics(
        buy_notional=buy,
        sell_notional=sell,
        flow_imbalance=imb,
        num_trades=150,
        avg_trade_usd=notional / 150,
        whale_net_notional=whale_net,
        whale_trades=3 if whale_net else 0,
        unique_wallets=60,
        recent_accel=accel,
        price_change=price_change,
    )


def kinds(ideas):
    return {i.kind for i in ideas}


def test_flow_momentum_fires_and_points_at_flow_side():
    ideas = generate_ideas(
        make_market(),
        make_liq(bid_usd=10_000, ask_usd=6_000),
        make_flow(imb=0.5, accel=0.1, whale_net=5_000),
    )
    momentum = [i for i in ideas if i.kind == "FLOW_MOMENTUM"]
    assert momentum, f"expected momentum idea, got {kinds(ideas)}"
    idea = momentum[0]
    assert idea.direction == "Chiefs"
    assert idea.score > 50
    assert idea.entry_price == make_liq().best_ask


def test_negative_flow_targets_second_outcome():
    ideas = generate_ideas(
        make_market(),
        make_liq(bid_usd=5_000, ask_usd=9_000),
        make_flow(imb=-0.5),
    )
    momentum = [i for i in ideas if i.kind == "FLOW_MOMENTUM"]
    assert momentum and momentum[0].direction == "Bills"


def test_momentum_blocked_by_strongly_opposing_book():
    ideas = generate_ideas(
        make_market(),
        make_liq(bid_usd=2_000, ask_usd=14_000),  # book imbalance ~ -0.75
        make_flow(imb=0.5),
    )
    assert "FLOW_MOMENTUM" not in kinds(ideas)


def test_book_pressure_fires_on_stacked_tight_book():
    ideas = generate_ideas(
        make_market(),
        make_liq(spread=0.01, bid_usd=15_000, ask_usd=3_000),
        make_flow(imb=0.05, notional=3_000),
    )
    assert "BOOK_PRESSURE" in kinds(ideas)


def test_flow_fade_fires_when_flow_hits_wall_without_price_move():
    ideas = generate_ideas(
        make_market(),
        make_liq(bid_usd=16_000, ask_usd=4_000),  # thick bid wall
        make_flow(imb=-0.6, price_change=0.001, accel=0.2),  # heavy selling, price flat
    )
    fades = [i for i in ideas if i.kind == "FLOW_FADE"]
    assert fades, f"expected fade, got {kinds(ideas)}"
    assert fades[0].direction == "Chiefs"  # fade the selling by buying outcome0


def test_liquidity_provision_on_wide_spread():
    ideas = generate_ideas(
        make_market(vol=80_000),
        make_liq(spread=0.05),
        make_flow(imb=0.05, notional=10_000),
    )
    mm = [i for i in ideas if i.kind == "LIQUIDITY_PROVISION"]
    assert mm and mm[0].direction == "BOTH"


def test_extreme_priced_markets_are_skipped():
    ideas = generate_ideas(make_market(mid=0.97), make_liq(mid=0.97), make_flow(imb=0.6))
    assert ideas == []


def test_thin_markets_produce_no_directional_ideas():
    ideas = generate_ideas(
        make_market(vol=500),
        make_liq(bid_usd=200, ask_usd=200, spread=0.01),
        make_flow(imb=0.6, notional=300),
    )
    assert not {"FLOW_MOMENTUM", "BOOK_PRESSURE", "FLOW_FADE"} & kinds(ideas)


def test_rank_ideas_filters_and_sorts():
    a = generate_ideas(make_market(), make_liq(bid_usd=10_000, ask_usd=6_000), make_flow(imb=0.5, whale_net=5_000))
    ranked = rank_ideas(a, min_score=30, top=5)
    assert ranked == sorted(ranked, key=lambda i: i.score, reverse=True)
    assert all(i.score >= 30 for i in ranked)


def test_mock_pipeline_end_to_end():
    from polymarket_ideas.cli import build_parser, scan_mock

    args = build_parser().parse_args(["--mock"])
    ideas, scanned = scan_mock(args)
    assert scanned == 5
    ranked = rank_ideas(ideas, min_score=30, top=15)
    assert ranked, "mock universe should produce at least one idea"
    # The near-resolved Djokovic market must never appear.
    assert all("Djokovic" not in i.market.question for i in ranked)
