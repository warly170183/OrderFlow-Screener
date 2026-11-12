// ============================================================
// SIGNAL ENGINE
// Turns a per-symbol order-flow snapshot into a directional signal with a
// 0-100 score, the reasons behind it, and a trade plan (entry, stop, targets).
//
// Two setup families are scored independently and the best one wins:
//   momentum — aggressive flow, rising participation and fresh positioning
//              all pushing the same way
//   reversal — a forced or exhausted move (liquidation flush, absorption,
//              CVD divergence, crowded funding) that is likely to snap back
//
// The weights are heuristics, NOT a validated edge. Use SignalTracker
// (lib/signals/tracker.ts) to measure how each score bucket actually behaves.
// ============================================================

import type { OIRegime } from "@/lib/engine/derivatives";

export type Direction = "long" | "short";
export type SetupKind = "momentum" | "reversal";

export interface SignalInputs {
  symbol: string;
  time: number; // ms
  price: number;
  /** Average true range in price units (e.g. 1m or 5m ATR). */
  atr?: number;
  vwap?: number;
  /** Volume z-score of the latest completed bar (see rollingVolumeZScores). */
  volumeZ?: number;
  /** (buy − sell) / total aggressive volume over the recent window, −1…+1. */
  deltaShare?: number;
  cvdDivergence?: "bullish" | "bearish" | null;
  oiRegime?: OIRegime;
  /** Order-book imbalance, −1…+1. */
  obi?: number;
  /** Funding restated to an 8-hour interval (decimal, 0.0001 = 0.01%). */
  fundingRate8h?: number;
  /** Forced closes over the recent window, in quote notional. */
  liquidations?: { longs: number; shorts: number; cascade: boolean };
  /** Absorption marker: the bid held against selling, or the offer held against buying. */
  absorption?: "bid-held" | "offer-held" | null;
  /** Recent swing extremes, used to place the stop beyond structure. */
  swingLow?: number;
  swingHigh?: number;
}

export interface SignalComponent {
  id: string;
  label: string;
  weight: number;
  /** Alignment with the evaluated direction, −1…+1. */
  value: number;
  note: string;
}

export interface TradePlan {
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskPct: number; // stop distance as % of entry
  rr: number; // reward-to-risk at TP2
}

export interface Signal {
  symbol: string;
  time: number;
  direction: Direction;
  setup: SetupKind;
  score: number; // 0-100
  grade: "strong" | "valid" | "weak";
  reasons: string[];
  components: SignalComponent[];
  plan: TradePlan;
}

export const MIN_SIGNAL_SCORE = 60;
export const STRONG_SIGNAL_SCORE = 75;
/** Fallback stop distance when no ATR is available: 0.4% of price. */
const FALLBACK_ATR_PCT = 0.004;
/** Liquidation notional (USD) at which the liquidation component saturates. */
const LIQ_SATURATION_USD = 1_000_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Evaluated = { score: number; components: SignalComponent[] };

function sign(direction: Direction): 1 | -1 {
  return direction === "long" ? 1 : -1;
}

function evaluateMomentum(i: SignalInputs, d: Direction): Evaluated {
  const s = sign(d);
  const c: SignalComponent[] = [];
  const z = i.volumeZ ?? 0;
  c.push({
    id: "volume",
    label: "Participation",
    weight: 25,
    value: clamp(z / 4, 0, 1),
    note: `volume z ${z.toFixed(1)}σ`,
  });
  const ds = i.deltaShare ?? 0;
  c.push({
    id: "delta",
    label: "Aggressive flow",
    weight: 25,
    value: clamp((ds * s) / 0.5, -1, 1),
    note: `${ds >= 0 ? "+" : ""}${(ds * 100).toFixed(0)}% net aggression`,
  });
  const regime = i.oiRegime ?? "neutral";
  const oiMap: Record<OIRegime, [number, number]> = {
    // [value for long, value for short]
    "new-longs": [1, -0.6],
    "new-shorts": [-0.6, 1],
    "short-covering": [0.25, -0.4],
    "long-unwind": [-0.4, 0.25],
    neutral: [0, 0],
  };
  c.push({
    id: "oi",
    label: "Positioning",
    weight: 20,
    value: oiMap[regime][d === "long" ? 0 : 1],
    note: regime.replace("-", " "),
  });
  if (i.vwap && i.vwap > 0) {
    const side = i.price >= i.vwap ? 1 : -1;
    c.push({ id: "vwap", label: "VWAP side", weight: 10, value: side * s, note: side > 0 ? "above VWAP" : "below VWAP" });
  }
  if (i.obi !== undefined) {
    c.push({ id: "obi", label: "Book imbalance", weight: 10, value: clamp((i.obi * s) / 0.4, -1, 1), note: `OBI ${i.obi.toFixed(2)}` });
  }
  if (i.fundingRate8h !== undefined) {
    // Crowded in the trade's own direction is a cost; funding against is mild support.
    const crowd = clamp((i.fundingRate8h * s) / 0.0005, -1, 1);
    c.push({ id: "funding", label: "Funding crowding", weight: 10, value: -crowd, note: `funding ${(i.fundingRate8h * 100).toFixed(3)}%/8h` });
  }
  return { score: weighted(c), components: c };
}

