import { SignalTracker, summarize } from "@/lib/signals/tracker";
import type { Signal } from "@/lib/signals/signalEngine";

function sig(partial: Partial<Signal> = {}, entry = 100, risk = 1, direction: "long" | "short" = "long"): Signal {
  const s = direction === "long" ? 1 : -1;
  return {
    symbol: "X",
    time: 0,
    direction,
    setup: "momentum",
    score: 70,
    grade: "valid",
    reasons: [],
    components: [],
    plan: { entry, stop: entry - s * risk, tp1: entry + s * risk, tp2: entry + s * 2 * risk, tp3: entry + s * 3 * risk, riskPct: risk, rr: 2 },
    ...partial,
  };
}

const MIN = 60_000;

describe("SignalTracker", () => {
  it("closes a long at TP2 for +2R and records MFE", () => {
    const t = new SignalTracker();
    t.open(sig());
    expect(t.onPrice("X", 100.5, MIN)).toHaveLength(0);
    const closed = t.onPrice("X", 102.1, 2 * MIN);
    expect(closed[0].outcome).toBe("tp2");
    expect(closed[0].resultR).toBe(2);
    expect(closed[0].mfeR).toBeGreaterThanOrEqual(2);
    expect(closed[0].reached).toBe(2);
  });

  it("closes at the stop for −1R even after touching TP1", () => {
    const t = new SignalTracker();
    t.open(sig());
    t.onPrice("X", 101.2, MIN);
    const closed = t.onPrice("X", 98.9, 2 * MIN);
    expect(closed[0].outcome).toBe("stop");
    expect(closed[0].resultR).toBe(-1);
    expect(closed[0].reached).toBe(1);
  });

  it("handles shorts symmetrically", () => {
    const t = new SignalTracker();
    t.open(sig({}, 100, 1, "short"));
    const closed = t.onPrice("X", 97.9, MIN);
    expect(closed[0].resultR).toBe(2);
  });

  it("marks to market on timeout and stores fixed-horizon R", () => {
    const t = new SignalTracker(10 * MIN);
    t.open(sig());
    t.onPrice("X", 100.4, 5 * MIN);
    t.onPrice("X", 100.2, 9 * MIN);
    const closed = t.onPrice("X", 100.6, 10 * MIN);
    expect(closed[0].outcome).toBe("timeout");
    expect(closed[0].resultR).toBeCloseTo(0.6);
    expect(closed[0].horizonsR.m5).toBeCloseTo(0.4);
  });

  it("ignores other symbols and prices older than the signal", () => {
    const t = new SignalTracker();
    t.open(sig({ time: 10 * MIN }));
    expect(t.onPrice("Y", 50, 11 * MIN)).toHaveLength(0);
    expect(t.onPrice("X", 90, 5 * MIN)).toHaveLength(0);
    expect(t.hasOpen("X")).toBe(true);
  });

  it("summarizes win rate, expectancy and profit factor per bucket", () => {
    const t = new SignalTracker();
    for (const price of [102.1, 98.9, 102.1, 98.9, 98.9]) {
      t.open(sig({ time: 0 }));
      t.onPrice("X", price, MIN);
    }
    const stats = t.stats();
    expect(stats.overall.n).toBe(5);
    expect(stats.overall.winRate).toBeCloseTo(0.4);
    expect(stats.overall.avgR).toBeCloseTo((2 + -1 + 2 + -1 + -1) / 5);
    expect(stats.overall.profitFactor).toBeCloseTo(4 / 3);
    expect(stats.byScore["70-79"].n).toBe(5);
    expect(stats.byDirection.long.n).toBe(5);
  });

  it("round-trips through JSON and prunes old closed records", () => {
    const t = new SignalTracker();
    for (let i = 0; i < 5; i++) {
      t.open(sig());
      t.onPrice("X", 98.9, MIN);
    }
    t.prune(2);
    expect(t.all()).toHaveLength(2);
    const restored = SignalTracker.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(restored.stats().overall.n).toBe(2);
  });

  it("summarize returns zeros for an empty list", () => {
    expect(summarize([])).toMatchObject({ n: 0, winRate: 0, avgR: 0, profitFactor: null });
  });
});
