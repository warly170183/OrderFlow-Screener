// ============================================================
// HTTP API (read-only)
//   GET /api/health     feed and service status
//   GET /api/screener   latest ranked rows
//   GET /api/signals    followed signals, newest first (?limit=50)
//   GET /api/stats      forward-test statistics
//   GET /api/stream     Server-Sent Events, one "scan" event per scan
//
// Security defaults: bound to 127.0.0.1 by the caller, an optional bearer
// token (API_TOKEN), and CORS only for the configured origin.
// ============================================================

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ScanResult } from "@/lib/screener/screenerCore";
import type { SignalTracker } from "@/lib/signals/tracker";

export interface ApiContext {
  latest(): ScanResult | null;
  tracker: SignalTracker;
  health(): Record<string, unknown>;
  token?: string;
  allowedOrigin?: string;
}

export interface ApiServer {
  server: http.Server;
  /** Push a scan to every connected SSE client. */
  broadcast(scan: ScanResult): void;
  close(): void;
}

function tokenOk(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApi(ctx: ApiContext): ApiServer {
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (ctx.allowedOrigin) {
      headers["access-control-allow-origin"] = ctx.allowedOrigin;
      headers["access-control-allow-headers"] = "authorization";
      headers.vary = "Origin";
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, headers).end();
      return;
    }
    if (ctx.token) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      if (!tokenOk(bearer ?? url.searchParams.get("token"), ctx.token)) {
        res.writeHead(401, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { ...headers, "content-type": "application/json" }).end(JSON.stringify(body));
    };

    switch (url.pathname) {
      case "/api/health":
        return json(200, { ok: true, ...ctx.health() });
      case "/api/screener":
        return json(200, ctx.latest() ?? { time: null, rows: [], newSignals: [], closed: [] });
      case "/api/signals": {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        return json(200, ctx.tracker.recent(limit));
      }
      case "/api/stats":
        return json(200, ctx.tracker.stats());
      case "/api/stream": {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        const latest = ctx.latest();
        if (latest) res.write(`event: scan\ndata: ${JSON.stringify(latest)}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }
      default:
        return json(404, { error: "not found" });
    }
  });

  return {
    server,
    broadcast(scan) {
      if (!clients.size) return;
      const frame = `event: scan\ndata: ${JSON.stringify(scan)}\n\n`;
      for (const client of clients) client.write(frame);
    },
    close() {
      for (const client of clients) client.end();
      clients.clear();
      server.close();
    },
  };
}
