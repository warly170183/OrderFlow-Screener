// ============================================================
// SYMBOL TRACKER
// Rolling order-flow state for ONE symbol, fed by normalized trades,
// liquidations and derivatives updates (the same shapes the adapters emit).
// Produces the SignalInputs consumed by the signal engine, plus display metrics.
//
// Time-based windows are computed over DENSE series (empty seconds count as
// zero volume) so illiquid symbols are not biased by missing buckets.
// ============================================================

import { AbsorptionDetector } from "@/lib/engine/microstructure";
import { cvdDivergence } from "@/lib/engine/alerts";
import { rollingVolumeZScores, resolveTickSize } from "@/lib/engine/analytics";
import {
  bucketLiquidations,
  fundingRate8h,
  isLiquidationCascade,
  mergeDerivatives,
  oiWindowChange,
  summarizeLiquidations,
  type OIRegime,
} from "@/lib/engine/derivatives";
import type {
  DerivativesSnapshot,
  FlowBar,
  NormalizedLiquidation,
  NormalizedTrade,
  OpenInterestPoint,
} from "@/lib/types/market";
import type { SignalInputs } from "@/lib/signals/signalEngine";

/** A 1-second flow bar that also carries traded notional (for VWAP). */
interface Bar extends FlowBar {
  notional: number;
}

export interface TrackerOptions {
  /** History kept, in ms. Must cover the longest window (ATR). */
  historyMs: number;
  /** Bar size for ATR / swing structure. */
  structureBarMs: number;
  atrPeriod: number;
  /** Bar size for the volume z-score and its baseline length in bars. */
  zBarMs: number;
  zWindow: number;
  /** Minimum traded notional (USD) in the liquidation window to count a cascade. */
  cascadeFloorUsd: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  historyMs: 2 * 3_600_000,
  structureBarMs: 5 * 60_000,
  atrPeriod: 12,
  zBarMs: 5_000,
  zWindow: 60,
  cascadeFloorUsd: 100_000,
};

export interface SymbolMetrics {
  symbol: string;
  price: number;
  change5m: number | null; // fraction
  change1h: number | null;
  volume1mUsd: number;
  volumeZ: number | null;
  deltaShare: number | null;
  vwap: number | null;
  atr: number | null;
  atrPct: number | null;
  oiChange5m: number | null; // fraction
  oiRegime: OIRegime | null;
  fundingRate8h: number | null;
  liqLong5mUsd: number;
  liqShort5mUsd: number;
  cascade: boolean;
  cvdDivergence: "bullish" | "bearish" | null;
  absorption: "bid-held" | "offer-held" | null;
  trades: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
}

const ABSORPTION_TTL_MS = 60_000;
const MAX_LIQUIDATION_AGE_MS = 60_000;

export class SymbolTracker {
  private bars: Bar[] = [];
  private cvd = 0;
  private tradeCount = 0;
  private firstTradeAt: number | null = null;
  private lastTradeAt: number | null = null;
  private lastPrice = 0;
  private liquidations: NormalizedLiquidation[] = [];
  private seenLiquidations = new Set<string>();
  private derivs = new Map<string, DerivativesSnapshot>();
  private oiHistory: OpenInterestPoint[] = [];
  private lastOiSample = 0;
  private absorption: { side: "bid-held" | "offer-held"; time: number } | null = null;
  private detector: AbsorptionDetector | null = null;

  constructor(
    readonly symbol: string,
    private readonly options: TrackerOptions = DEFAULT_TRACKER_OPTIONS
  ) {}

  get trades(): number {
    return this.tradeCount;
  }
  get price(): number {
    return this.lastPrice;
  }
  get firstSeen(): number | null {
    return this.firstTradeAt;
  }

  // ─── Inputs ────────────────────────────────────────────────
  onTrade(trade: NormalizedTrade): void {
    if (!(trade.price > 0) || !(trade.quantity > 0)) return;
    const t = Math.floor(trade.timestamp / 1000) * 1000;
    const signed = trade.side === "buy" ? trade.quantity : -trade.quantity;
    this.cvd += signed;
    this.lastPrice = trade.price;
    this.tradeCount++;
    this.firstTradeAt ??= trade.timestamp;
    this.lastTradeAt = trade.timestamp;

    let bar = this.bars[this.bars.length - 1];
    if (!bar || bar.time < t) {
      bar = { time: t, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: 0, buyVolume: 0, sellVolume: 0, trades: 0, cvd: this.cvd, notional: 0 };
      this.bars.push(bar);
    }
    // A late print (bar.time > t) folds into the newest bar.
    bar.high = Math.max(bar.high, trade.price);
    bar.low = Math.min(bar.low, trade.price);
    bar.close = trade.price;
    bar.volume += trade.quantity;
    bar.notional += trade.price * trade.quantity;
    if (trade.side === "buy") bar.buyVolume += trade.quantity;
    else bar.sellVolume += trade.quantity;
    bar.trades++;
    bar.cvd = this.cvd;

    if (!this.detector) this.detector = new AbsorptionDetector(resolveTickSize(trade.price, "perpetual"));
    for (const event of this.detector.onTrade(trade)) {
      if (event.kind === "absorption") this.absorption = { side: event.side === "bid" ? "bid-held" : "offer-held", time: event.time };
    }
    this.trim(trade.timestamp);
  }