function evaluateReversal(i: SignalInputs, d: Direction): Evaluated {
  const s = sign(d);
  const c: SignalComponent[] = [];
  // Longs liquidated → forced selling is exhausted → long bias (and vice versa).
  const liq = i.liquidations;
  if (liq) {
    const forced = d === "long" ? liq.longs : liq.shorts;
    const against = d === "long" ? liq.shorts : liq.longs;
    const dominance = forced + against > 0 ? (forced - against) / (forced + against) : 0;
    const size = clamp(forced / LIQ_SATURATION_USD, 0, 1);
    c.push({
      id: "liquidations",
      label: "Liquidation flush",
      weight: 30,
      value: clamp(size * (0.5 + 0.5 * dominance) + (liq.cascade && forced > 0 ? 0.2 : 0), -1, 1),
      note: `$${(forced / 1000).toFixed(0)}k ${d === "long" ? "longs" : "shorts"} flushed${liq.cascade ? ", cascade" : ""}`,
    });
  }
  if (i.absorption) {
    const supports = (i.absorption === "bid-held") === (d === "long");
    c.push({
      id: "absorption",
      label: "Absorption",
      weight: 25,
      value: supports ? 1 : -1,
      note: i.absorption === "bid-held" ? "bid held against selling" : "offer held against buying",
    });
  }
  if (i.cvdDivergence) {
    const supports = (i.cvdDivergence === "bullish") === (d === "long");
    c.push({ id: "cvd", label: "CVD divergence", weight: 20, value: supports ? 1 : -1, note: `${i.cvdDivergence} divergence` });
  }
  if (i.fundingRate8h !== undefined) {
    // Crowded longs (positive funding) favour a short fade, and the reverse.
    c.push({
      id: "funding",
      label: "Crowded funding",
      weight: 15,
      value: clamp((-i.fundingRate8h * s) / 0.0005, -1, 1),
      note: `funding ${(i.fundingRate8h * 100).toFixed(3)}%/8h`,
    });
  }
  // A reversal needs activity: it is a gate expressed as a component.
  c.push({ id: "volume", label: "Participation", weight: 10, value: clamp((i.volumeZ ?? 0) / 3, 0, 1), note: `volume z ${(i.volumeZ ?? 0).toFixed(1)}σ` });
  // Reversal without any trigger event is noise.
  const hasTrigger = Boolean(liq && (liq.longs > 0 || liq.shorts > 0)) || Boolean(i.absorption) || Boolean(i.cvdDivergence);
  return { score: hasTrigger ? weighted(c) : 0, components: c };
}

/** Weighted mean of component values mapped to 0-100 (negative values pull the score down). */
function weighted(components: SignalComponent[]): number {
  const total = components.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return 0;
  const sum = components.reduce((a, c) => a + c.weight * c.value, 0);
  return clamp((sum / total) * 100, 0, 100);
}

export function buildPlan(i: SignalInputs, d: Direction): TradePlan {
  const entry = i.price;
  const atr = i.atr && i.atr > 0 ? i.atr : entry * FALLBACK_ATR_PCT;
  const structural = d === "long" ? (i.swingLow !== undefined ? entry - i.swingLow : undefined) : (i.swingHigh !== undefined ? i.swingHigh - entry : undefined);
  // Stop sits beyond recent structure (plus a small buffer) but never tighter than
  // 0.8 ATR or wider than 2 ATR.
  const base = structural !== undefined && structural > 0 ? structural + 0.1 * atr : 1.2 * atr;
  const risk = clamp(base, 0.8 * atr, 2 * atr);
  const s = sign(d);
  const stop = entry - s * risk;
  return {
    entry,
    stop,
    tp1: entry + s * risk,
    tp2: entry + s * risk * 2,
    tp3: entry + s * risk * 3,
    riskPct: (risk / entry) * 100,
    rr: 2,
  };
}

/** Units to trade so that hitting the stop loses `riskPct`% of `equity`. */
export function positionSize(equity: number, riskPct: number, entry: number, stop: number): { units: number; notional: number } {
  const risk = Math.abs(entry - stop);
  if (!(equity > 0) || !(riskPct > 0) || !(risk > 0)) return { units: 0, notional: 0 };
  const units = (equity * (riskPct / 100)) / risk;
  return { units, notional: units * entry };
}

/**
 * Evaluate a snapshot. Returns the best-scoring signal at or above `minScore`,
 * or null when nothing qualifies.
 */
export function evaluateSignal(inputs: SignalInputs, minScore = MIN_SIGNAL_SCORE): Signal | null {
  if (!(inputs.price > 0)) return null;
  let best: { d: Direction; kind: SetupKind; ev: Evaluated } | null = null;
  for (const d of ["long", "short"] as const) {
    for (const kind of ["momentum", "reversal"] as const) {
      const ev = kind === "momentum" ? evaluateMomentum(inputs, d) : evaluateReversal(inputs, d);
      if (!best || ev.score > best.ev.score) best = { d, kind, ev };
    }
  }
  if (!best || best.ev.score < minScore) return null;
  const score = Math.round(best.ev.score);
  const reasons = best.ev.components
    .filter((c) => c.value >= 0.4)
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .map((c) => `${c.label}: ${c.note}`);
  return {
    symbol: inputs.symbol,
    time: inputs.time,
    direction: best.d,
    setup: best.kind,
    score,
    grade: score >= STRONG_SIGNAL_SCORE ? "strong" : score >= MIN_SIGNAL_SCORE ? "valid" : "weak",
    reasons,
    components: best.ev.components,
    plan: buildPlan(inputs, best.d),
  };
}
