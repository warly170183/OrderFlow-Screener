"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/Logo";
import type { ScanResult, ScreenerRow } from "@/lib/screener/screenerCore";
import type { BucketStats, TrackedSignal, TrackerStats } from "@/lib/signals/tracker";

const BASE = (process.env.NEXT_PUBLIC_SCREENER_URL || "http://localhost:8787").replace(/\/$/, "");
const TOKEN = process.env.NEXT_PUBLIC_SCREENER_TOKEN || "";

type Link_ = "connecting" | "live" | "down";

const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";
const authHeaders: HeadersInit = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

function useScreener() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [signals, setSignals] = useState<TrackedSignal[]>([]);
  const [stats, setStats] = useState<TrackerStats | null>(null);
  const [link, setLink] = useState<Link_>("connecting");

  useEffect(() => {
    const source = new EventSource(`${BASE}/api/stream${q}`);
    source.addEventListener("scan", (event) => {
      setScan(JSON.parse((event as MessageEvent).data) as ScanResult);
      setLink("live");
    });
    source.onerror = () => setLink("down");
    return () => source.close();
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, t] = await Promise.all([
          fetch(`${BASE}/api/signals?limit=30`, { headers: authHeaders }).then((r) => r.json()),
          fetch(`${BASE}/api/stats`, { headers: authHeaders }).then((r) => r.json()),
        ]);
        if (alive) {
          setSignals(s as TrackedSignal[]);
          setStats(t as TrackerStats);
        }
      } catch {
        // The stream status already reports connectivity.
      }
    };
    void load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return { scan, signals, stats, link };
}

