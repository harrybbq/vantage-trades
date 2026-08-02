# Prompt for the Vantage repo

Copy everything below the line into a Claude Code session opened on
`harrybbq/vantage`.

---

## Task: add the read-only trading widget to the Vantage hub

I own a second app, **vantage-trades** (`harrybbq/vantage-trades`), which runs
AI agents that trade stocks in one brokerage account. I want a small,
owner-only widget on the Vantage hub that shows how those agents are doing.

Read this whole brief before writing anything. Several constraints below are
not negotiable and are easy to violate by accident.

### The relationship between the two apps

One direction only. **Vantage pulls; vantage-trades never pushes.** Vantage
cannot place orders, cannot halt agents, cannot move capital, and never holds
broker credentials. The widget is a window, not a control surface.

If you find yourself adding a button that does anything other than navigate or
refresh, stop — that is out of scope and belongs in the other app.

### Hard constraints

1. **Web-only. The widget must not be in the native build.**
   App stores treat brokerage data as financial services, and reviewers see the
   whole binary regardless of any owner-only gating. Vantage has not shipped
   yet, and putting a financial-services question in front of a reviewer who
   would otherwise never see one is a risk to *Vantage's* launch, not just to
   this feature. Gate it behind a platform check (Capacitor is in this repo —
   use it) so it is absent, not merely hidden, on iOS and Android.

2. **The token is a server-side secret.** It must never appear in client
   JavaScript and must never be prefixed `VITE_` — that bundles it into the
   public build. The browser must never call vantage-trades directly. Add a
   Netlify function in this repo that holds the token, calls the trading app
   server-to-server, and returns the payload to the widget.

3. **Send the token as a header, never a query string.** Query strings land in
   server logs, browser history and `Referer` headers. The header is
   `X-Vantage-Token`.

   (Points 2 and 3 exist because Vantage's own health-sync token got both
   wrong and had to be fixed retroactively. Don't repeat it.)

4. **Owner-only, checked server-side.** The Netlify function must verify the
   caller is me using the Supabase session, the same way anything sensitive in
   this repo already does. A client-side "is this the owner" check is
   decoration.

5. **Never do arithmetic on the money values.** They arrive as integer strings
   of minor units (pence). Format them for display; do not parse them into
   JavaScript numbers, sum them, or convert them. A JSON number is a double and
   cannot hold `2143.02` exactly. If you need a total, the payload already has
   one.

### The API you are consuming

`GET https://<vantage-trades-host>/api/report`
Header: `X-Vantage-Token: <token>`

Read-only. No other endpoint on that app is reachable with this token.

Real response, captured from the running system:

```json
{
  "asOf": "2026-08-02T18:32:01.426Z",
  "currency": "GBP",
  "totalEquityMinor": "518742",
  "unallocatedMinor": "150000",
  "agents": [
    {
      "id": "momentum-1",
      "name": "Momentum",
      "status": "halted",
      "allocatedMinor": "200000",
      "equityMinor": "203872",
      "pnlPctSinceStart": 1.93,
      "pnlPctToday": null,
      "holdings": [{ "symbol": "AAPL", "qty": "4.00000000" }]
    },
    {
      "id": "value-1",
      "name": "Value",
      "status": "running",
      "allocatedMinor": "150000",
      "equityMinor": "164870",
      "pnlPctSinceStart": 9.91,
      "pnlPctToday": null,
      "holdings": [{ "symbol": "AAPL", "qty": "5.00000000" }]
    }
  ],
  "reconciliation": { "status": "ok", "asOf": "2026-08-02T18:31:48.926Z" }
}
```

Field notes, all of which matter:

- **`*Minor` fields are integer strings of pence.** `"203872"` is £2,038.72.
- **`equityMinor` and `totalEquityMinor` can be `null`.** That means a holding
  has no current price, so equity is genuinely unknown. Render it as unknown —
  a dash, or "no price" — **never as £0.00**. A fabricated zero is worse than a
  gap because it looks like information.
- **`pnlPctSinceStart` and `pnlPctToday` are numbers, and can be `null`.**
  They are already derived and rounded, so numbers are safe here. `null` means
  no baseline yet (a fresh agent, or no prior close). Show a dash.
- **`status`** is one of `idle`, `running`, `halted`, `killed`. Killed agents
  are omitted from the payload entirely, so you will only see the first three.
- **`qty`** is a decimal string at 8 places. Trim trailing zeros for display —
  `"4.00000000"` should read as `4`.
- **`reconciliation.status`** is `ok`, `diverged` or `error`. **If it is not
  `ok`, every number in the payload is suspect and the widget must say so
  prominently.** That is the single most important piece of state here: it
  means the trading app's ledger has stopped agreeing with the broker. Do not
  render a normal-looking widget over a diverged reconciliation.

### What to build

**A Netlify function** in this repo, e.g. `netlify/functions/trading-summary.ts`:

- verifies the Supabase session and that the user is the owner
- reads the token from a server-side env var (`TRADING_REPORT_TOKEN`)
- calls the trading app's `/api/report` with the header
- returns the payload unchanged, with `Cache-Control: no-store`
- on upstream failure, returns a clear error rather than a stale or empty
  success — the widget must be able to tell "nothing there" from "could not
  reach it"

**A hub widget**, matching the existing hub's visual language — use the
established tokens in `src/index.css` (`--em`, `--gold`, the cream surfaces,
the Playfair/DM Sans/DM Mono pairing, the 8px spacing scale, the existing
radius and shadow scales). It should not look like a bolted-on panel.

Content, in priority order:

1. **Total fund** — the headline figure, plus how much is unallocated.
2. **A reconciliation warning**, if status is not `ok`. Loud, above everything.
3. **One row per agent**: name, status, current equity, P/L since start, P/L
   today, and its holdings.
4. **When it last updated** (`asOf`), so a stale widget is visibly stale.

Keep it compact — it is one card on a hub, not a dashboard. The other app has
the full control panel; this is the glance.

### Suggested approach

Look at how the existing hub widgets are built and follow that pattern rather
than inventing a new one. Reuse whatever data-fetching and error-handling
convention the hub already uses.

Before you start, tell me:
- which existing widget you are modelling it on
- how you plan to exclude it from the native build
- where the owner check lives

Then build it. Don't add the env var value to any file — I will set
`TRADING_REPORT_TOKEN` in the Netlify UI myself.

### Out of scope

- Any control action (halt, kill, allocate). Not now, not behind a flag.
- Storing or caching brokerage figures in Vantage's own database. Fetch and
  render; do not persist.
- Charts. The other app has those.
