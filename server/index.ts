// ============================================================
// SCREENER SERVICE
//   npm run server
// Streams OKX perpetuals, scores them continuously, keeps a forward-test of
// every signal, persists state, serves a read-only API and (optionally) pushes
// alerts to Telegram or a webhook — with no browser tab open.
// ============================================================

import { ScreenerCore, type ScanResult } from "@/lib/screener/screenerCore";
import { SignalTracker } from "@/lib/signals/tracker";
import { loadConfig } from "./config";
import { createApi } from "./http";
import { Notifier } from "./notify";
import { DemoFeed } from "./demoFeed";
import { loadSwaps, OkxFeed, type FeedSink, type SwapInfo } from "./okxFeed";
import { Store } from "./store";

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function main() {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  await store.init();

  const tracker = SignalTracker.fromJSON(await store.loadTracker());
  const core = new ScreenerCore({ minScore: config.minScore, cooldownMs: config.cooldownMs, warmupMs: config.warmupMs, minVolume1mUsd: config.minVolume1mUsd }, tracker);
  const notifier = new Notifier({ telegramToken: config.telegramToken, telegramChatId: config.telegramChatId, webhookUrl: config.webhookUrl }, fetch, log);

  const demo = process.env.DEMO === "1";
  const swaps: SwapInfo = demo
    ? { symbols: ["BTC", "ETH", "SOL", "XRP", "DOGE", "SUI", "LINK", "AVAX"].map((s) => `${s}-USDT-SWAP`), contractValues: new Map() }
    : await loadSwaps(config.symbolLimit, config.symbols, fetch, config.categories);
  if (demo) log("DEMO mode: synthetic data, not real prices");
  if (!swaps.symbols.length) throw new Error("No tradable symbols resolved; check SYMBOLS / network access to okx.com");
  const tracked = new Set(swaps.symbols);
  log(`Tracking ${swaps.symbols.length} perpetuals: ${swaps.symbols.map((s) => s.replace("-USDT-SWAP", "")).join(", ")}`);

  const sink: FeedSink = {
    trade: (t) => core.onTrade(t),
    // The liquidation channel covers every swap; keep only what we track.
    liquidation: (l) => void (tracked.has(l.symbol) && core.onLiquidation(l)),
    derivatives: (symbol, snapshot) => void (tracked.has(symbol) && core.onDerivatives(symbol, snapshot)),
  };
  const feed = demo ? new DemoFeed(swaps.symbols, sink) : new OkxFeed(swaps, sink, log);

  let latest: ScanResult | null = null;
  const startedAt = Date.now();
  const api = createApi({
    latest: () => latest,
    tracker,
    token: config.apiToken,
    allowedOrigin: config.allowedOrigin,
    health: () => ({
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      feed: feed.health(),
      notifications: notifier.enabled,
      lastScanAt: latest?.time ?? null,
    }),
  });

  const timer = setInterval(() => {
    const scan = core.scan(Date.now());
    latest = scan;
    api.broadcast(scan);
    for (const signal of scan.newSignals) {
      log(`SIGNAL ${signal.direction.toUpperCase()} ${signal.symbol} score ${signal.score} (${signal.setup})`);
      void store.append({ type: "signal", at: scan.time, signal }).catch((e) => log(`persist failed: ${e.message}`));
      notifier.notifySignal(signal);
    }
    for (const closed of scan.closed) {
      log(`CLOSED ${closed.signal.symbol} ${closed.outcome} ${closed.resultR?.toFixed(2)}R`);
      void store.append({ type: "closed", at: scan.time, tracked: closed }).catch((e) => log(`persist failed: ${e.message}`));
      notifier.notifyClosed(closed);
    }
  }, config.scanIntervalMs);

  const snapshotTimer = setInterval(() => {
    tracker.prune();
    void store.saveTracker(tracker.toJSON()).catch((e) => log(`snapshot failed: ${e.message}`));
  }, 60_000);

  api.server.listen(config.port, config.host, () => log(`API on http://${config.host}:${config.port}${config.apiToken ? " (token required)" : ""}`));
  feed.start();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log("Shutting down");
    clearInterval(timer);
    clearInterval(snapshotTimer);
    feed.stop();
    api.close();
    await store.saveTracker(tracker.toJSON()).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
