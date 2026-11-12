import { ScreenerCore } from "@/lib/screener/screenerCore";
import { SymbolTracker } from "@/lib/screener/symbolTracker";
import type { NormalizedLiquidation, NormalizedTrade } from "@/lib/types/market";

const T0 = Math.floor(1_700_000_000_000 / 300_000) * 300_000;
const SYMBOL = "BTC-USDT-SWAP";

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

let tradeId = 0;
function trade(t: number, price: number, quantity: number, side: "buy" | "sell", symbol = SYMBOL): NormalizedTrade {
  return {
    id: `t${++tradeId}`,
    venue: "okx-futures",
    symbol,
    timestamp: t,
    localTimestamp: t,
    price,
    quantity,
    quoteVolume: price * quantity,
    side,
    marketType: "perpetual",
  };
}

/** 15 quiet minutes: one small print per second around 100. */
function feedBaseline(core: ScreenerCore, seconds = 900) {
  const rnd = lcg(42);
  for (let s = 0; s < seconds; s++) {
    const t = T0 + s * 1000;
    const price = 100 + (rnd() - 0.5) * 0.1;
    core.onTrade(trade(t, price, 50 + rnd() * 10, rnd() < 0.5 ? "buy" : "sell"));
    if (s % 5 === 0) core.onDerivatives(SYMBOL, { venue: "okx-futures", timestamp: t, openInterest: 10_000, fundingRate: 0.00005, fundingIntervalHours: 8 });
  }
}

/** Aggressive buying with rising price and rising open interest. */
function feedBurst(core: ScreenerCore, startSecond: number, seconds = 30) {
  for (let i = 0; i < seconds; i++) {
    const t = T0 + (startSecond + i) * 1000;
    const price = 100 + 0.05 * (i + 1);
    for (let k = 0; k < 5; k++) core.onTrade(trade(t + k * 100, price, 400, "buy"));
    core.onDerivatives(SYMBOL, { venue: "okx-futures", timestamp: t, openInterest: 10_000 + 15 * (i + 1) * (i + 1) / 2, fundingRate: 0.00005, fundingIntervalHours: 8 });
  }
}

describe("SymbolTracker", () => {
  it("has no volume z-score before enough history exists", () => {
    const t = new SymbolTracker(SYMBOL);
    for (let s = 0; s < 20; s++) t.onTrade(trade(T0 + s * 1000, 100, 1, "buy"));
    expect(t.metrics(T0 + 20_000).volumeZ).toBeNull();
  });

  it("measures net aggression and a high volume z-score on a burst", () => {
    const core = new ScreenerCore();
    feedBaseline(core);
    feedBurst(core, 900);
    const row = core.scan(T0 + 931_000).rows[0];
    expect(row.deltaShare).toBeGreaterThan(0.9);
    expect(row.volumeZ).toBeGreaterThan(3);
    expect(row.atr).not.toBeNull();
    expect(row.oiRegime).toBe("new-longs");
    expect(row.vwap).toBeGreaterThan(100);
    expect(row.fundingRate8h).toBeCloseTo(0.00005);
  });

  it("totals liquidations inside the 5-minute window", () => {
    const t = new SymbolTracker(SYMBOL);
    t.onTrade(trade(T0, 100, 1, "buy"));
    const liq = (ts: number, side: "long" | "short", usd: number, arrival = ts): NormalizedLiquidation => ({
      id: `l${ts}${side}`, venue: "okx-futures", symbol: SYMBOL, timestamp: ts, localTimestamp: arrival, price: 100, quantity: usd / 100, quoteVolume: usd, side,
    });
    t.onLiquidation(liq(T0 + 1000, "long", 300_000));
    t.onLiquidation(liq(T0 + 2000, "short", 50_000));
    t.onLiquidation(liq(T0 - 600_000, "long", 9_000_000, T0 + 3000)); // stale replay: dropped
    t.onLiquidation(liq(T0 + 1000, "long", 300_000)); // duplicate id: dropped
    const m = t.metrics(T0 + 10_000);
    expect(m.liqLong5mUsd).toBe(300_000);
    expect(m.liqShort5mUsd).toBe(50_000);
  });
});

describe("ScreenerCore", () => {
  it("stays silent during warm-up", () => {
    const core = new ScreenerCore();
    for (let s = 0; s < 120; s++) core.onTrade(trade(T0 + s * 1000, 100 + (s % 2) * 0.01, 500, "buy"));
    const result = core.scan(T0 + 120_000);
    expect(result.newSignals).toHaveLength(0);
    expect(result.rows[0].warmedUp).toBe(false);
    expect(result.rows[0].signal).toBeNull();
  });

  it("emits one long momentum signal on a burst, then respects the cooldown", () => {
    const core = new ScreenerCore();
    feedBaseline(core);
    expect(core.scan(T0 + 899_000).newSignals).toHaveLength(0);
    feedBurst(core, 900);
    const first = core.scan(T0 + 931_000);
    expect(first.newSignals).toHaveLength(1);
    const signal = first.newSignals[0];
    expect(signal.direction).toBe("long");
    expect(signal.setup).toBe("momentum");
    expect(signal.plan.stop).toBeLessThan(signal.plan.entry);
    expect(first.rows[0].signal?.symbol).toBe(SYMBOL);

    const second = core.scan(T0 + 940_000);
    expect(second.newSignals).toHaveLength(0);
    expect(core.outcomes.stats().openCount).toBe(1);
  });

  it("closes the followed signal at TP2 when price keeps running", () => {
    const core = new ScreenerCore();
    feedBaseline(core);
    feedBurst(core, 900);
    const { newSignals } = core.scan(T0 + 931_000);
    const sig = newSignals[0];
    const target = sig.plan.tp2;
    // Drift price beyond TP2.
    core.onTrade(trade(T0 + 935_000, target + 0.01, 10, "buy"));
    const result = core.scan(T0 + 936_000);
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0].outcome).toBe("tp2");
    expect(result.closed[0].resultR).toBe(2);
    expect(core.outcomes.stats().overall.avgR).toBe(2);
  });

  it("closes at the stop and reports −1R", () => {
    const core = new ScreenerCore();
    feedBaseline(core);
    feedBurst(core, 900);
    const sig = core.scan(T0 + 931_000).newSignals[0];
    core.onTrade(trade(T0 + 935_000, sig.plan.stop - 0.01, 10, "sell"));
    const result = core.scan(T0 + 936_000);
    expect(result.closed[0].outcome).toBe("stop");
    expect(result.closed[0].resultR).toBe(-1);
  });

  it("ignores illiquid symbols even with a strong pattern", () => {
    const core = new ScreenerCore({ minVolume1mUsd: 1e12 });
    feedBaseline(core);
    feedBurst(core, 900);
    expect(core.scan(T0 + 931_000).newSignals).toHaveLength(0);
  });

  it("ranks symbols by candidate score", () => {
    const core = new ScreenerCore();
    feedBaseline(core);
    feedBurst(core, 900);
    // A second, quiet symbol.
    const rnd = lcg(7);
    for (let s = 0; s < 930; s++) core.onTrade(trade(T0 + s * 1000, 50 + (rnd() - 0.5) * 0.02, 100, rnd() < 0.5 ? "buy" : "sell", "ETH-USDT-SWAP"));
    const rows = core.scan(T0 + 931_000).rows;
    expect(rows.map((r) => r.symbol)).toEqual([SYMBOL, "ETH-USDT-SWAP"]);
    expect(rows[0].candidate!.score).toBeGreaterThan(rows[1].candidate!.score);
  });
});
