# Screener, signals and forward test

This extends the single-symbol terminal with a service that watches many
perpetuals at once, scores them, follows every signal it emits, and can alert
you without a browser tab open.

```text
OKX WebSocket (trades, open interest, funding, liquidations)
    -> server/okxFeed.ts          normalize, convert contracts to base units
    -> lib/screener/screenerCore  one SymbolTracker per symbol, ranking, cooldown
    -> lib/signals/signalEngine   score 0-100 + trade plan
    -> lib/signals/tracker        forward test: R multiples, MFE/MAE, stats
    -> server/store, notify, http persistence, Telegram/webhook, API + SSE
    -> app/screener               ranked table, signals, forward-test stats
```

## Running it

```bash
npm install
npm run server          # service on http://127.0.0.1:8787
npm run dev             # web app on http://localhost:3000, open /screener
```

No exchange access? `DEMO=1 npm run server` runs the whole pipeline on
synthetic data (random walks with aggressive bursts). The prices and the
forward-test results it produces are not real.

Configuration is by environment variable; see `.env.example`.

## What a symbol is scored on

Two setup families are scored for both directions and the best wins.

| Setup | Components (weight) |
| --- | --- |
| Momentum | participation / volume z (25), aggressive flow (25), open-interest regime (20), side of VWAP (10), funding crowding (10) |
| Reversal | liquidation flush (30), absorption (25), CVD divergence (20), crowded funding against the move (15), participation (10) |

A reversal needs at least one trigger event (liquidations, absorption or CVD
divergence); funding alone never fires it. Scores of 60 or more are signals,
75 or more are "strong".

The plan places the stop beyond the last 30 minutes of structure, clamped
between 0.8 and 2 ATR (5-minute ATR), with targets at 1R, 2R and 3R.
`positionSize()` converts a risk percentage into units.

## Forward test

Every emitted signal is followed against later trade prints and closes at the
first of: stop (-1R), TP2 (+2R) or 4 hours (marked to market). The service
keeps win rate, expectancy, profit factor, MFE/MAE and R at 5/15/60 minutes
per score bucket, setup and direction.

Read it with care:

- The weights are heuristics. They are **not** a validated edge. The forward
  test exists to find out whether they are.
- Below about 30 closed signals per bucket the numbers are noise; the UI says so.
- Resolution uses trade prints, so a touch between prints can be missed.
- Fees, funding and slippage are not modelled.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | feed status, uptime, last scan |
| `GET /api/screener` | latest ranked rows |
| `GET /api/signals?limit=50` | followed signals, newest first |
| `GET /api/stats` | forward-test statistics |
| `GET /api/stream` | Server-Sent Events, one `scan` event per scan |

The service binds to `127.0.0.1` by default and is read-only. If you expose it,
set `API_TOKEN` (sent as `Authorization: Bearer ...` or `?token=`), set
`ALLOWED_ORIGIN` to your web app's origin, and put it behind TLS.

## Data limits worth knowing

- The service feeds from OKX perpetuals only. By default it tracks crypto and
  commodity contracts (OKX `instCategory` 1 and 4) and skips stock and
  pre-IPO perpetuals.
- The service does not subscribe to order books, so book imbalance is not part
  of its score (the terminal's other panels still use it).
- Absorption and iceberg markers are heuristics on trade and book data.
- Prior-session levels in the terminal are built from 5-minute klines: VWAP is
  exact, POC and value area are approximations.
- Open interest is reported in base units by OKX (`oiCcy`) and the 5-minute
  OI change is computed from samples taken at most every 5 seconds.
