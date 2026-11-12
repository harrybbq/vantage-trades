# Known gaps

What the code audit (October 2026) found that is **not** fixed yet, plus what
the redesign left out on purpose. Nothing here is dangerous while the app is
in paper mode with agents switched off (`AGENTS_ENABLED` unset). Several are
blockers for live money, and are marked.

Fixed and therefore not listed: Kill now liquidates (#1); per-tick sizing and
the sync wedge (#2); reconciliation error rows and staleness (#5); the test
suite's database guard (#7); halt never disabled, request timeouts (#8);
rejected orders recorded as rejected (#11); the panel's substituted values
(#12); flow-adjusted "today" and the same-money benchmark (#13); status
transitions take a row lock (#14).

## Before live money

- **Orphaned orders can produce an unattributable fill (#3).** If writing
  the broker's id back fails after the broker accepted an order, the order
  stays `pending` with no `broker_order_id`. A retry of the same decision is
  refused by the idempotency key, so it cannot double up — but the broker's
  fill for the orphan matches no order and is reported as unattributable, and
  the orphan blocks Kill until it is resolved. Nothing yet asks the broker
  about an orphan's idempotency key and repairs the link. Reconciliation does
  flag it the same day.
- **There is no live broker adapter (#6).** `BROKER=live` now refuses
  outright in every job and control (`src/broker/select.ts`), rather than
  half-applying. Building the adapter is the work.
- **The limits are only enforced in this codebase (#9).** `max_order_pct`
  and the daily loss cap live in the runner. They must also be set at the
  broker before live money: a limit this code owns is a limit a bug here can
  lift. The daily loss cap is measured against the previous close's equity.
  (Migration 0005's comment says the cap is enforced in the database; it is
  not, it is a self-halt in the runner.)
- **Paper fills are fractional; most real London fills are not.** The
  simulator will buy 2.76 shares of VWRP. A broker that only deals whole
  shares on the LSE would buy 2, leaving more cash idle, and on a small
  fund that difference is large. Decide the broker, then make the runner
  round to what that broker can actually fill, before trusting paper results
  as a forecast of live ones.
- **Costs are a guess.** The simulator charges £1 an order plus a 0.07%
  spread and slippage. On a £25 order that £1 is 4% each way. Replace these
  with the chosen broker's real schedule before judging any small agent.

## Smaller

- **Per-holding price age is not shown (#10).** A holding with no price shows
  as unknown, but one priced three days ago looks the same as one priced this
  morning. The banner catches a missed nightly check, not one old mark.
- **"Check now" during the scheduled run (#15)** can interleave two
  reconciliations. Low risk: both read the same broker state.
- **The 15-second poll can overwrite a newer view (#17)** if the poll request
  started before an action and returns after it. The next poll corrects it.
- **The paper broker's order and fill are separate statements (#18)**, not
  one transaction. A crash between them leaves a paper order without its fill.
- **The local dev server allows any origin (#16).** Local only; never deployed.
- **The `stats` action is no longer used by the panel (#19).** Harmless;
  remove with its tests in a tidy-up.
- **Alerts are only as reliable as the scheduler.** The watchdog is a
  separate function, but it runs on the same platform as the jobs it
  watches. If Netlify's scheduler stops entirely, nothing is sent. The
  weekly summary doubles as a heartbeat: a Saturday without one means look.

## Left out of the redesign on purpose

- **The "bad day in £" estimate** from the mockup needs about 60 days of
  VWRP prices to say anything; the feed has only just started. Build it once
  that history exists, from VWRP's own daily moves, never from a few weeks of
  an agent's.
- **Vantage's report is unchanged.** Its `pnlPctToday` is still measured from
  the previous close without removing money moved since. The contract is
  shipped against; change it deliberately, with Vantage, or not at all.
- **Restarting a killed agent** is still an open decision (fresh record, or
  resume its history), so there is no button for it.
