# Polymarket Sports Trade Idea Generator

A **Next.js web app** (deployable to Vercel) that scans active **sports markets on
Polymarket** and generates ranked trade ideas from **orderflow** (recent taker trades)
and **liquidity** (order-book depth) data, using Polymarket's three public read-only APIs:

| API | Base URL | Used for |
|-----|----------|----------|
| Gamma | `https://gamma-api.polymarket.com` | Sports events/markets, tags, 24h volume |
| CLOB | `https://clob.polymarket.com` | Order books (`/book`), price history (`/prices-history`) |
| Data | `https://data-api.polymarket.com` | Recent taker trades (`/trades`) for orderflow |

No API key is required — all endpoints are public.

## Deploy to Vercel

The repo is a standard Next.js app at its root, so Vercel auto-detects everything:

1. Push this branch to GitHub (already done).
2. Go to [vercel.com/new](https://vercel.com/new) and **import** `rhs090684/LinkedinMaxxin`.
3. Framework preset **Next.js** is detected automatically — no build settings, no env vars needed.
4. Click **Deploy**. Every future push to the repo redeploys via Vercel's GitHub app.

The idea scan runs in a Node.js serverless function (`app/api/ideas/route.ts`,
`maxDuration = 60`) which calls the Polymarket APIs server-side at request time.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm test           # TypeScript test suite (node:test via tsx)
```

The dashboard has a **Demo data** toggle that uses a deterministic synthetic universe,
so it renders even without network access to Polymarket (e.g. in a sandbox). If a live
scan fails, the API automatically falls back to demo data and shows a banner.

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

### API endpoint

`GET /api/ideas` returns the ranked ideas as JSON. Query params:

```
tag        sports | nba | nfl | mlb | nhl | epl | soccer | tennis   (default: sports)
events     max events to pull from Gamma          (default: 25)
markets    max markets to deep-scan               (default: 18)
window     orderflow lookback in hours            (default: 24)
minVolume  skip markets under this 24h volume      (default: 1000)
minScore   minimum idea score to return, 0-100     (default: 30)
top        max ideas to return                     (default: 20)
source     set to "mock" to force demo data
```

## Project layout

```
app/
  page.tsx           # dashboard UI (client component)
  layout.tsx         # root layout
  globals.css        # dark trading-dashboard styles
  api/ideas/route.ts # serverless scan endpoint (Node.js runtime)
lib/
  types.ts           # shared types
  parse.ts           # Gamma/CLOB/Data payload parsing + book helpers
  polymarket.ts      # API clients + concurrency pool
  metrics.ts         # liquidity + orderflow metric computation
  ideas.ts           # signal logic, scoring, ranking
  mock.ts            # deterministic synthetic universe for demo/tests
  scan.ts            # scan orchestration (live + mock)
test/                # node:test suite for the engine

polymarket_ideas/    # original Python CLI (still runnable; see below)
tests/               # pytest suite for the Python version
```

## Python CLI (original version)

The first cut of this project was a Python CLI, still included and functional:

```bash
pip install -r requirements.txt
python -m polymarket_ideas --tag nba          # live scan
python -m polymarket_ideas --mock             # offline demo
python -m pytest tests/                        # 18 tests
```

Vercel ignores the Python package and builds only the Next.js app.

## Disclaimer

Ideas rank **orderflow/liquidity setups only** — they do not model teams, injuries,
schedules, or news, and are **not financial advice**. Prediction markets carry real
risk of loss; check your local regulations before trading.
