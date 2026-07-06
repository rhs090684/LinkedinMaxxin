"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScanResult, TradeIdea } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  FLOW_MOMENTUM: "Flow momentum",
  BOOK_PRESSURE: "Book pressure",
  FLOW_FADE: "Flow fade",
  LIQUIDITY_PROVISION: "Market making",
};

const TAGS = ["sports", "nba", "nfl", "mlb", "nhl", "epl", "soccer", "tennis"];

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

function IdeaCard({ idea }: { idea: TradeIdea }) {
  const trade =
    idea.direction === "BOTH" ? (
      <span className="direction">Quote both sides</span>
    ) : (
      <span className="direction">
        <span className="arrow">BUY</span> {idea.direction}
      </span>
    );
  return (
    <div className="card">
      <div className="score">
        <span className="num">{Math.round(idea.score)}</span>
        <span className="lbl">score</span>
      </div>
      <div className="card-main">
        <div className="card-head">
          <span className={`kind ${idea.kind}`}>{KIND_LABELS[idea.kind]}</span>
          {trade}
          {idea.entryPrice !== null && (
            <span className="entry">@ {idea.entryPrice.toFixed(3)}</span>
          )}
        </div>
        <div className="question">{idea.question}</div>
        <ul className="signals">
          {idea.signals.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        <p className="rationale">{idea.rationale}</p>
      </div>
      <div className="card-side">
        <div className="stat">
          24h vol<br />
          <b>{fmtUsd(idea.volume24h)}</b>
        </div>
        <div className="stat">
          max size<br />
          <b>{fmtUsd(idea.maxSizeUsd)}</b>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [tag, setTag] = useState("sports");
  const [minScore, setMinScore] = useState(30);
  const [top, setTop] = useState(20);
  const [useMock, setUseMock] = useState(false);
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tag,
        minScore: String(minScore),
        top: String(top),
      });
      if (useMock) params.set("source", "mock");
      const resp = await fetch(`/api/ideas?${params}`);
      if (!resp.ok) throw new Error(`request failed: ${resp.status}`);
      setData((await resp.json()) as ScanResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tag, minScore, top, useMock]);

  // Initial load.
  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <h1 className="title">
            Polymarket Sports Trade Ideas<span className="dot">.</span>
          </h1>
          <p className="subtitle">
            Ranked trade setups generated from live orderflow (taker trades) and
            liquidity (order-book depth) across active Polymarket sports markets.
          </p>
        </div>
      </div>

      <div className="controls">
        <div className="field">
          <label>Category</label>
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            {TAGS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Min score</label>
          <input
            type="number"
            min={0}
            max={100}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>Max ideas</label>
          <input
            type="number"
            min={1}
            max={50}
            value={top}
            onChange={(e) => setTop(Number(e.target.value))}
          />
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={useMock}
            onChange={(e) => setUseMock(e.target.checked)}
          />
          Demo data
        </label>
        <button className="scan" onClick={scan} disabled={loading}>
          {loading ? "Scanning…" : "Scan markets"}
        </button>
      </div>

      {data && (
        <div className="meta-row">
          <span className={`badge-src ${data.source}`}>
            {data.source === "live" ? "LIVE" : "DEMO DATA"}
          </span>
          <span>{data.marketsScanned} markets scanned</span>
          <span>{data.ideas.length} ideas</span>
          <span>{new Date(data.generatedAt).toLocaleString()}</span>
        </div>
      )}

      {data?.errors?.length ? (
        <div className="errbar">{data.errors[0]}</div>
      ) : null}

      {loading && !data && (
        <div className="loading">
          <span className="spinner" />
          Scanning Polymarket order books and orderflow…
        </div>
      )}

      {error && <div className="error">Error: {error}</div>}

      {data && !loading && data.ideas.length === 0 && (
        <div className="empty">
          No setups cleared the score threshold. Try lowering min score, picking
          a busier category, or toggling demo data.
        </div>
      )}

      <div className="cards">
        {data?.ideas.map((idea, i) => (
          <IdeaCard key={`${idea.conditionId}-${idea.kind}-${i}`} idea={idea} />
        ))}
      </div>

      {data && (
        <p className="disclaimer">
          {data.disclaimer} Prediction markets carry real risk of loss; check
          your local regulations before trading. Data from Polymarket&apos;s
          public Gamma, CLOB, and Data APIs.
        </p>
      )}
    </div>
  );
}
