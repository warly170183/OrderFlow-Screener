import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, appendFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { loadSwaps, normalizeSymbol, OkxMessageParser, type FeedSink } from "../server/okxFeed";
import { Notifier, formatSignal } from "../server/notify";
import { Store } from "../server/store";
import { createApi } from "../server/http";
import { loadConfig } from "../server/config";
import { SignalTracker } from "@/lib/signals/tracker";
import type { Signal } from "@/lib/signals/signalEngine";
import type { DerivativesSnapshot, NormalizedLiquidation, NormalizedTrade } from "@/lib/types/market";

const signal: Signal = {
  symbol: "SOL-USDT-SWAP",
  time: 1000,
  direction: "long",
  setup: "momentum",
  score: 78,
  grade: "strong",
  reasons: ["Participation: volume z 3.5σ", "Aggressive flow: +45% net aggression"],
  components: [],
  plan: { entry: 150, stop: 148.5, tp1: 151.5, tp2: 153, tp3: 154.5, riskPct: 1, rr: 2 },
};

function sink() {
  const trades: NormalizedTrade[] = [];
  const liqs: NormalizedLiquidation[] = [];
  const derivs: Array<[string, DerivativesSnapshot]> = [];
  const s: FeedSink = { trade: (t) => trades.push(t), liquidation: (l) => liqs.push(l), derivatives: (sym, d) => derivs.push([sym, d]) };
  return { s, trades, liqs, derivs };
}

describe("OkxMessageParser", () => {
  const cv = new Map([["BTC-USDT-SWAP", 0.01]]);

  it("converts contract sizes to base units in trades", () => {
    const { s, trades } = sink();
    new OkxMessageParser(cv, s, () => 5).handle(JSON.stringify({ arg: { channel: "trades", instId: "BTC-USDT-SWAP" }, data: [{ tradeId: "1", instId: "BTC-USDT-SWAP", px: "60000", sz: "200", side: "sell", ts: "1700000000000" }] }));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ quantity: 2, quoteVolume: 120000, side: "sell", symbol: "BTC-USDT-SWAP", marketType: "perpetual", localTimestamp: 5 });
  });

  it("maps liquidations (forced sell = long liquidated) and scales by contract value", () => {
    const { s, liqs } = sink();
    new OkxMessageParser(cv, s).handle(JSON.stringify({ arg: { channel: "liquidation-orders" }, data: [{ instId: "BTC-USDT-SWAP", details: [
      { side: "sell", posSide: "long", bkPx: "59000", sz: "100", ts: "1700000000001" },
      { side: "buy", posSide: "net", bkPx: "61000", sz: "50", ts: "1700000000002" },
      { side: "sell", posSide: "net", bkPx: "60000", sz: "10", ts: "1700000000003" },
    ] }] }));
    expect(liqs.map((l) => l.side)).toEqual(["long", "short", "long"]);
    expect(liqs[0].quantity).toBe(1);
  });

  it("emits open interest and funding with the interval derived from timestamps", () => {
    const { s, derivs } = sink();
    const p = new OkxMessageParser(cv, s, () => 9);
    p.handle(JSON.stringify({ arg: { channel: "open-interest" }, data: [{ instId: "BTC-USDT-SWAP", oiCcy: "1234.5", ts: "1700000000000" }] }));
    p.handle(JSON.stringify({ arg: { channel: "funding-rate" }, data: [{ instId: "BTC-USDT-SWAP", fundingRate: "0.0001", fundingTime: "1700000000000", nextFundingTime: "1700028800000" }] }));
    expect(derivs[0][1].openInterest).toBe(1234.5);
    expect(derivs[1][1]).toMatchObject({ fundingRate: 0.0001, fundingIntervalHours: 8 });
  });

  it("ignores pongs, garbage and malformed payloads", () => {
    const { s, trades, liqs, derivs } = sink();
    const p = new OkxMessageParser(cv, s);
    p.handle("pong");
    p.handle("{not json");
    p.handle(JSON.stringify({ event: "subscribe" }));
    p.handle(JSON.stringify({ arg: { channel: "trades" }, data: [{ tradeId: "1", instId: "X", px: "abc", sz: "1", side: "buy", ts: "1" }] }));
    expect(trades.length + liqs.length + derivs.length).toBe(0);
  });
});

