// ============================================================
// NOTIFICATIONS
// Telegram (bot token + chat id) and/or a generic JSON webhook. Both are
// optional; with neither configured the notifier is a no-op.
// ============================================================

import type { Signal } from "@/lib/signals/signalEngine";
import type { TrackedSignal } from "@/lib/signals/tracker";

export interface NotifierConfig {
  telegramToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
}

const fmtPrice = (p: number) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const base = (symbol: string) => symbol.replace(/-USDT-SWAP$|USDT$/, "");

export function formatSignal(s: Signal): string {
  const arrow = s.direction === "long" ? "🟢 LONG" : "🔴 SHORT";
  const lines = [
    `${arrow} ${base(s.symbol)} — score ${s.score} (${s.grade}, ${s.setup})`,
    `Entry ${fmtPrice(s.plan.entry)} · SL ${fmtPrice(s.plan.stop)} (${s.plan.riskPct.toFixed(2)}%)`,
    `TP1 ${fmtPrice(s.plan.tp1)} · TP2 ${fmtPrice(s.plan.tp2)} · TP3 ${fmtPrice(s.plan.tp3)}`,
    ...s.reasons.slice(0, 4).map((r) => `• ${r}`),
    "Heuristic signal, not advice. Check the chart before acting.",
  ];
  return lines.join("\n");
}

export function formatClosed(t: TrackedSignal): string {
  const r = t.resultR ?? 0;
  const icon = r > 0 ? "✅" : r < 0 ? "❌" : "➖";
  return `${icon} ${base(t.signal.symbol)} ${t.signal.direction} closed: ${t.outcome} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R, MFE ${t.mfeR.toFixed(2)}R)`;
}

export class Notifier {
  private lastSent = 0;
  private queue: string[] = [];
  private draining = false;

  constructor(
    private readonly config: NotifierConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (message: string) => void = () => undefined,
    private readonly minGapMs = 1100
  ) {}

  get enabled(): boolean {
    return Boolean((this.config.telegramToken && this.config.telegramChatId) || this.config.webhookUrl);
  }

  notifySignal(signal: Signal): void {
    this.enqueue(formatSignal(signal), { kind: "signal", signal });
  }

  notifyClosed(tracked: TrackedSignal): void {
    this.enqueue(formatClosed(tracked), { kind: "closed", tracked });
  }

  private enqueue(text: string, payload: unknown): void {
    if (!this.enabled) return;
    this.queue.push(JSON.stringify({ text, payload }));
    void this.drain();
  }

  /** Telegram allows roughly one message per second per chat; send serially with a gap. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const wait = this.lastSent + this.minGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const { text, payload } = JSON.parse(this.queue.shift() as string) as { text: string; payload: unknown };
        this.lastSent = Date.now();
        await this.send(text, payload);
      }
    } finally {
      this.draining = false;
    }
  }

  private async send(text: string, payload: unknown): Promise<void> {
    const { telegramToken, telegramChatId, webhookUrl } = this.config;
    try {
      if (telegramToken && telegramChatId) {
        const res = await this.fetchImpl(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: telegramChatId, text, disable_web_page_preview: true }),
        });
        // Never log the URL: it contains the bot token.
        if (!res.ok) this.log(`Telegram responded HTTP ${res.status}`);
      }
      if (webhookUrl) {
        const res = await this.fetchImpl(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...(payload as object) }) });
        if (!res.ok) this.log(`Webhook responded HTTP ${res.status}`);
      }
    } catch (error) {
      this.log(`Notification failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