  onLiquidation(liquidation: NormalizedLiquidation): void {
    // Some feeds (OKX) replay their last known liquidation long after the fact,
    // and the same record can arrive twice; mirror the terminal's intake rules.
    if (liquidation.timestamp < liquidation.localTimestamp - MAX_LIQUIDATION_AGE_MS) return;
    if (this.seenLiquidations.has(liquidation.id)) return;
    this.seenLiquidations.add(liquidation.id);
    if (this.seenLiquidations.size > 5000) this.seenLiquidations = new Set([...this.seenLiquidations].slice(-2500));
    this.liquidations.push(liquidation);
    const cutoff = liquidation.timestamp - 15 * 60_000;
    if (this.liquidations.length > 2000 || this.liquidations[0].timestamp < cutoff - 60_000) {
      this.liquidations = this.liquidations.filter((l) => l.timestamp >= cutoff);
    }
  }

  onDerivatives(update: DerivativesSnapshot): void {
    this.derivs.set(update.venue, mergeDerivatives(this.derivs.get(update.venue), update));
    const oi = this.totalOpenInterest();
    if (oi !== null && this.lastPrice > 0 && update.timestamp - this.lastOiSample >= 5_000) {
      this.lastOiSample = update.timestamp;
      this.oiHistory.push({ time: update.timestamp, openInterest: oi, price: this.lastPrice });
      const cutoff = update.timestamp - 30 * 60_000;
      while (this.oiHistory.length > 1 && this.oiHistory[0].time < cutoff) this.oiHistory.shift();
    }
  }

  // ─── Outputs ───────────────────────────────────────────────
  metrics(now: number): SymbolMetrics {
    const price = this.lastPrice;
    const sec = this.denseSeconds(now, 61);
    const last60 = sec.slice(-60);
    const buy = last60.reduce((a, b) => a + b.buyVolume, 0);
    const sell = last60.reduce((a, b) => a + b.sellVolume, 0);
    const deltaShare = buy + sell > 0 ? (buy - sell) / (buy + sell) : null;
    const volume1mUsd = this.sumNotional(now - 60_000, now);

    const structure = this.structureBars(now);
    const atr = this.atr(structure);
    const oi = oiWindowChange(this.oiHistory, 5 * 60_000);
    const liq = summarizeLiquidations(this.liquidations, now - 5 * 60_000);
    const buckets = bucketLiquidations(this.liquidations, 15_000, 20, now);
    const snapshots = [...this.derivs.values()];
    const fundings = snapshots.map(fundingRate8h).filter((v): v is number => v !== undefined);
    const absorption = this.absorption && now - this.absorption.time <= ABSORPTION_TTL_MS ? this.absorption.side : null;

    return {
      symbol: this.symbol,
      price,
      change5m: this.changeOver(now, 5 * 60_000),
      change1h: this.changeOver(now, 60 * 60_000),
      volume1mUsd,
      volumeZ: this.volumeZ(now),
      deltaShare,
      vwap: this.vwap(now),
      atr,
      atrPct: atr !== null && price > 0 ? atr / price : null,
      oiChange5m: oi ? oi.oiChange : null,
      oiRegime: oi ? oi.regime : null,
      fundingRate8h: fundings.length ? fundings.reduce((a, b) => a + b, 0) / fundings.length : null,
      liqLong5mUsd: liq.longNotional,
      liqShort5mUsd: liq.shortNotional,
      cascade: isLiquidationCascade(buckets, 5, this.options.cascadeFloorUsd),
      cvdDivergence: sec.length > 60 ? cvdDivergence(sec, resolveTickSize(price || 1, "perpetual")) : null,
      absorption,
      trades: this.tradeCount,
      firstTradeAt: this.firstTradeAt,
      lastTradeAt: this.lastTradeAt,
    };
  }

  /** Signal-engine inputs for the current moment. */
  inputs(now: number, metrics: SymbolMetrics = this.metrics(now)): SignalInputs {
    const structure = this.structureBars(now);
    const recent = structure.slice(-6);
    return {
      symbol: this.symbol,
      time: now,
      price: metrics.price,
      atr: metrics.atr ?? undefined,
      vwap: metrics.vwap ?? undefined,
      volumeZ: metrics.volumeZ ?? undefined,
      deltaShare: metrics.deltaShare ?? undefined,
      cvdDivergence: metrics.cvdDivergence,
      oiRegime: metrics.oiRegime ?? undefined,
      fundingRate8h: metrics.fundingRate8h ?? undefined,
      liquidations: { longs: metrics.liqLong5mUsd, shorts: metrics.liqShort5mUsd, cascade: metrics.cascade },
      absorption: metrics.absorption,
      swingLow: recent.length ? Math.min(...recent.map((b) => b.low)) : undefined,
      swingHigh: recent.length ? Math.max(...recent.map((b) => b.high)) : undefined,
    };
  }

