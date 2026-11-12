// ============================================================
// OKX SCREENER FEED
// One WebSocket carrying the lightweight channels needed to screen many
// perpetuals at once: trades, open interest, funding and liquidations.
// (No order books: those are heavy and the screener does not use them.)
//
// OKX reports sizes in contracts, so the feed loads each instrument's
// contract value once and converts to base-asset units.
// ============================================================

import WebSocket from "ws";
import type { DerivativesSnapshot, NormalizedLiquidation, NormalizedTrade } from "@/lib/types/market";

const REST = "https://www.okx.com";
const WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const VENUE = "okx-futures" as const;

export interface FeedSink {
  trade(trade: NormalizedTrade): void;
  liquidation(liquidation: NormalizedLiquidation): void;
  derivatives(symbol: string, snapshot: DerivativesSnapshot): void;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Pure message → normalized event translation; no sockets, so it is unit-testable. */
export class OkxMessageParser {
  constructor(private readonly contractValues: ReadonlyMap<string, number>, private readonly sink: FeedSink, private readonly now: () => number = Date.now) {}

  handle(raw: string): void {
    if (raw === "pong") return;
    let msg: { arg?: { channel?: string }; data?: unknown[]; event?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const channel = msg.arg?.channel;
    if (!channel || !Array.isArray(msg.data)) return;
    switch (channel) {
      case "trades":
        for (const t of msg.data as Array<{ tradeId: string; instId: string; px: string; sz: string; side: "buy" | "sell"; ts: string }>) {
          const price = num(t.px);
          const size = num(t.sz);
          const ts = num(t.ts);
          if (!price || !size || !ts || (t.side !== "buy" && t.side !== "sell")) continue;
          const quantity = size * (this.contractValues.get(t.instId) ?? 1);
          this.sink.trade({ id: `okx-${t.instId}-${t.tradeId}`, venue: VENUE, symbol: t.instId, timestamp: ts, localTimestamp: this.now(), price, quantity, quoteVolume: price * quantity, side: t.side, marketType: "perpetual" });
        }
        return;
      case "open-interest":
        for (const d of msg.data as Array<{ instId: string; oiCcy?: string; ts?: string }>) {
          const openInterest = num(d.oiCcy);
          if (openInterest && openInterest > 0) this.sink.derivatives(d.instId, { venue: VENUE, timestamp: num(d.ts) ?? this.now(), openInterest });
        }
        return;
      case "funding-rate":
        for (const d of msg.data as Array<{ instId: string; fundingRate?: string; fundingTime?: string; nextFundingTime?: string }>) {
          const fundingRate = num(d.fundingRate);
          if (fundingRate === undefined) continue;
          const next = num(d.fundingTime);
          const after = num(d.nextFundingTime);
          this.sink.derivatives(d.instId, {
            venue: VENUE,
            timestamp: this.now(),
            fundingRate,
            nextFundingTime: next,
            fundingIntervalHours: next && after && after > next ? (after - next) / 3_600_000 : undefined,
          });
        }
        return;
      case "liquidation-orders":
        for (const item of msg.data as Array<{ instId: string; details?: Array<{ side: "buy" | "sell"; posSide?: string; bkPx: string; sz: string; ts: string }> }>) {
          for (const d of item.details ?? []) {
            const price = num(d.bkPx);
            const size = num(d.sz);
            const ts = num(d.ts);
            if (!price || !size || !ts) continue;
            // A forced sell closes a long; in net mode posSide is "net" so fall back to side.
            const side = d.posSide === "long" || (d.posSide !== "short" && d.side === "sell") ? "long" : "short";
            const quantity = size * (this.contractValues.get(item.instId) ?? 1);
            this.sink.liquidation({ id: `okxl-${item.instId}-${d.ts}-${d.sz}`, venue: VENUE, symbol: item.instId, timestamp: ts, localTimestamp: this.now(), price, quantity, quoteVolume: price * quantity, side });
          }
        }
        return;
    }
  }
}

export interface SwapInfo {
  symbols: string[];
  contractValues: Map<string, number>;
}

/** OKX instCategory: "1" crypto, "3" stocks / pre-IPO, "4" commodities (gold, silver, oil). */
export const DEFAULT_CATEGORIES = ["1", "4"];

/** Top-`limit` live USDT perpetuals by 24h notional, with their contract values. */
export async function loadSwaps(
  limit: number,
  include?: string[],
  fetchImpl: typeof fetch = fetch,
  categories: string[] = DEFAULT_CATEGORIES
): Promise<SwapInfo> {
  const get = async <T>(path: string): Promise<T[]> => {
    const res = await fetchImpl(`${REST}${path}`);
    if (!res.ok) throw new Error(`OKX ${path} → HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T[] };
    return body.data ?? [];
  };
  const [instruments, tickers] = await Promise.all([
    get<{ instId: string; ctVal: string; state: string; instCategory?: string }>("/api/v5/public/instruments?instType=SWAP"),
    get<{ instId: string; last: string; volCcy24h: string }>("/api/v5/market/tickers?instType=SWAP"),
  ]);
  const contractValues = new Map<string, number>();
  for (const i of instruments) {
    const ct = num(i.ctVal);
    if (!i.instId.endsWith("-USDT-SWAP") || i.state !== "live" || !ct || ct <= 0) continue;
    // An explicit SYMBOLS list overrides the category filter.
    if (!include?.length && categories.length && !categories.includes(i.instCategory ?? "")) continue;
    contractValues.set(i.instId, ct);
  }
  let symbols: string[];
  if (include?.length) {
    symbols = include.map(normalizeSymbol).filter((s) => contractValues.has(s));
  } else {
    symbols = tickers
      .filter((t) => contractValues.has(t.instId))
      .map((t) => ({ id: t.instId, usd: (num(t.volCcy24h) ?? 0) * (num(t.last) ?? 0) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, limit)
      .map((t) => t.id);
  }
  return { symbols, contractValues };
}

/** BTC, BTCUSDT or BTC-USDT-SWAP → BTC-USDT-SWAP. */
export function normalizeSymbol(input: string): string {
  const s = input.trim().toUpperCase();
  if (s.endsWith("-USDT-SWAP")) return s;
  return `${s.replace(/-?USDT$/, "")}-USDT-SWAP`;
}

export interface FeedHealth {
  connected: boolean;
  lastMessageAt: number | null;
  reconnects: number;
  symbols: number;
}

export class OkxFeed {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private lastMessageAt: number | null = null;
  private reconnects = 0;
  private readonly parser: OkxMessageParser;

  constructor(
    private readonly swaps: SwapInfo,
    sink: FeedSink,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.parser = new OkxMessageParser(swaps.contractValues, sink);
  }

  health(): FeedHealth {
    return { connected: this.ws?.readyState === WebSocket.OPEN, lastMessageAt: this.lastMessageAt, reconnects: this.reconnects, symbols: this.swaps.symbols.length };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.on("open", () => {
      this.attempts = 0;
      this.log(`OKX connected, subscribing to ${this.swaps.symbols.length} symbols`);
      this.subscribe(ws);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.lastMessageAt && Date.now() - this.lastMessageAt > 45_000) {
          this.log("OKX feed stale, reconnecting");
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 20_000);
    });
    ws.on("message", (data) => {
      this.lastMessageAt = Date.now();
      this.parser.handle(data.toString());
    });
    ws.on("error", (error) => this.log(`OKX socket error: ${error.message}`));
    ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      this.reconnects++;
      const delay = Math.min(1000 * 2 ** this.attempts++, 30_000);
      this.log(`OKX closed, reconnecting in ${delay} ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private subscribe(ws: WebSocket): void {
    const args: Array<Record<string, string>> = [{ channel: "liquidation-orders", instType: "SWAP" }];
    for (const instId of this.swaps.symbols) {
      args.push({ channel: "trades", instId }, { channel: "open-interest", instId }, { channel: "funding-rate", instId });
    }
    // Keep each message small; OKX caps request size.
    for (let i = 0; i < args.length; i += 30) ws.send(JSON.stringify({ op: "subscribe", args: args.slice(i, i + 30) }));
  }
}
