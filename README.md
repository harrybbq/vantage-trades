# vantage-trades

Multiple AI agents that trade stocks automatically, with a control panel for
allocating capital and overriding them — halt, kill, start — at any point.
Sterling. Personal project, owner's own money.

Vantage gets a read-only widget looking into this app. This app is the source
of truth; Vantage never sends orders and never holds broker credentials.

See [`CLAUDE.md`](CLAUDE.md) for the decisions behind the design and
[`docs/LEDGER.md`](docs/LEDGER.md) for how the ledger works.

## Status

**The ledger and the control panel work against a simulated broker.** No real
broker is connected, and no agent exists — every trade so far is hand-placed.

| Step | State |
|---|---|
| 1. Ledger + paper broker | done against the simulator; **real broker adapter still to write** |
| 2. One dumb agent | not started |
| 3. Control panel | done — allocate, halt, kill, trading universe |
| 3b. Stats UI (equity curve, benchmark) | not started |
| 4. Read-only endpoint + Vantage widget | not started |
| 5. LLM agents | not started |

## What exists

```
supabase/migrations/     the schema, where every money rule is enforced
src/money.ts             integer pence, no floating point anywhere
src/ledger/              accounts, journal, allocation, fills, lots, equity,
                         reconciliation, agent control, trading universe
src/broker/paper.ts      simulator: spread, slippage, commission, own books
src/pipeline/            order submission and fill sync
src/api/, src/server/    the control-panel read model and its one handler
netlify/functions/       the deployed API
web/                     React 18 + Vite control panel, themed from Vantage
tests/                   86 tests, mostly about what must not happen
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

To use the control panel locally, in two terminals:

```bash
npm run dev:api      # localhost:8788 — refuses to start without AUTH_MODE
npm run dev:web      # localhost:5173
```

`npm run dev:api` has **no authentication** and says so; it only starts when
`AUTH_MODE=insecure-local` is set, and refuses outright under `NODE_ENV=production`.
In deployment the same handler verifies a Supabase token and checks it belongs
to the owner, on every request.

`npm run demo` is the fastest way to see the point of the system: two agents
buy the same symbol, the broker shows one position, and the control panel
still shows two different P/L figures.

## The control panel

Owner-only, web-only. Agent slots with capital allocation, halt, kill and the
trading universe.

**Who picks the stock:** the agent does, but only from a list you set. The
universe is a hard boundary enforced by a database trigger on buys, not a UI
filter — an agent with an empty universe can open nothing. Sells are never
constrained, so narrowing a universe can never trap an agent in a position it
cannot exit.

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
