// ============================================================
// DEMO FEED  (DEMO=1)
// Synthetic market data so the whole pipeline — scoring, signals, outcome
// tracking, API, UI — can run with no exchange access. NOT real prices:
// every symbol follows a seeded random walk with occasional aggressive bursts.
// ============================================================

import type { FeedHealth, FeedSink } from "./okxFeed";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class DemoFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly state: Array<{ symbol: string; price: number; oi: number; burst: number; dir: 1 | -1; scale: number }>;
  private readonly rnd = lcg(1337);
  private id = 0;

  constructor(symbols: string[], private readonly sink: FeedSink, private readonly tickMs = 250) {
    this.state = symbols.map((symbol, i) => ({ symbol, price: 10 + i * 17.3, oi: 1_000_000, burst: 0, dir: 1, scale: 1 + (i % 5) }));
  }

  health(): FeedHealth {
    return { connected: this.timer !== null, lastMessageAt: Date.now(), reconnects: 0, symbols: this.state.length };
  }

  start(): void {
    this.timer = setInterval(() => this.tick(Date.now()), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(now: number): void {
    for (const s of this.state) {
      if (s.burst <= 0 && this.rnd() < 0.0015) {
        s.burst = 80 + Math.floor(this.rnd() * 80); // ticks
        s.dir = this.rnd() < 0.5 ? 1 : -1;
      }
      const bursting = s.burst > 0;
      if (bursting) s.burst--;
      const trades = bursting ? 4 : this.rnd() < 0.6 ? 1 : 0;
      for (let k = 0; k < trades; k++) {
        const drift = bursting ? s.dir * 0.0004 : 0;
        s.price *= 1 + drift + (this.rnd() - 0.5) * 0.0004;
        const side = bursting ? (this.rnd() < 0.85 ? (s.dir === 1 ? "buy" : "sell") : s.dir === 1 ? "sell" : "buy") : this.rnd() < 0.5 ? "buy" : "sell";
        const quantity = (bursting ? 6 : 1) * (0.5 + this.rnd()) * (1000 / s.price) * s.scale;
        this.sink.trade({ id: `demo-${++this.id}`, venue: "okx-futures", symbol: s.symbol, timestamp: now, localTimestamp: now, price: s.price, quantity, quoteVolume: s.price * quantity, side, marketType: "perpetual" });
      }
      if (bursting) {
        s.oi *= 1 + s.dir * 0.00005 * 4;
        if (this.rnd() < 0.04) {
          const qty = (200_000 * (0.5 + this.rnd())) / s.price;
          this.sink.liquidation({ id: `demol-${++this.id}`, venue: "okx-futures", symbol: s.symbol, timestamp: now, localTimestamp: now, price: s.price, quantity: qty, quoteVolume: qty * s.price, side: s.dir === 1 ? "short" : "long" });
        }
      }
      if (this.rnd() < 0.05) this.sink.derivatives(s.symbol, { venue: "okx-futures", timestamp: now, openInterest: s.oi, fundingRate: 0.00008, fundingIntervalHours: 8 });
    }
  }
}
