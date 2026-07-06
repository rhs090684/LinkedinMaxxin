import time

from polymarket_ideas.metrics import compute_flow, compute_liquidity
from polymarket_ideas.models import Market, OrderBook, Trade

NOW = time.time()
T0 = "token-0"
T1 = "token-1"


def make_book(bids, asks):
    return OrderBook.from_clob(
        {
            "asset_id": T0,
            "bids": [{"price": str(p), "size": str(s)} for p, s in bids],
            "asks": [{"price": str(p), "size": str(s)} for p, s in asks],
        }
    )


def make_trade(asset, side, price, size, age_h=1.0, wallet="0xabc"):
    return Trade(
        asset_id=asset,
        side=side,
        price=price,
        size=size,
        timestamp=int(NOW - age_h * 3600),
        wallet=wallet,
    )


def test_book_parsing_sorts_and_computes_mid_spread():
    book = make_book(bids=[(0.50, 100), (0.55, 100)], asks=[(0.60, 100), (0.57, 100)])
    assert book.best_bid == 0.55
    assert book.best_ask == 0.57
    assert abs(book.mid - 0.56) < 1e-9
    assert abs(book.spread - 0.02) < 1e-9


def test_liquidity_depth_and_imbalance():
    # Bids: 0.55*1000 + 0.53*1000 within 5c of mid 0.56; ask: 0.57*500
    book = make_book(bids=[(0.55, 1000), (0.53, 1000), (0.40, 9999)], asks=[(0.57, 500)])
    liq = compute_liquidity(book)
    assert abs(liq.bid_depth_usd_5c - (0.55 * 1000 + 0.53 * 1000)) < 1e-6
    assert abs(liq.ask_depth_usd_5c - 0.57 * 500) < 1e-6
    assert liq.book_imbalance > 0.5  # bids dominate
    # The 0.40 bid is outside the 5c band but counts toward total depth.
    assert liq.total_depth_usd > liq.bid_depth_usd_5c + liq.ask_depth_usd_5c


def test_flow_sign_normalization_across_tokens():
    trades = [
        make_trade(T0, "BUY", 0.55, 1000),   # +550 toward token0
        make_trade(T1, "SELL", 0.45, 1000),  # sell of token1 == buy token0: +450
        make_trade(T0, "SELL", 0.55, 200),   # -110
    ]
    flow = compute_flow(trades, T0, now=NOW)
    assert abs(flow.buy_notional - (550 + 450)) < 1e-6
    assert abs(flow.sell_notional - 110) < 1e-6
    assert flow.flow_imbalance > 0.7


def test_flow_window_excludes_old_trades():
    trades = [
        make_trade(T0, "BUY", 0.5, 100, age_h=1),
        make_trade(T0, "BUY", 0.5, 100, age_h=48),  # outside 24h window
    ]
    flow = compute_flow(trades, T0, window_hours=24, now=NOW)
    assert flow.num_trades == 1


def test_whale_detection():
    trades = [
        make_trade(T0, "BUY", 0.5, 2000, wallet="0x1"),  # $1000 whale
        make_trade(T0, "SELL", 0.5, 50, wallet="0x2"),   # $25 retail
    ]
    flow = compute_flow(trades, T0, now=NOW)
    assert flow.whale_trades == 1
    assert abs(flow.whale_net_notional - 1000) < 1e-6
    assert flow.unique_wallets == 2


def test_price_change_from_trades():
    trades = [make_trade(T0, "BUY", 0.50 + i * 0.01, 100, age_h=20 - i) for i in range(10)]
    flow = compute_flow(trades, T0, now=NOW)
    assert flow.price_change > 0.05


def test_gamma_market_parsing_handles_json_strings():
    raw = {
        "conditionId": "0xabc",
        "question": "Chiefs vs. Bills",
        "slug": "chiefs-bills",
        "outcomes": '["Chiefs", "Bills"]',
        "outcomePrices": '["0.58", "0.42"]',
        "clobTokenIds": '["11", "22"]',
        "volume24hr": "12345.6",
        "liquidity": 5000,
        "endDate": "2026-07-07",
    }
    market = Market.from_gamma(raw, event_title="NFL")
    assert market is not None
    assert market.outcomes == ["Chiefs", "Bills"]
    assert market.clob_token_ids == ["11", "22"]
    assert abs(market.volume_24h - 12345.6) < 1e-6


def test_gamma_market_rejects_missing_tokens():
    assert Market.from_gamma({"outcomes": '["Yes","No"]', "clobTokenIds": "[]"}) is None
