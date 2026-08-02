# vantage-trades

Multiple AI agents that trade stocks automatically, with a control panel for
allocating capital and overriding them — halt, kill, start — at any point.
Sterling. Personal project, owner's own money.

Vantage gets a read-only widget looking into this app. This app is the source
of truth; Vantage never sends orders and never holds broker credentials.

See [`CLAUDE.md`](CLAUDE.md) for the decisions behind the design,
[`docs/LEDGER.md`](docs/LEDGER.md) for how the ledger works, and
[`docs/RESEARCH.md`](docs/RESEARCH.md) for what can and cannot be established
about a strategy before real money.

## Status

**The ledger, the control panel and one agent work against a simulated
broker.** No real broker is connected, so no real money has moved.

| Step | State |
|---|---|
| 1. Ledger + paper broker | done against the simulator; **real broker adapter still to write** |
| 2. One dumb agent | done — SMA crossover, with rails, benchmarked |
| 3. Control panel | done — allocate, halt, kill, trading universe |
| 3b. Performance view (equity curve vs benchmark) | done |
| 4. Read-only endpoint + Vantage widget | not started |
| 5. LLM agents | not started |

## What exists

```
supabase/migrations/     the schema, where every money rule is enforced
src/money.ts             integer pence, no floating point anywhere
src/ledger/              accounts, journal, allocation, fills, lots, equity,
                         reconciliation, agent control, trading universe
src/broker/paper.ts      simulator: spread, slippage, commission, own books
src/agents/              strategy interface, SMA crossover, the runner
src/research/            backtester, metrics, experiment register, hold-outs
src/pipeline/            order submission and fill sync
src/api/, src/server/    the control-panel read model and its one handler
netlify/functions/       the deployed API
web/                     React 18 + Vite control panel, themed from Vantage
tests/                   143 tests, mostly about what must not happen
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

`npm run demo:agent` runs the dumb agent over 120 simulated days and prints
its return next to buy-and-hold. It loses. That is the expected result and the
reason the benchmark exists.

`npm run demo:research` shows what searching for a strategy actually looks
like: twelve variants, a winner, and then the two things that are usually
invisible — how much the winner's result is worth once you account for having
tried twelve, and how it does on data it has never seen.

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

## The agent

`src/agents/` holds one fixed-rule strategy — a moving-average crossover, no
model. It exists to prove the loop, the halt, the kill and the ledger under
live-ish conditions, and it is **not** expected to make money.

A strategy is a pure function from a snapshot of the world to a list of
intentions. No database handle, no broker, no clock. It cannot place an order,
only ask for one, and the runner decides whether that request survives:

1. the agent is running (re-read immediately before each order)
2. the tick is not too soon (a crash-loop must not become a trading loop)
3. the daily loss cap is not breached (self-halt, not "try again")
4. the order is within `max_order_pct`
5. the symbol is in the universe

Gates 1 and 5 are database triggers, so they hold even if the runner is wrong.
Gates 3 and 4 live only in the runner — which is exactly why **the same limits
must be set broker-side before any of this touches real money.** A limit this
codebase owns is a limit a bug in this codebase can lift.

**Exits are never blocked.** Not by the order-size cap, not by narrowing the
universe. A rail that stops you closing a position preserves exposure rather
than limiting it.

## The benchmark

Every reconciled day writes an equity snapshot with the index price beside it,
from the first day, before any agent ran. The comparison is the fund against
buy-and-hold over the same dates — not against trading by hand, and not over a
window chosen afterwards.

One caveat worth knowing: the fund figure includes unallocated cash sitting
idle, which drags it down against a fully-invested index. That is the honest
comparison for "should I be doing this at all", but it is not a like-for-like
measure of the strategy itself.

## The performance view

A second tab on the control panel. The fund's equity curve and the same
starting capital left in the benchmark, **on one axis, both in pounds** — the
benchmark is rebased server-side into money rather than shown as an index
level, because a second y-axis lets any pair of lines tell any story.

Series colours were validated for colour-blind separation against both
surfaces. The obvious choice, a muted grey benchmark against the green fund
line, failed badly for deuteranopia (ΔE 4.4 where 15 is the floor), so both
series carry real chroma and the hierarchy is done with dash and weight.

## Research discipline

`src/research/` is the tooling for not fooling yourself, and
[`docs/RESEARCH.md`](docs/RESEARCH.md) explains why each piece exists.

The short version: with a Sharpe of 0.5 you need about 16 years of data to
tell skill from luck, and testing twenty variants means one clears a 5% bar by
chance. So every experiment is registered before it runs with an immutable
hypothesis, the count of trials raises the significance bar, and held-out data
is sealed behind a one-way lock.

None of it makes a strategy work. It makes it harder to believe one does when
it does not.
