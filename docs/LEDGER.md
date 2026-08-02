# The ledger

Everything in this app is a view over the ledger. This document covers the
parts that are not obvious from reading the schema.

## Why there is a ledger at all

The broker has no concept of your agents. One brokerage account, one set of
positions. If two agents both buy AAPL, the broker shows **one** AAPL position
and one blended average price.

Per-agent P/L — the entire point of the control panel — exists only because
this ledger computes it. Get it right and the rest is presentation. Get it
wrong and every number in the UI is confident fiction that is very hard to
notice.

## Currency

Sterling. The ledger is **single-currency by design** and the schema enforces
it: a journal entry that mixes currencies is rejected.

That is a real constraint, not an oversight. An entry containing two
currencies balances at one exchange rate and not at another, so "does this
entry sum to zero" stops having a single answer and reconciliation quietly
becomes meaningless. Supporting a second currency means an explicit FX
account and a decision about which rate applies when — a deliberate piece of
work, not a config change.

**This matters for the broker decision.** Alpaca is USD. Trading USD equities
through a GBP ledger needs that FX work first, or the pence figures will not
match what the broker reports. IBKR can hold GBP directly. That makes the
"affects nothing structural" note in `CLAUDE.md` not quite right: the adapter
layer is broker-agnostic, but currency is not.

## Money is integers

Pence, as `bigint`, everywhere. There is no floating point in the money path
and there must never be one — `0.1 + 0.2 !== 0.3` in IEEE 754, and a ledger
that cannot sum to exactly zero cannot be reconciled.

`parseMoney` refuses input it cannot represent exactly rather than rounding.
Quantities are scale-8 integers for the same reason.

All rounding goes through `notional()`. Two call sites rounding differently is
precisely how a ledger drifts by a penny a day.

## Sign convention

Assets are positive. Postings within an entry sum to exactly zero.

The consequence that trips people up: **a realised gain is a negative balance**
on `agent_realised`. That is standard double-entry — gains are credits — but it
reads backwards. `agentEquity()` flips the sign so callers see the intuitive
number, and that is the only place the flip happens.

| Account | Positive balance means |
|---|---|
| `pool` | unallocated capital available |
| `agent_cash` | capital allocated but not deployed |
| `agent_positions` | book value of open positions |
| `agent_realised` | a realised **loss** (gains are negative) |
| `agent_fees` | commission and fees paid |
| `external` | contra account for bank transfers |

## What the database enforces

These are constraints and triggers, not application checks. A check in
TypeScript is a check a bug can skip.

- **Entries balance.** Deferred to commit: at least two postings, summing to
  zero, in one currency.
- **The journal is append-only.** `UPDATE` and `DELETE` are rejected on
  `journal_entries` and `postings`. Mistakes are corrected by posting a
  reversing entry, which leaves both the error and the correction visible.
- **No agent can overdraw its allocation.** `agent_cash` cannot go negative.
  This is the budget cap, and raising it is the only thing that lifts it.
- **The pool cannot go negative.** Allocating capital that is not there would
  let allocations exceed the money in the account.
- **Every order names an agent.** `agent_id` is `NOT NULL`. An unattributed
  fill corrupts every number downstream and is very hard to reconstruct
  afterwards, so the schema makes one impossible to write.
- **Halt is authoritative.** A trigger rejects any order from an agent that is
  not `running`. Checked at the point of writing the order, so an agent whose
  loop is wedged mid-iteration still cannot slip one through.
- **Fills match their orders.** Agent, symbol and side must agree.
- **Broker ids are unique.** A replayed webhook or a re-polled fills endpoint
  cannot book the same fill twice. Order idempotency keys are unique for the
  same reason, so a retry after a timeout cannot open a second position.
- **A closed lot carries no basis.** Leftover basis on an empty lot is money
  attributed to a position that no longer exists.

## Cost basis

Lots close **FIFO within an agent**. The agent is always the outermost key, so
one agent's sell can never touch another's lots — the property that keeps two
AAPL holdings from bleeding into each other.

Each lot stores its cost as posted, and its *remaining* basis is tracked
explicitly rather than recomputed pro rata. Recomputing strands rounding
remainders on partially-closed lots; there is a test for exactly this
(`does not strand basis across repeated partial sells`).

Fees are **not** folded into cost basis. They sit in `agent_fees` where they
stay visible, because spread and commission are the dominant drag on a small
account and burying them in basis hides that.

## Reconciliation

Asserts `sum(agent equities) + unallocated == broker equity`, plus a
per-symbol quantity check — equity can match by coincidence while the
attribution underneath is wrong.

**There is no tolerance band.** `ok` means exactly zero drift. A tolerance is
how a slow leak goes unnoticed for a quarter.

When a held symbol has no mark, equity is recorded as `NULL` and the run is
`diverged`, not `ok`. A green tick that means nothing is worse than a red one.

## Halt, kill, start

| Control | Positions | Capital |
|---|---|---|
| **Halt** | left exactly as they are | stays allocated |
| **Kill** | all sold at market | returned to the pool |
| **Start** | — | uses its allocation |

Halt is a freeze, not a wind-down. A halted agent holding AAPL keeps holding
AAPL.

Kill is destructive and irreversible — it realises losses. `previewKill()`
returns a summary naming every position that would be sold, because the point
of the confirmation is that you can notice it is about to liquidate the wrong
agent. `standDown()` refuses while any position is still open: the capital
cannot return to the pool until the sells have actually filled.

`start()` refuses to restart a killed agent, because whether its P/L history
resumes or starts fresh is still an open decision and should not be settled by
a stray click.

## How equity is reconciled

Reconciliation values the **aggregate** position per symbol, then sums — not
the sum of per-agent equities.

The reason is arithmetic. A broker values one position of 9 shares. We
attribute 4 to one agent and 5 to another, and with fractional shares,
rounding each agent's slice separately can land a penny away from rounding the
whole. Reconciling on the per-agent sum would report a divergence every day,
and a check that cries wolf is a check nobody reads.

**The consequence is real and worth knowing:** per-agent equities need not sum
exactly to total equity when fractional shares are held. That residual is a
display artefact of attribution, not a ledger error. Cash and per-symbol
quantities are always exact.

## The order path

1. write the order to the ledger — halt is enforced here, by the schema
2. place it with the broker
3. record the broker's id against it

Placing first would leave a live order with no row if the process died in
between: the one failure that truly loses track of a position. This way the
worst case is an order row with no broker id, which `findOrphanedOrders()`
lists and the idempotency key makes safe to re-submit.

Steps 1 and 3 are separate transactions. Holding a database transaction open
across a network call to a broker is how a slow broker becomes an outage.

A broker fill whose order is not in the ledger is **never** guessed at. It is
reported as unattributable and fails reconciliation. Attributing it to the
wrong agent would corrupt two agents' numbers and be very hard to unpick.

## What is not built yet

- **No real broker.** `src/broker/paper.ts` is a simulator. The interface it
  implements is what a real adapter must satisfy.
- **No agents.** No loop, no strategy, no LLM. Every trade so far is
  hand-placed.
- **No UI, no reporting endpoint.**
- **No benchmark tracking.** Equity curve against buy-and-hold needs to exist
  from the first day an agent runs — retrofitting an honest benchmark never
  happens.
- **No FX.** Single-currency, sterling. See above: this constrains the broker
  choice.
