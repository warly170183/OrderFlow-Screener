// Environment-driven configuration for the screener service.

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  symbolLimit: number;
  symbols?: string[];
  categories: string[];
  scanIntervalMs: number;
  minScore: number;
  cooldownMs: number;
  warmupMs: number;
  minVolume1mUsd: number;
  apiToken?: string;
  allowedOrigin?: string;
  telegramToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
}

const int = (v: string | undefined, d: number, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && v !== undefined && v !== "" ? n : d;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    host: env.HOST || "127.0.0.1",
    port: int(env.PORT, 8787, 1),
    dataDir: env.DATA_DIR || "./data",
    symbolLimit: int(env.SYMBOL_LIMIT, 40, 1),
    symbols: env.SYMBOLS ? env.SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    categories: env.CATEGORIES ? env.CATEGORIES.split(",").map((s) => s.trim()).filter(Boolean) : ["1", "4"],
    scanIntervalMs: int(env.SCAN_INTERVAL_MS, 2000, 250),
    minScore: int(env.MIN_SCORE, 60, 1),
    cooldownMs: int(env.COOLDOWN_MIN, 10, 0) * 60_000,
    warmupMs: int(env.WARMUP_MIN, 5, 0) * 60_000,
    minVolume1mUsd: int(env.MIN_VOLUME_1M_USD, 20_000, 0),
    apiToken: env.API_TOKEN || undefined,
    allowedOrigin: env.ALLOWED_ORIGIN ?? "http://localhost:3000",
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    webhookUrl: env.WEBHOOK_URL || undefined,
  };
}