// ─── Formatting ─────────────────────────────────────────────
const base = (symbol: string) => symbol.replace(/-USDT-SWAP$|USDT$/, "");
const pct = (v: number | null, digits = 2) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`);
const usd = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0));
const price = (p: number) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const tone = (v: number | null) => (v === null || v === 0 ? "text-[var(--text-muted)]" : v > 0 ? "text-[var(--buy)]" : "text-[var(--sell)]");

// The app's unlayered `* { margin: 0; padding: 0 }` reset beats Tailwind's layered utilities,
// so spacing utilities in this view carry `!` (important).
const card = "rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-panel)]";
const th = "px-2! py-1.5! text-right text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)] first:text-left";
const td = "px-2! py-1.5! text-right font-mono text-[12px] first:text-left";

function ScoreBadge({ row }: { row: ScreenerRow }) {
  const c = row.candidate;
  if (!c || c.score === 0) return <span className="text-[var(--text-muted)]">—</span>;
  const live = row.signal !== null;
  const color = c.direction === "long" ? "var(--buy)" : "var(--sell)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-1.5! py-0.5! font-mono text-[11px]"
      style={{ color: live ? color : "var(--text-secondary)", background: live ? `color-mix(in srgb, ${color} 14%, transparent)` : "transparent", border: `1px solid ${live ? color : "var(--border)"}` }}
      title={`${c.setup} ${c.direction}${live ? " — signal" : " — below threshold"}`}
    >
      {c.direction === "long" ? "▲" : "▼"} {c.score}
      <span className="text-[10px] opacity-70">{c.setup === "momentum" ? "MOM" : "REV"}</span>
    </span>
  );
}

function Table({ rows }: { rows: ScreenerRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {["Symbol", "Price", "5m", "1h", "Vol 1m", "Vol z", "Δ flow", "OI 5m", "Regime", "Funding/8h", "Liq L / S", "Score"].map((h) => (
              <th key={h} className={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className={`border-b border-[var(--border-muted)] hover:bg-[var(--bg-hover)] ${r.signal ? "bg-[var(--highlight-dim)]" : ""}`}>
              <td className={`${td} font-semibold text-[var(--text-primary)]`}>
                {base(r.symbol)}
                {!r.warmedUp && <span className="ml-1.5! text-[10px] font-normal text-[var(--warn)]" title="Warming up">warm-up</span>}
                {r.cascade && <span className="ml-1.5! text-[10px] font-normal text-[var(--sell)]">cascade</span>}
              </td>
              <td className={td}>{price(r.price)}</td>
              <td className={`${td} ${tone(r.change5m)}`}>{pct(r.change5m)}</td>
              <td className={`${td} ${tone(r.change1h)}`}>{pct(r.change1h)}</td>
              <td className={td}>${usd(r.volume1mUsd)}</td>
              <td className={`${td} ${r.volumeZ !== null && r.volumeZ >= 3 ? "text-[var(--highlight)]" : ""}`}>{r.volumeZ === null ? "—" : r.volumeZ.toFixed(1)}</td>
              <td className={`${td} ${tone(r.deltaShare)}`}>{r.deltaShare === null ? "—" : `${r.deltaShare >= 0 ? "+" : ""}${(r.deltaShare * 100).toFixed(0)}%`}</td>
              <td className={`${td} ${tone(r.oiChange5m)}`}>{pct(r.oiChange5m)}</td>
              <td className={`${td} text-[var(--text-secondary)]`}>{r.oiRegime && r.oiRegime !== "neutral" ? r.oiRegime.replace("-", " ") : "—"}</td>
              <td className={`${td} ${r.fundingRate8h !== null && Math.abs(r.fundingRate8h) >= 0.0005 ? "text-[var(--warn)]" : ""}`}>{r.fundingRate8h === null ? "—" : `${(r.fundingRate8h * 100).toFixed(3)}%`}</td>
              <td className={td}>
                <span className="text-[var(--sell)]">{usd(r.liqLong5mUsd)}</span> / <span className="text-[var(--buy)]">{usd(r.liqShort5mUsd)}</span>
              </td>
              <td className={td}><ScoreBadge row={r} /></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={12} className="px-2! py-8! text-center text-[var(--text-muted)]">Waiting for the first scan…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SignalList({ items }: { items: TrackedSignal[] }) {
  if (!items.length) return <p className="p-4! text-[12px] text-[var(--text-muted)]">No signals yet. Symbols need a few minutes of warm-up before they can fire.</p>;
  return (
    <ul className="divide-y divide-[var(--border-muted)]">
      {items.map((t) => {
        const s = t.signal;
        const color = s.direction === "long" ? "var(--buy)" : "var(--sell)";
        return (
          <li key={t.id} className="px-3! py-2! text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold" style={{ color }}>{s.direction === "long" ? "▲ LONG" : "▼ SHORT"} {base(s.symbol)}</span>
              <span className="font-mono text-[var(--text-secondary)]">score {s.score} · {s.setup}</span>
            </div>
            <div className="mt-0.5! font-mono text-[11px] text-[var(--text-secondary)]">
              E {price(s.plan.entry)} · SL {price(s.plan.stop)} · TP1 {price(s.plan.tp1)} · TP2 {price(s.plan.tp2)} · TP3 {price(s.plan.tp3)}
            </div>
            <div className="mt-0.5! flex justify-between text-[11px] text-[var(--text-muted)]">
              <span>{new Date(s.time).toLocaleTimeString()}</span>
              <span className={t.status === "open" ? "text-[var(--warn)]" : (t.resultR ?? 0) > 0 ? "text-[var(--buy)]" : "text-[var(--sell)]"}>
                {t.status === "open" ? `open · ${t.mfeR.toFixed(1)}R max` : `${t.outcome} ${(t.resultR ?? 0) >= 0 ? "+" : ""}${(t.resultR ?? 0).toFixed(2)}R`}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StatsTable({ stats }: { stats: TrackerStats }) {
  const rows: Array<[string, BucketStats]> = [["All", stats.overall], ...Object.entries(stats.byScore).sort(([a], [b]) => a.localeCompare(b)), ...Object.entries(stats.bySetup)];
  const thin = stats.closedCount < stats.minReliableSample;
  return (
    <div>
      {thin && (
        <p className="border-b border-[var(--border-muted)] px-3! py-2! text-[11px] text-[var(--warn)]">
          Only {stats.closedCount} closed signal{stats.closedCount === 1 ? "" : "s"}; below {stats.minReliableSample} these numbers are noise, not evidence.
        </p>
      )}
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {["Bucket", "n", "Win", "Avg R", "PF", "MFE", "MAE"].map((h) => <th key={h} className={th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, b]) => (
            <tr key={name} className="border-b border-[var(--border-muted)]">
              <td className={`${td} text-[var(--text-primary)]`}>{name}</td>
              <td className={td}>{b.n}</td>
              <td className={td}>{(b.winRate * 100).toFixed(0)}%</td>
              <td className={`${td} ${tone(b.avgR)}`}>{b.avgR.toFixed(2)}</td>
              <td className={td}>{b.profitFactor === null ? "—" : b.profitFactor.toFixed(2)}</td>
              <td className={td}>{b.avgMfeR.toFixed(2)}</td>
              <td className={td}>{b.avgMaeR.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3! py-2! text-[11px] text-[var(--text-muted)]">{stats.openCount} open · {stats.closedCount} closed. R = distance from entry to stop; trades close at stop (−1R), TP2 (+2R) or after 4 h.</p>
    </div>
  );
}

export default function ScreenerView() {
  const { scan, signals, stats, link } = useScreener();
  const rows = scan?.rows ?? [];
  const status = { connecting: ["Connecting…", "var(--warn)"], live: ["Live", "var(--buy)"], down: [`No connection to ${BASE}`, "var(--sell)"] }[link];

  return (
    <div className="min-h-screen bg-[var(--bg-base)] p-3! text-[var(--text-primary)]" style={{ fontFamily: "var(--font-ui)" }}>
      <header className="mb-3! flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link href="/" aria-label="orderflow terminal"><Wordmark size={26} /></Link>
          <h1 className="text-[15px] font-semibold">Screener</h1>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-[var(--text-muted)]">{rows.length} symbols</span>
          <span className="inline-flex items-center gap-1.5" style={{ color: status[1] }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: status[1] }} />
            {status[0]}
          </span>
          <Link href="/" className="ui-button">Terminal</Link>
        </div>
      </header>

      {link === "down" && (
        <div className={`${card} mb-3! p-3! text-[12px] text-[var(--text-secondary)]`}>
          Start the service with <code className="font-mono text-[var(--text-accent)]">npm run server</code>. The page reads it from{" "}
          <code className="font-mono">NEXT_PUBLIC_SCREENER_URL</code> (default <code className="font-mono">http://localhost:8787</code>).
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[1fr_380px]">
        <section className={`${card} overflow-hidden`}><Table rows={rows} /></section>
        <div className="flex flex-col gap-3">
          <section className={`${card} overflow-hidden`}>
            <h2 className="border-b border-[var(--border)] px-3! py-2! text-[12px] font-semibold">Signals</h2>
            <div className="max-h-[420px] overflow-y-auto"><SignalList items={signals} /></div>
          </section>
          <section className={`${card} overflow-hidden`}>
            <h2 className="border-b border-[var(--border)] px-3! py-2! text-[12px] font-semibold">Forward test</h2>
            {stats ? <StatsTable stats={stats} /> : <p className="p-4! text-[12px] text-[var(--text-muted)]">No data yet.</p>}
          </section>
        </div>
      </div>
      <p className="mt-3! text-[11px] text-[var(--text-muted)]">Scores are heuristics, not validated predictions or advice. Judge them by the forward test above.</p>
    </div>
  );
}
