// ============================================================
// PERSISTENCE
// Plain files, no native dependencies:
//   events.jsonl   append-only log of every signal and every closed outcome
//   tracker.json   snapshot of the SignalTracker, rewritten atomically
// ============================================================

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Signal } from "@/lib/signals/signalEngine";
import type { TrackedSignal } from "@/lib/signals/tracker";

export type StoredEvent =
  | { type: "signal"; at: number; signal: Signal }
  | { type: "closed"; at: number; tracked: TrackedSignal };

export class Store {
  private readonly events: string;
  private readonly snapshot: string;

  constructor(private readonly dir: string) {
    this.events = path.join(dir, "events.jsonl");
    this.snapshot = path.join(dir, "tracker.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async append(event: StoredEvent): Promise<void> {
    await appendFile(this.events, `${JSON.stringify(event)}\n`, "utf8");
  }

  async saveTracker(items: TrackedSignal[]): Promise<void> {
    const tmp = `${this.snapshot}.tmp`;
    await writeFile(tmp, JSON.stringify(items), "utf8");
    await rename(tmp, this.snapshot);
  }

  async loadTracker(): Promise<TrackedSignal[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.snapshot, "utf8"));
      return Array.isArray(parsed) ? (parsed as TrackedSignal[]) : [];
    } catch {
      return [];
    }
  }

  /** Most recent events first; tolerates a torn last line. */
  async recentEvents(limit: number): Promise<StoredEvent[]> {
    let text: string;
    try {
      text = await readFile(this.events, "utf8");
    } catch {
      return [];
    }
    const out: StoredEvent[] = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        out.push(JSON.parse(lines[i]) as StoredEvent);
      } catch {
        // skip a partially written line
      }
    }
    return out;
  }
}
