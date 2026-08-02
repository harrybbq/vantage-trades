# Deploying

The order matters. Each step fails in a recognisable way if the one before it
was skipped, which is the point.

## 0. The thing that causes a 404

Netlify builds your **production branch**. All the work is on
`claude/new-session-21dlla`; `main` contains only `README.md`. Netlify finds no
`package.json`, builds nothing, and serves a 404.

Either merge to `main`, or point Netlify's production branch at the working
branch in *Site configuration → Build & deploy → Branches*.

Nothing else on this list matters until the site actually builds.

## 1. A Supabase project

EU region, to match Vantage.

Apply the migrations in order. Either:

```bash
supabase link --project-ref <ref>
supabase db push
```

or paste each file in `supabase/migrations/` into the SQL editor, **in
numerical order**. They are not idempotent and they depend on each other.

Then confirm it took:

```sql
select count(*) from ledger.agents;          -- 0, not an error
select count(*) from research.experiments;   -- 0, not an error
```

## 2. Environment variables

Set these in the Netlify UI. Never in a file, never in a commit.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **connection pooler** URI, with `?sslmode=require` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | the anon key |
| `OWNER_USER_ID` | your Supabase user UUID — the only account allowed in |
| `BENCHMARK_SYMBOL` | optional, defaults to `VWRP` |

Two things that will bite:

- **Use the pooler URI, not the direct connection.** Serverless functions open
  a connection per invocation; the direct connection limit is small and you
  will exhaust it. The pool is capped at 1 connection per invocation when a
  serverless environment is detected.
- **`?sslmode=require` is mandatory for anything remote.** `getPool()` refuses
  a non-loopback URL without it rather than connecting in plaintext, and
  rather than silently adding it — you should be able to tell from the
  connection string whether a given deploy was encrypted.

**Never set `AUTH_MODE`.** It is a local-development bypass that skips the
owner check entirely. The handler refuses to start with it on a hosted
platform, but the safest version of that rule is not setting it.

Nothing here may be prefixed `VITE_`. That prefix bundles a value into public
JavaScript.

## 3. What "working" looks like

- `https://<site>/` → the control panel loads
- Signed out, or signed in as anyone but the owner → every request 401s, the
  panel shows "Cannot reach the control API"
- `https://<site>/api/report` with no token → `401 {"error":"not authorised"}`

If the panel loads but everything 401s, `OWNER_USER_ID` does not match your
Supabase user id. That is the expected failure and it fails closed.

If functions return 500, check the function log: a missing or non-SSL
`DATABASE_URL` throws with a message saying exactly that.

## 4. The report token for Vantage

Mint it against the deployed database, not your local one:

```bash
DATABASE_URL='<the same pooler URI>' npm run token:mint -- "vantage hub widget"
```

Printed once. Put it in Vantage's Netlify environment as
`TRADING_REPORT_TOKEN` — server-side, never `VITE_`-prefixed.

To rotate: mint a new one, update Vantage, then
`npm run token:revoke -- <old-id>`. Both work during the swap, so there is no
window where the widget is broken.

## 5. Scheduled jobs

Neither runs automatically yet. Reconciliation is **mandatory** once anything
real is connected — the equity curve only records a point on a clean
reconciliation, so without it the performance view stays empty and drift goes
unnoticed.

```bash
npm run job:reconcile   # daily, exits non-zero on divergence
npm run job:agents      # one tick per running agent
```

Netlify scheduled functions or an external cron both work. Until a real broker
exists there is nothing for either to do.

## Still true after all of this

- **No real broker is connected.** Deploying this deploys a control panel for a
  simulator.
- The Supabase auth path has never executed against a real Supabase — this
  deploy is the first time it runs anywhere.
- Corporate actions are unhandled, and the daily loss cap and max order size
  are app-side only. Both must be set broker-side before live money.
