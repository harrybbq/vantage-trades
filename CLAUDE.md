# Trading agents app — session context

Owner: harrym3002@outlook.com (also owns **Vantage**, a React 18 + Vite
SPA on Supabase + Netlify — the sibling app this one reports into).

**Vantage is the mature app and the priority.** Months of work, publishing
within months. This app is the newer sibling. Where the two interact,
Vantage's schedule wins: nothing here may become a dependency of its
launch, and nothing here may complicate its store review. See
*Regulatory and store constraints* — for a shipping app that constraint
is now live, not hypothetical.

---

## What this is

A "digital factory": multiple AI agents that trade stocks automatically,
with a control panel the owner uses to allocate capital, start and stop
them, and watch how each is doing. Personal project, owner's own money,
possible side-hustle later.

**Vantage gets a read-only view** — one hub widget, owner-only, showing a
bar per agent. This app is the source of truth; Vantage never sends
orders and never holds broker credentials.

---

## Hard rules

- **MONEY SAFETY IS PRIORITY #1.** The equivalent of Vantage's data-safety
  rule. Every change must be checked against: can this place an order
  nobody asked for, place a larger order than intended, or lose track of
  a position? When unsure whether a change is money-safe, stop and
  confirm before letting it near a live account.
- **Paper trading until the ledger reconciles for weeks.** Live money is
  the last step, not the first.
- **Broker credentials live server-side only.** Never in client code,
  never in a `VITE_*`/`NEXT_PUBLIC_*` variable — those are bundled into
  public JavaScript. A UI check for "is this the owner" is decoration,
  not access control; verify identity on the server for every request
  that can move money.
- **Every order is attributed to an agent, at submission time.** An
  unattributed fill corrupts every number downstream and is very hard to
  reconstruct afterwards.
- **No secrets, API keys or account numbers in commits, PR bodies or code
  comments.**

---

## The core architecture decision: one account, your own ledger

**Funding is not programmatic.** Retail broker APIs do not let you
deposit or withdraw cash — that's a deliberate fraud boundary. Real money
enters and leaves the brokerage account by manual bank transfer.

So "input/withdraw money per agent" is **capital allocation**, not
banking: real cash sits in one brokerage account, and this app maintains
a ledger of how much each agent may deploy.

- *Give Agent 3 £500* → raises its budget cap. Instant, reversible, moves
  no cash.
- *Withdraw £500 from Agent 3* → it unwinds down to the new cap and the
  capital returns to the unallocated pool.

**The consequence that shapes everything:** the broker has no concept of
your agents. If two agents both buy AAPL, the broker shows *one* AAPL
position. Per-agent P/L — the entire point of the UI — exists only
because you compute it.

So the heart of this system is **a double-entry ledger**, not the agents:

- every fill is attributed to the requesting agent, with its own cost basis
- each agent's equity is derived from its own attributed positions
- the unallocated pool is a first-class account in the same ledger

Get this right first and everything else is a view over it. Get it wrong
and every number in the UI is confident fiction that is very hard to
notice.

**A daily reconciliation job is mandatory**, not a nice-to-have: assert
`sum(agent equities) + unallocated == broker account equity`. When they
diverge you have a bug, and you want to hear about it that day rather
than three months later.

> Rejected alternative: one brokerage sub-account per agent. Gives
> attribution for free, but multiplies minimums, fees and admin, and
> IBKR's multi-account structures are aimed at advisors. Revisit only if
> the ledger proves unmanageable.

---

## Agent control: halt, kill, and start

Three distinct controls. They are easy to conflate and dangerous to get
wrong, so the words are used precisely throughout the codebase:

| Control | Meaning | Positions | Capital |
|---|---|---|---|
| **Halt** | Agent freezes completely — opens nothing, closes nothing | Left exactly as they are | Stays allocated |
| **Kill** | Confirm prompt, then liquidate everything and stand down | All sold at market | Returned to the unallocated pool |
| **Start** | Resume from halted, or begin fresh | — | Uses its allocation |

- **Halt is a freeze, not a wind-down.** A halted agent holding AAPL keeps
  holding AAPL. This is the "something looks wrong, stop touching it"
  button.
