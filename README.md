# vantage-trades

Multiple AI agents that trade stocks automatically, with a control panel for
allocating capital and overriding them — halt, kill, start — at any point.
Sterling. Personal project, owner's own money.

Vantage gets a read-only widget looking into this app. This app is the source
of truth; Vantage never sends orders and never holds broker credentials.

See [`CLAUDE.md`](CLAUDE.md) for the decisions behind the design and
[`docs/LEDGER.md`](docs/LEDGER.md) for how the ledger works.

## Status

**Step 1 of 5 is complete against a simulated broker.** No real broker is
connected. No agent exists — every trade so far is hand-placed.

| Step | State |
|---|---|
| 1. Ledger + paper broker | done against the simulator; **real broker adapter still to write** |
| 2. One dumb agent | not started |
| 3. Stats UI | not started |
| 4. Read-only endpoint + Vantage widget | not started |
| 5. LLM agents | not started |

## What exists

```
supabase/migrations/0001_ledger.sql   the schema, where the safety rules live
supabase/migrations/0002_paper_broker.sql   the simulator's own separate books
src/money.ts                          integer pence, no floating point
src/ledger/                           accounts, journal, allocation, fills,
                                      lots, equity, reconciliation, control
src/broker/types.ts                   adapter interface
src/broker/paper.ts                   simulator: spread, slippage, commission
src/pipeline/                         order submission and fill sync
src/jobs/daily-reconcile.ts           the daily job
tests/                                59 tests, mostly about what must not happen
```

## Running it

Needs Postgres 16. The tests run against a real database — the safety
properties are database constraints, so testing them against a mock would
prove nothing.

```bash
npm install
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/vantage_trades"
npm run db:reset     # destroys and rebuilds the local database
npm test
npm run demo         # scripted end-to-end run, prints what it is doing
```

`npm run demo` is the fastest way to see the point of the system: two agents
buy the same symbol, the broker shows one position, and the control panel
still shows two different P/L figures.

## The paper broker

`src/broker/paper.ts` keeps its **own books**, in the `paper` schema, and knows
nothing about agents. That separation is the point — a simulator that read
from the ledger would make reconciliation circular and always agree.

It models spread, slippage and commission rather than filling at mid, and
rounds those costs against you. A round trip at an unchanged price loses
money, as it does in reality. A simulator that flatters a strategy is worse
than none, because it produces a number that feels earned.

## Money safety

Priority #1. Every change is checked against: can this place an order nobody
asked for, place a larger order than intended, or lose track of a position?

The rules that matter are enforced by the database rather than by application
code — see [`docs/LEDGER.md`](docs/LEDGER.md). Broker credentials are
server-side only and must never appear in a `VITE_`-prefixed variable, which
would bundle them into public JavaScript.
