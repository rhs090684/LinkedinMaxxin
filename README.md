# Polymarket Sports Trade Idea Generator

Scans active **sports markets on Polymarket** and generates ranked trade ideas from
**orderflow** (recent taker trades) and **liquidity** (order book depth) data, using
Polymarket's three public read-only APIs:

| API | Base URL | Used for |
|-----|----------|----------|
| Gamma | `https://gamma-api.polymarket.com` | Sports events/markets, tags, 24h volume |
| CLOB | `https://clob.polymarket.com` | Order books (`/book`), price history (`/prices-history`) |
| Data | `https://data-api.polymarket.com` | Recent taker trades (`/trades`) for orderflow |

No API key is required — all endpoints are public.

## Install & run

```bash
pip install -r requirements.txt

# Scan the whole sports tag (top markets by 24h volume)
python -m polymarket_ideas

# League-specific scan, JSON report
python -m polymarket_ideas --tag nba --events 30 --output json --out-file ideas.json

# Offline demo on synthetic data (no network needed)
python -m polymarket_ideas --mock
```

### Options

```
--tag         Gamma tag slug: sports, nba, nfl, mlb, epl, ... (default: sports)
--events      Max events to pull from Gamma (default: 25)
--markets     Max markets (by 24h volume) to deep-scan (default: 40)
--window      Orderflow lookback in hours (default: 24)
--min-volume  Skip markets under this 24h volume (default: 1000)
--min-score   Minimum idea score to display, 0-100 (default: 30)
--top         Max ideas to show (default: 15)
--output      console | json | md (default: console)
--out-file    Also write the report to a file
--mock        Run on deterministic synthetic data, no network
```

## How it works

For each market (top-N sports markets by 24h volume):

1. **Liquidity** — pulls the CLOB order book for the first outcome token and computes
   best bid/ask, spread, dollar depth within 5¢ of mid on each side, and
   **book imbalance** = (bid depth − ask depth) / total depth.
2. **Orderflow** — pulls recent taker trades from the Data API and normalizes every
   trade to the first outcome (a taker BUY of outcome B is a SELL of outcome A).
   Computes signed **flow imbalance**, total taker notional, whale trades (≥ $500),
   flow acceleration (recent third of window vs whole window), unique wallets, and
   the price change over the window (from CLOB price history when available).
3. **Idea generation** — scores four setup types (0–100):

| Setup | Trigger | Logic |
|-------|---------|-------|
| **Flow momentum** | Taker flow ≥ ±25% one-sided and the book isn't fighting it | Follow the flow; bonus for whale alignment, acceleration, tight spread |
| **Book pressure** | Resting depth ≥ ±40% lopsided with a tight spread | Lean with the wall — downside cushioned, thin side breaks easier |
| **Flow fade** | Heavy one-way flow (≥ ±35%) that *failed* to move price into an opposing wall | Exhaustion/absorption — take the contrarian side |
| **Market making** | Spread ≥ 3¢ on an actively traded game | Quote both sides and earn the spread from two-sided flow |

Filters: near-resolved markets (mid outside 5–95¢), thin books (< $1k within 5¢ of mid),
and quiet tapes (< $2k taker flow) never generate directional ideas. Each idea includes
a sizing guide capped at 10% of near-mid depth so the idea itself doesn't eat the book.

## Project layout

```
polymarket_ideas/
  api.py        # Gamma / CLOB / Data API clients (retries, throttling)
  models.py     # Market, OrderBook, Trade, TradeIdea containers + payload parsing
  metrics.py    # liquidity + orderflow metric computation
  ideas.py      # signal logic, scoring, ranking
  report.py     # console / JSON / markdown rendering
  mock_data.py  # deterministic synthetic universe for --mock and tests
  cli.py        # argparse CLI and scan pipeline
tests/          # 18 unit + end-to-end tests (run: python -m pytest)
```

## Disclaimer

Ideas rank **orderflow/liquidity setups only** — they do not model teams, injuries,
schedules, or news, and are **not financial advice**. Prediction markets carry real
risk of loss; check your local regulations before trading.
