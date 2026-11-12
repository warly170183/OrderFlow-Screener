// ============================================================
// SIGNAL TRACKER (live forward-test)
// Follows every emitted signal against subsequent prices and records how it
// played out, in R multiples (1R = the distance from entry to stop).
//
// Resolution rule — each signal is a single position that closes at the FIRST of:
//   • stop touched           → −1R
//   • TP2 (2R) touched       → +2R
//   • timeout                → mark-to-market R at that moment
// MFE / MAE (best and worst excursion in R) and the R at 5m / 15m / 60m are
// kept regardless of how the trade closed, so the score can be calibrated
// against several holding horizons.
//
// Resolution uses the prices it is fed (trade prints), so it can miss a touch
// that happened between prints. Treat results as an honest approximation.
// ============================================================

import type { Signal } from "./signalEngine";

export type Outcome = "stop" | "tp2" | "timeout";

export interface TrackedSignal {
  id: string;
  signal: Signal;
  status: "open" | "closed";
  /** Best (MFE) and worst (MAE) excursion so far, in R. MAE is ≤ 0. */
  mfeR: number;
  maeR: number;
  /** Highest TP reached before close: 0 none, 1 TP1, 2 TP2, 3 TP3 (TP3 only if touched before stop). */
  reached: 0 | 1 | 2 | 3;
  horizonsR: { m5?: number; m15?: number; m60?: number };
  outcome?: Outcome;
  resultR?: number;
  exitPrice?: number;
  closedAt?: number;
}

export interface BucketStats {
  n: number;
  winRate: number; // share with resultR > 0
  avgR: number; // expectancy per signal
  profitFactor: number | null; // gross win R / gross loss R; null if no losses
  avgMfeR: number;
  avgMaeR: number;
  /** Average R at fixed horizons (only signals old enough to have one). */
  avgR5m: number | null;
  avgR15m: number | null;
  avgR60m: number | null;
}

export interface TrackerStats {
  overall: BucketStats;
  byScore: Record<string, BucketStats>;
  bySetup: Record<string, BucketStats>;
  byDirection: Record<string, BucketStats>;
  openCount: number;
  closedCount: number;
  /** Below this many closed signals a bucket's numbers are noise. */
  minReliableSample: number;
}

export const MIN_RELIABLE_SAMPLE = 30;
export const DEFAULT_TIMEOUT_MS = 4 * 3_600_000;

const MINUTE = 60_000;

function rOf(signal: Signal, price: number): number {
  const risk = Math.abs(signal.plan.entry - signal.plan.stop);
  if (!(risk > 0)) return 0;
  const sign = signal.direction === "long" ? 1 : -1;
  return (sign * (price - signal.plan.entry)) / risk;
}

export class SignalTracker {
  private items: TrackedSignal[] = [];
  private seq = 0;

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  /** Start following a signal. Returns its tracking record. */
  open(signal: Signal): TrackedSignal {
    const item: TrackedSignal = {
      id: `${signal.symbol}-${signal.time}-${++this.seq}`,
      signal,
      status: "open",
      mfeR: 0,
      maeR: 0,
      reached: 0,
      horizonsR: {},
    };
    this.items.push(item);
    return item;
  }

  hasOpen(symbol: string): boolean {
    return this.items.some((i) => i.status === "open" && i.signal.symbol === symbol);
  }