describe("loadSwaps / normalizeSymbol", () => {
  it("normalizes symbol spellings", () => {
    expect(normalizeSymbol("sol")).toBe("SOL-USDT-SWAP");
    expect(normalizeSymbol("SOLUSDT")).toBe("SOL-USDT-SWAP");
    expect(normalizeSymbol("SOL-USDT-SWAP")).toBe("SOL-USDT-SWAP");
  });

  it("ranks live USDT swaps by 24h notional and keeps contract values", async () => {
    const fetchImpl = (async (url: string) => ({
      ok: true,
      json: async () => url.includes("instruments")
        ? { data: [
            { instId: "BTC-USDT-SWAP", ctVal: "0.01", state: "live", instCategory: "1" },
            { instId: "ETH-USDT-SWAP", ctVal: "0.1", state: "live", instCategory: "1" },
            { instId: "NVDA-USDT-SWAP", ctVal: "1", state: "live", instCategory: "3" },
            { instId: "DEAD-USDT-SWAP", ctVal: "1", state: "suspend", instCategory: "1" },
            { instId: "BTC-USD-SWAP", ctVal: "100", state: "live" },
          ] }
        : { data: [
            { instId: "NVDA-USDT-SWAP", last: "200", volCcy24h: "1e12" },
            { instId: "ETH-USDT-SWAP", last: "3000", volCcy24h: "1000000" },
            { instId: "BTC-USDT-SWAP", last: "60000", volCcy24h: "100000" },
            { instId: "DEAD-USDT-SWAP", last: "1", volCcy24h: "1e12" },
          ] },
    })) as unknown as typeof fetch;
    const swaps = await loadSwaps(1, undefined, fetchImpl);
    // Stocks (category 3) are excluded by default even with the biggest notional.
    expect(swaps.symbols).toEqual(["BTC-USDT-SWAP"]);
    expect((await loadSwaps(5, undefined, fetchImpl, ["3"])).symbols).toEqual(["NVDA-USDT-SWAP"]);
    expect(swaps.contractValues.get("BTC-USDT-SWAP")).toBe(0.01);
    expect(swaps.contractValues.has("NVDA-USDT-SWAP")).toBe(false);
    expect((await loadSwaps(5, ["eth", "nope"], fetchImpl)).symbols).toEqual(["ETH-USDT-SWAP"]);
  });
});

describe("Notifier", () => {
  it("is a no-op without configuration", async () => {
    const calls: string[] = [];
    const n = new Notifier({}, (async (u: string) => { calls.push(u); return { ok: true }; }) as unknown as typeof fetch, undefined, 0);
    n.notifySignal(signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(n.enabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("posts to Telegram and the webhook, and never logs the token", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const logs: string[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => { calls.push({ url, body: init.body }); return { ok: url.includes("telegram") ? false : true, status: 500 }; }) as unknown as typeof fetch;
    const n = new Notifier({ telegramToken: "SECRET", telegramChatId: "42", webhookUrl: "https://hook.example/x" }, fetchImpl, (m) => logs.push(m), 0);
    n.notifySignal(signal);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0].url).toBe("https://api.telegram.org/botSECRET/sendMessage");
    expect(JSON.parse(calls[0].body)).toMatchObject({ chat_id: "42" });
    expect(calls[1].url).toBe("https://hook.example/x");
    expect(logs.join(" ")).toContain("HTTP 500");
    expect(logs.join(" ")).not.toContain("SECRET");
  });

  it("formats a readable signal message", () => {
    const text = formatSignal(signal);
    expect(text).toContain("LONG SOL");
    expect(text).toContain("score 78");
    expect(text).toContain("SL 148.50");
  });
});

describe("Store", () => {
  it("round-trips the tracker and reads recent events newest-first, skipping torn lines", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oft-store-"));
    const store = new Store(dir);
    await store.init();
    const tracker = new SignalTracker();
    tracker.open(signal);
    await store.saveTracker(tracker.toJSON());
    expect((await store.loadTracker())).toHaveLength(1);
    await store.append({ type: "signal", at: 1, signal });
    await store.append({ type: "signal", at: 2, signal });
    await appendFile(path.join(dir, "events.jsonl"), '{"type":"sig');
    const events = await store.recentEvents(5);
    expect(events.map((e) => e.at)).toEqual([2, 1]);
  });

  it("returns empty collections when nothing was saved", async () => {
    const store = new Store(await mkdtemp(path.join(os.tmpdir(), "oft-empty-")));
    expect(await store.loadTracker()).toEqual([]);
    expect(await store.recentEvents(3)).toEqual([]);
  });
});

describe("API", () => {
  async function request(port: number, p: string, headers: http.OutgoingHttpHeaders = {}) {
    return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }).on("error", reject);
    });
  }

  it("serves read-only endpoints, enforces the token and scopes CORS", async () => {
    const tracker = new SignalTracker();
    tracker.open(signal);
    const api = createApi({ latest: () => null, tracker, health: () => ({ feed: { connected: true } }), token: "s3cret", allowedOrigin: "http://localhost:3000" });
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    const port = (api.server.address() as AddressInfo).port;
    try {
      expect((await request(port, "/api/health")).status).toBe(401);
      expect((await request(port, "/api/health", { authorization: "Bearer wrong" })).status).toBe(401);
      const ok = await request(port, "/api/health", { authorization: "Bearer s3cret" });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ ok: true, feed: { connected: true } });
      expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(JSON.parse((await request(port, "/api/signals?limit=5&token=s3cret")).body)).toHaveLength(1);
      expect(JSON.parse((await request(port, "/api/stats?token=s3cret")).body).openCount).toBe(1);
      expect(JSON.parse((await request(port, "/api/screener?token=s3cret")).body).rows).toEqual([]);
      expect((await request(port, "/nope?token=s3cret")).status).toBe(404);
    } finally {
      api.close();
    }
  });
});

describe("loadConfig", () => {
  it("uses safe defaults: loopback bind, local CORS origin, no token", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8787, allowedOrigin: "http://localhost:3000", symbolLimit: 40, minScore: 60 });
    expect(c.apiToken).toBeUndefined();
  });

  it("parses overrides and ignores invalid numbers", () => {
    const c = loadConfig({ PORT: "9000", SYMBOLS: "btc, eth", COOLDOWN_MIN: "3", SYMBOL_LIMIT: "abc" });
    expect(c).toMatchObject({ port: 9000, symbols: ["btc", "eth"], cooldownMs: 180_000, symbolLimit: 40 });
  });
});
