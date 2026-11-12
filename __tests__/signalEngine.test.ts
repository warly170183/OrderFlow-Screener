import { buildPlan, evaluateSignal, positionSize, type SignalInputs } from "@/lib/signals/signalEngine";

const base: SignalInputs = { symbol: "BTCUSDT", time: 1_000, price: 100, atr: 1 };

describe("evaluateSignal", () => {
  it("returns null for a quiet market", () => {
    expect(evaluateSignal({ ...base, volumeZ: 0.3, deltaShare: 0.02, oiRegime: "neutral" })).toBeNull();
  });

  it("flags a long momentum setup when flow, participation and positioning agree", () => {
    const s = evaluateSignal({
      ...base,
      volumeZ: 3.5,
      deltaShare: 0.45,
      oiRegime: "new-longs",
      vwap: 99,
      obi: 0.3,
      fundingRate8h: 0.00005,
    });
    expect(s).not.toBeNull();
    expect(s!.direction).toBe("long");
    expect(s!.setup).toBe("momentum");
    expect(s!.score).toBeGreaterThanOrEqual(75);
    expect(s!.grade).toBe("strong");
    expect(s!.reasons.length).toBeGreaterThan(0);
  });

  it("flags a short momentum setup symmetrically", () => {
    const s = evaluateSignal({ ...base, volumeZ: 3.5, deltaShare: -0.45, oiRegime: "new-shorts", vwap: 101 });
    expect(s?.direction).toBe("short");
    expect(s?.setup).toBe("momentum");
  });

  it("penalises momentum into crowded funding", () => {
    const common = { ...base, volumeZ: 3, deltaShare: 0.4, oiRegime: "new-longs" as const, vwap: 99 };
    const calm = evaluateSignal({ ...common, fundingRate8h: 0 }, 0)!;
    const crowded = evaluateSignal({ ...common, fundingRate8h: 0.001 }, 0)!;
    expect(crowded.score).toBeLessThan(calm.score);
  });

  it("flags a long reversal after a long-liquidation flush with absorption and divergence", () => {
    const s = evaluateSignal({
      ...base,
      volumeZ: 3,
      deltaShare: -0.1,
      liquidations: { longs: 2_000_000, shorts: 50_000, cascade: true },
      absorption: "bid-held",
      cvdDivergence: "bullish",
      fundingRate8h: 0.0004,
    });
    expect(s?.direction).toBe("long");
    expect(s?.setup).toBe("reversal");
    expect(s!.score).toBeGreaterThanOrEqual(60);
  });

  it("does not trigger a reversal without any trigger event", () => {
    const s = evaluateSignal({ ...base, volumeZ: 4, fundingRate8h: -0.001 }, 1);
    expect(s?.setup).not.toBe("reversal");
  });

  it("rejects invalid prices", () => {
    expect(evaluateSignal({ ...base, price: 0 })).toBeNull();
  });
});

describe("buildPlan", () => {
  it("uses 1.2 ATR stop and 1R/2R/3R targets without structure", () => {
    const p = buildPlan(base, "long");
    expect(p.stop).toBeCloseTo(98.8);
    expect(p.tp1).toBeCloseTo(101.2);
    expect(p.tp2).toBeCloseTo(102.4);
    expect(p.tp3).toBeCloseTo(103.6);
    expect(p.rr).toBe(2);
  });

  it("mirrors for shorts", () => {
    const p = buildPlan(base, "short");
    expect(p.stop).toBeCloseTo(101.2);
    expect(p.tp2).toBeCloseTo(97.6);
  });

  it("places the stop beyond structure but clamps to 2 ATR", () => {
    const near = buildPlan({ ...base, swingLow: 99.2 }, "long");
    expect(near.stop).toBeCloseTo(100 - Math.max(0.8, 0.8 + 0.1));
    const far = buildPlan({ ...base, swingLow: 90 }, "long");
    expect(far.stop).toBeCloseTo(98);
  });

  it("falls back to a 0.4% ATR proxy when ATR is missing", () => {
    const p = buildPlan({ ...base, atr: undefined }, "long");
    expect(p.riskPct).toBeCloseTo(0.48, 2);
  });
});

describe("positionSize", () => {
  it("sizes so the stop loses the chosen share of equity", () => {
    const { units, notional } = positionSize(10_000, 1, 100, 98);
    expect(units).toBeCloseTo(50);
    expect(notional).toBeCloseTo(5_000);
  });

  it("returns zero for degenerate input", () => {
    expect(positionSize(0, 1, 100, 98).units).toBe(0);
    expect(positionSize(1000, 1, 100, 100).units).toBe(0);
  });
});