- **Kill is destructive and irreversible** — it realises losses. It must
  be behind a confirmation ("Are you sure? This sells all N positions and
  returns £X to the pot"), and the confirmation should name what will
  actually be sold, not just say "are you sure".
- **A global kill switch** halts every agent at once, independent of any
  individual agent's state, and must work even if an agent's own loop is
  wedged.

**Halt must be authoritative, not advisory.** A flag checked once per
loop is a request, not a stop. Check it immediately before every order
submission. Back it with broker-side limits (max order size, daily loss
cap) so a runaway loop is bounded by something this codebase cannot
override.

---

## The Vantage link

One direction, read-only, no exceptions. Vantage pulls; this app never
pushes, and Vantage cannot place orders.

Endpoint returns roughly:

```json
{
  "asOf": "2026-08-01T12:00:00Z",
  "totalEquity": 5230.11,
  "unallocated": 1087.09,
  "agents": [
    {
      "id": "momentum-1",
      "name": "Momentum",
      "status": "running",
      "allocated": 2000.00,
      "equity": 2143.02,
      "pnlPctSinceStart": 7.15,
      "pnlPctToday": -0.42,
      "holdings": [{ "symbol": "AAPL", "qty": 4 }]
    }
  ]
}
```

Widget renders one bar per agent: total fund, P/L % since start and
today, and current holdings.

**Auth for this endpoint:**
- Token generated with `crypto.getRandomValues` (≥192 bits). Never
  `Math.random()` — it is not a CSPRNG and its state is recoverable from
  a few outputs.
- Sent as a **header**, not a query string — query strings land in server
  logs, browser history and referrers.
- **Rotatable**, with rotation as the revocation mechanism.
- Read-only scope. Even fully compromised, it reveals numbers and nothing
  more.

> These three rules exist because Vantage's health-sync token got the
> first two wrong and had to be fixed retroactively. Don't repeat it.

---

## Build order

Each step is deliberately useless-but-safe until the next. Do not skip
ahead to the agents — they are the easy part and the least valuable.

1. **Ledger + paper broker.** Alpaca paper trading (free, clean API) or
   IBKR paper (same API as live, so no rewrite later). Allocation ledger,
   per-agent attribution, reconciliation job. No LLM. Prove a hand-placed
   trade attributes correctly and reconciles against the broker's own
   equity figure.
2. **One dumb agent** — a fixed rule, no model. Proves the loop, halt,
   kill, and the ledger under live-ish conditions.
3. **Stats UI**, reading from the ledger.
4. **Read-only endpoint + Vantage widget.** Small once 1–3 exist.
5. **LLM agents** — benchmarked against buy-and-hold from their first day.

---

## Effectiveness: read this before believing a backtest

Carried over so a fresh session doesn't have to rediscover it.

**The benchmark is not "bot vs owner trading manually" — it is
buy-and-hold a global index fund.** Picking the wrong benchmark is how
people lose money for years without noticing.

- Retail traders lose money at a rate consistent across markets and
  decades. Barber & Odean's classic finding: the more retail traders
  trade, the worse they do — costs and timing, not luck.
- UK/EU brokers are legally required to publish the share of retail
  accounts losing money on CFDs. It sits around 70–80%. That is a
  regulatory disclosure, not marketing.

**Automation does not create an edge — it industrialises whatever edge
you have.** If the strategy is negative-expectancy after costs,
automation loses money faster and more reliably.

**LLMs are bad at price prediction.** They are good at reading filings,
summarising news, classifying sentiment and enforcing a rule set. Any
design shaped like "ask the model what will go up" is a known dead end,
and backtests over data inside the training cutoff look excellent for
exactly the wrong reason. Beware look-ahead bias generally: a backtest
without commission, spread and slippage will show profit on strategies
that lose money live.

**Build the thing that can prove the agents wrong before building the
agents.** Track the equity curve against SPY/VWRP on the same axes from
day one — retrofitting an honest benchmark later never happens.

---

## Running costs (rough, monthly)

Assuming daily-or-slower decisions on a handful of symbols:

| Item | Cost |
|---|---|
| Broker | £0 commission on many UK stock brokers; IBKR ~£1–3/trade. Spread is the real cost |
| Market data | Free delayed; real-time often included by broker. Dedicated feeds (Polygon/Databento) ~$30–200/mo |
| LLM API | ~$5–50/mo daily decisions, few symbols. Intraday/multi-agent/long-context → hundreds |
| Hosting | $0–20/mo |
| **Total** | **~£30–150/mo** |

Two traps: an agent re-reading a large context every tick can cost more
than it makes on a small account; and **the dominant cost is spread and
slippage, not infrastructure** — frequent trading on a £1,000 account can
shed several percent a year before any strategy decision is made.

The arithmetic to keep in view: a 10% year on £1,000 is £100 — less than
the running costs. This makes sense as a learning project, or at
meaningful capital once the paper record justifies it.

---

## Regulatory and store constraints

- **Own money, unregulated.** Trading your own account needs no permission.
- ⚠️ **Anyone else's money is FCA-authorised territory** — managing it,
  pooling it, selling signals or subscriptions, or advising. Doing that
  unauthorised is a **criminal offence**, not a fine. This decides
  whether the side-hustle can exist at all; settle it with a solicitor
  before building anything monetisable.
- ⚠️ **App stores treat brokerage data as financial services.** Apple and
  Google may require the developer to be the financial institution or be
  authorised by it. Reviewers see the whole binary regardless of
  owner-only gating. This may argue for keeping the Vantage widget
  web-only and absent from the native build — decide before building it.
- ⚠️ **This now bears on Vantage's own launch, not just this app's.** The
  widget is the one place brokerage data enters Vantage's binary. Adding
  it before Vantage has shipped and cleared review puts a financial-
  services question in front of a reviewer who would otherwise never see
  one, on the app that matters more. **Default: build the widget web-only,
  and not at all until Vantage is through review.** Overturn this
  deliberately, knowing it is Vantage's timeline being risked.

---

## Suggested stack

Owner already knows this stack from Vantage, so reuse unless there's a
reason not to: **React 18 + Vite** SPA, **Supabase** (Postgres + auth,
EU region) for the ledger, **Netlify** functions for anything holding a
secret. Broker SDK server-side only.

Ledger tables want real Postgres constraints — money in a JSON blob is
how attribution silently breaks. This is the opposite of Vantage's
single-JSON-state design, deliberately.

---

## Open decisions

- Broker: Alpaca (easy API, US equities, free paper) vs IBKR (broader
  markets, paper API matches live). The adapter layer keeps the ledger
  broker-agnostic — but **currency is not** covered by that, which the
  original note got wrong.

  The ledger is sterling and single-currency, enforced in the schema: an
  entry mixing currencies balances at one exchange rate and not at
  another, so "does this sum to zero" stops having a single answer and
  reconciliation quietly stops meaning anything. Alpaca is USD, so
  trading through it needs an FX account and a decision about which rate
  applies when — real work, before the first fill, not a config change.
  IBKR can hold GBP directly and avoids it. See `docs/LEDGER.md`.
- Whether agents may hold the same symbol simultaneously, or whether the
  factory enforces exclusive ownership per symbol. Simplifies attribution
  and reduces accidental concentration, at the cost of flexibility.
- What "start" does to an agent that was killed — fresh cost basis, or
  resumed history for its P/L-since-start figure.