  /** Feed a price for a symbol; returns signals that closed because of it. */
  onPrice(symbol: string, price: number, time: number): TrackedSignal[] {
    const closed: TrackedSignal[] = [];
    for (const item of this.items) {
      if (item.status !== "open" || item.signal.symbol !== symbol) continue;
      const { signal } = item;
      const age = time - signal.time;
      if (age < 0) continue;
      const r = rOf(signal, price);
      item.mfeR = Math.max(item.mfeR, r);
      item.maeR = Math.min(item.maeR, r);
      if (r >= 1 && item.reached < 1) item.reached = 1;
      if (r >= 2 && item.reached < 2) item.reached = 2;
      if (r >= 3 && item.reached < 3) item.reached = 3;
      if (age >= 5 * MINUTE && item.horizonsR.m5 === undefined) item.horizonsR.m5 = r;
      if (age >= 15 * MINUTE && item.horizonsR.m15 === undefined) item.horizonsR.m15 = r;
      if (age >= 60 * MINUTE && item.horizonsR.m60 === undefined) item.horizonsR.m60 = r;

      // The stop is checked before the target: when one print could satisfy
      // both, assume the worse outcome.
      if (r <= -1) this.close(item, "stop", -1, signal.plan.stop, time);
      else if (r >= 2) this.close(item, "tp2", 2, signal.plan.tp2, time);
      else if (age >= this.timeoutMs) this.close(item, "timeout", r, price, time);
      else continue;
      closed.push(item);
    }
    return closed;
  }

  private close(item: TrackedSignal, outcome: Outcome, resultR: number, exitPrice: number, time: number): void {
    item.status = "closed";
    item.outcome = outcome;
    item.resultR = resultR;
    item.exitPrice = exitPrice;
    item.closedAt = time;
  }

  all(): TrackedSignal[] {
    return this.items;
  }

  recent(limit = 50): TrackedSignal[] {
    return this.items.slice(-limit).reverse();
  }

  /** Drop closed records beyond `keep`, newest retained. */
  prune(keep = 5000): void {
    const closed = this.items.filter((i) => i.status === "closed");
    if (closed.length <= keep) return;
    const drop = new Set(closed.slice(0, closed.length - keep));
    this.items = this.items.filter((i) => !drop.has(i));
  }

  stats(): TrackerStats {
    const closed = this.items.filter((i) => i.status === "closed");
    const group = (key: (i: TrackedSignal) => string) => {
      const buckets: Record<string, TrackedSignal[]> = {};
      for (const i of closed) (buckets[key(i)] ??= []).push(i);
      return Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, summarize(v)]));
    };
    return {
      overall: summarize(closed),
      byScore: group((i) => (i.signal.score >= 80 ? "80+" : i.signal.score >= 70 ? "70-79" : "60-69")),
      bySetup: group((i) => i.signal.setup),
      byDirection: group((i) => i.signal.direction),
      openCount: this.items.length - closed.length,
      closedCount: closed.length,
      minReliableSample: MIN_RELIABLE_SAMPLE,
    };
  }

  // Persistence — plain JSON so the server can write it to disk.
  toJSON(): TrackedSignal[] {
    return this.items;
  }

  static fromJSON(items: TrackedSignal[], timeoutMs = DEFAULT_TIMEOUT_MS): SignalTracker {
    const tracker = new SignalTracker(timeoutMs);
    tracker.items = items;
    tracker.seq = items.length;
    return tracker;
  }
}

function avg(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function summarize(items: TrackedSignal[]): BucketStats {
  const closed = items.filter((i) => i.resultR !== undefined);
  const results = closed.map((i) => i.resultR as number);
  const wins = results.filter((r) => r > 0);
  const losses = results.filter((r) => r < 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgR: avg(results) ?? 0,
    profitFactor: grossLoss > 0 ? wins.reduce((a, b) => a + b, 0) / grossLoss : null,
    avgMfeR: avg(closed.map((i) => i.mfeR)) ?? 0,
    avgMaeR: avg(closed.map((i) => i.maeR)) ?? 0,
    avgR5m: avg(closed.flatMap((i) => (i.horizonsR.m5 === undefined ? [] : [i.horizonsR.m5]))),
    avgR15m: avg(closed.flatMap((i) => (i.horizonsR.m15 === undefined ? [] : [i.horizonsR.m15]))),
    avgR60m: avg(closed.flatMap((i) => (i.horizonsR.m60 === undefined ? [] : [i.horizonsR.m60]))),
  };
}
