// ============================================================
// SCREENER CORE
// Runs many SymbolTrackers side by side, ranks them by the strength of the
// best current setup, emits NEW signals (with cooldown and warm-up) and
// forwards prices to the SignalTracker so every emitted signal is followed.
//
// Pure and feed-agnostic: the server (or a test) pushes normalized events in
// and calls scan() on a timer. No sockets, no clocks, no I/O.
// ============================================================

import { evaluateSignal, MIN_SIGNAL_SCORE, type Signal } from "@/lib/signals/signalEngine";
import { SignalTracker, type TrackedSignal } from "@/lib/signals/tracker";
import type { DerivativesSnapshot, NormalizedLiquidation, NormalizedTrade } from "@/lib/types/market";
import { DEFAULT_TRACKER_OPTIONS, SymbolTracker, type SymbolMetrics, type TrackerOptions } from "./symbolTracker";

export interface ScreenerOptions {
  minScore: number;
  /** No signals until a symbol has been observed this long and seen this many trades. */
  warmupMs: number;
  warmupTrades: number;
  /** After a signal, the same symbol+direction is muted for this long. */
  cooldownMs: number;
  /** Ignore symbols trading less than this notional per minute (illiquid noise). */
  minVolume1mUsd: number;
  tracker: TrackerOptions;
}

export const DEFAULT_SCREENER_OPTIONS: ScreenerOptions = {
  minScore: MIN_SIGNAL_SCORE,
  warmupMs: 5 * 60_000,
  warmupTrades: 100,
  cooldownMs: 10 * 60_000,
  minVolume1mUsd: 20_000,
  tracker: DEFAULT_TRACKER_OPTIONS,
};

export interface ScreenerRow extends SymbolMetrics {
  warmedUp: boolean;
  /** Best setup right now, even below the signal threshold (0 if none). */
  candidate: { direction: Signal["direction"]; setup: Signal["setup"]; score: number } | null;
  /** The candidate if it clears the threshold and the symbol is warm and liquid. */
  signal: Signal | null;
}

export interface ScanResult {
  time: number;
  rows: ScreenerRow[];
  /** Signals first emitted by this scan. */
  newSignals: Signal[];
  /** Signals that were closed by prices seen since the last scan. */
  closed: TrackedSignal[];
}

export class ScreenerCore {
  private trackers = new Map<string, SymbolTracker>();
  private lastSignalAt = new Map<string, number>();
  private pendingClosed: TrackedSignal[] = [];
  readonly outcomes: SignalTracker;
  readonly options: ScreenerOptions;

  constructor(options: Partial<ScreenerOptions> = {}, outcomes: SignalTracker = new SignalTracker()) {
    this.options = { ...DEFAULT_SCREENER_OPTIONS, ...options };
    this.outcomes = outcomes;
  }

  symbols(): string[] {
    return [...this.trackers.keys()];
  }

  private tracker(symbol: string): SymbolTracker {
    let t = this.trackers.get(symbol);
    if (!t) {
      t = new SymbolTracker(symbol, this.options.tracker);
      this.trackers.set(symbol, t);
    }
    return t;
  }

  onTrade(trade: NormalizedTrade): void {
    this.tracker(trade.symbol).onTrade(trade);
    const closed = this.outcomes.onPrice(trade.symbol, trade.price, trade.timestamp);
    if (closed.length) this.pendingClosed.push(...closed);
  }

  onLiquidation(liquidation: NormalizedLiquidation): void {
    this.tracker(liquidation.symbol).onLiquidation(liquidation);
  }

  onDerivatives(symbol: string, snapshot: DerivativesSnapshot): void {
    this.tracker(symbol).onDerivatives(snapshot);
  }

  scan(now: number): ScanResult {
    const rows: ScreenerRow[] = [];
    const newSignals: Signal[] = [];
    for (const [symbol, tracker] of this.trackers) {
      if (tracker.price <= 0) continue;
      const metrics = tracker.metrics(now);
      const warmedUp =
        tracker.firstSeen !== null &&
        now - tracker.firstSeen >= this.options.warmupMs &&
        tracker.trades >= this.options.warmupTrades;
      const best = evaluateSignal(tracker.inputs(now, metrics), 0);
      const liquid = metrics.volume1mUsd >= this.options.minVolume1mUsd;
      const eligible = warmedUp && liquid && best !== null && best.score >= this.options.minScore;
      let signal: Signal | null = null;
      if (eligible && best) {
        signal = best;
        const key = `${symbol}:${best.direction}`;
        const last = this.lastSignalAt.get(key) ?? -Infinity;
        const fresh = now - last >= this.options.cooldownMs && !this.outcomes.hasOpen(symbol);
        if (fresh) {
          this.lastSignalAt.set(key, now);
          this.outcomes.open(best);
          newSignals.push(best);
        }
      }
      rows.push({
        ...metrics,
        warmedUp,
        candidate: best ? { direction: best.direction, setup: best.setup, score: best.score } : null,
        signal,
      });
    }
    rows.sort((a, b) => (b.candidate?.score ?? 0) - (a.candidate?.score ?? 0) || (b.volumeZ ?? -Infinity) - (a.volumeZ ?? -Infinity));
    const closed = this.pendingClosed;
    this.pendingClosed = [];
    return { time: now, rows, newSignals, closed };
  }
}