  // ─── Internals ─────────────────────────────────────────────
  private totalOpenInterest(): number | null {
    let total = 0;
    let any = false;
    for (const s of this.derivs.values()) {
      if (s.openInterest !== undefined) {
        total += s.openInterest;
        any = true;
      }
    }
    return any ? total : null;
  }

  private trim(now: number): void {
    const cutoff = now - this.options.historyMs;
    if (this.bars.length > 0 && this.bars[0].time < cutoff - 60_000) {
      let i = 0;
      while (i < this.bars.length && this.bars[i].time < cutoff) i++;
      this.bars = this.bars.slice(i);
    }
  }

  private sumNotional(from: number, to: number): number {
    let sum = 0;
    for (let i = this.bars.length - 1; i >= 0; i--) {
      const b = this.bars[i];
      if (b.time + 1000 <= from) break;
      if (b.time <= to) sum += b.notional;
    }
    return sum;
  }

  /** Bar closes at or just before `at`, or null if there is no history that old. */
  private priceAt(at: number): number | null {
    if (!this.bars.length || this.bars[0].time > at) return null;
    let lo = 0;
    let hi = this.bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bars[mid].time <= at) lo = mid;
      else hi = mid - 1;
    }
    return this.bars[lo].close;
  }

  private changeOver(now: number, windowMs: number): number | null {
    const then = this.priceAt(now - windowMs);
    return then && this.lastPrice > 0 ? (this.lastPrice - then) / then : null;
  }

  private vwap(now: number): number | null {
    let notional = 0;
    let volume = 0;
    for (let i = this.bars.length - 1; i >= 0; i--) {
      const b = this.bars[i];
      if (b.time < now - 3_600_000) break;
      notional += b.notional;
      volume += b.volume;
    }
    return volume > 0 ? notional / volume : null;
  }

  /** `count` consecutive 1-second bars ending at the second containing `now`; gaps are filled flat. */
  private denseSeconds(now: number, count: number): FlowBar[] {
    if (!this.bars.length) return [];
    const end = Math.floor(now / 1000) * 1000;
    const start = end - (count - 1) * 1000;
    const out: FlowBar[] = [];
    let cursor = this.bars.length - 1;
    while (cursor > 0 && this.bars[cursor - 1].time >= start) cursor--;
    let prevClose = cursor > 0 ? this.bars[cursor - 1].close : this.bars[cursor].open;
    let prevCvd = cursor > 0 ? this.bars[cursor - 1].cvd : this.bars[cursor].cvd;
    for (let t = start; t <= end; t += 1000) {
      const b = this.bars[cursor];
      if (b && b.time === t) {
        out.push(b);
        prevClose = b.close;
        prevCvd = b.cvd;
        cursor++;
      } else {
        out.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0, buyVolume: 0, sellVolume: 0, trades: 0, cvd: prevCvd });
      }
    }
    return out;
  }

  /** Z-score of the latest COMPLETED z-bar against the preceding window. */
  private volumeZ(now: number): number | null {
    const { zBarMs, zWindow } = this.options;
    const needed = zWindow + 12;
    const end = Math.floor(now / zBarMs) * zBarMs; // open of the in-progress bar
    const start = end - needed * zBarMs;
    // Need at least half the baseline window of history before scoring.
    if (!this.bars.length || this.bars[0].time > end - (zWindow / 2) * zBarMs) return null;
    const series: FlowBar[] = Array.from({ length: needed }, (_, i) => {
      const time = start + i * zBarMs;
      return { time, open: 0, high: 0, low: 0, close: 0, volume: 0, buyVolume: 0, sellVolume: 0, trades: 0, cvd: 0 };
    });
    for (let i = this.bars.length - 1; i >= 0; i--) {
      const b = this.bars[i];
      if (b.time < start) break;
      if (b.time >= end) continue;
      series[Math.floor((b.time - start) / zBarMs)].volume += b.volume;
    }
    const points = rollingVolumeZScores(series, zWindow, Math.floor(zWindow / 2));
    return points[points.length - 1].z;
  }

  private structureBars(now: number): FlowBar[] {
    const ms = this.options.structureBarMs;
    const out: FlowBar[] = [];
    const first = now - this.options.atrPeriod * ms - ms;
    let current: FlowBar | null = null;
    for (const b of this.bars) {
      if (b.time < first) continue;
      const bucket = Math.floor(b.time / ms) * ms;
      if (!current || current.time !== bucket) {
        if (current) out.push(current);
        current = { ...b, time: bucket };
        continue;
      }
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume += b.volume;
    }
    if (current) out.push(current);
    return out;
  }

  /** Wilder-style simple ATR over completed structure bars; null with fewer than 3. */
  private atr(bars: FlowBar[]): number | null {
    const completed = bars.slice(0, -1);
    if (completed.length < 3) return null;
    const use = completed.slice(-this.options.atrPeriod - 1);
    let sum = 0;
    let n = 0;
    for (let i = 1; i < use.length; i++) {
      const tr = Math.max(use[i].high - use[i].low, Math.abs(use[i].high - use[i - 1].close), Math.abs(use[i].low - use[i - 1].close));
      sum += tr;
      n++;
    }
    return n > 0 ? sum / n : null;
  }
}
