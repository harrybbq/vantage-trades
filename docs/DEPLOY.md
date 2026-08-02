# Deploying

The order matters. Each step fails in a recognisable way if the one before it
was skipped, which is the point.

## 0. The thing that causes a 404

Netlify builds your **production branch**. All the work is on
`claude/new-session-21dlla`; `main` contains only `README.md`. Netlify finds no
`package.json`, builds nothing, and serves a 404.

**Simplest fix: merge the branch into `main`.** Then it does not matter what
the branch setting says or where Netlify has hidden it this month.

If you would rather point Netlify at the branch, the setting has moved around:
try *Site configuration → Build & deploy → Continuous deployment → Branches and
deploy contexts*. If there is no branch setting at all, the site is probably
not linked to the repository — check *Build & deploy → Continuous deployment*
for a "Link repository" button. A site created without a repo has nothing to
build, which produces exactly this 404.

Nothing else on this list matters until the site actually builds.

## 1. A database for the ledger

Any Postgres. The ledger *is* the app, so this is not optional — but it does
not have to be Supabase.

There are two reasonable choices.

### Option A — Netlify DB (least work)

Add it from the site's dashboard. It provisions a Neon Postgres and injects
`NETLIFY_DATABASE_URL` automatically; `getPool()` falls back to that variable,
so there is nothing to copy across and nothing to go stale when the database
is re-provisioned. Its URL already includes `sslmode=require`.

### Option B — inside Vantage's existing Supabase database

Also fine, and better isolated than it sounds. The ledger lives entirely in
three schemas of its own — `ledger`, `paper`, `research`. It creates no
extensions, no roles, no grants, never changes `search_path`, and never
references `public`. Every one of its tables has row-level security enabled
**and forced** with no policies, so even a leaked anon key reads nothing.

Verified rather than assumed: all eight migrations applied into a database
that already held other tables, then the full test suite ran against it, and
the other tables and their rows were untouched.

Run [`supabase/preflight.sql`](../supabase/preflight.sql) in the SQL editor
first. It changes nothing and tells you whether the three schema names are
free and whether the Postgres version is new enough.

Two costs you are accepting by sharing:

- **Blast radius.** A wrong `drop schema` in the SQL editor now has Vantage's
  data in the same window. Nothing in the code can cause this; a tired evening
  can.
- **Restore is coupled.** You cannot point-in-time restore the ledger without
  rewinding Vantage too. In practice the ledger is append-only and corrected
  with reversing entries rather than restores, so this is smaller than it
  first appears — but it is real, and it is the reason to prefer Option A if
  you have no preference.

Also check *Supabase → Settings → API → Exposed schemas* lists only `public`
(and `graphql_public`). The ledger's schemas must not be added there. Forced
RLS would still deny everything, but two layers beats one.

Apply the migrations in `supabase/migrations/` **in numerical order**, 0001
through 0008 — they are not idempotent and each depends on the last. Use the
SQL editor in the Neon console behind your Netlify DB (or `supabase db push`
if you did choose Supabase).

Then confirm it took:

```sql
select count(*) from ledger.agents;          -- 0, not an error
select count(*) from research.experiments;   -- 0, not an error
```

## 2. Environment variables

Set these in the Netlify UI. Never in a file, never in a commit.

| Variable | Value |
|---|---|
| `DATABASE_URL` | **not needed with Netlify DB** — it injects `NETLIFY_DATABASE_URL` |
| `SUPABASE_URL` | Vantage's `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Vantage's anon key |
| `OWNER_USER_ID` | your Supabase user UUID — the only account allowed in |
| `VITE_SUPABASE_URL` | the same URL again, for the sign-in screen |
| `VITE_SUPABASE_ANON_KEY` | the same anon key again, for the sign-in screen |
| `BENCHMARK_SYMBOL` | optional, defaults to `VWRP` |

**The two `VITE_` ones are deliberate and safe.** A Supabase project URL and
its anon key are designed to be public — the anon key identifies the project
and grants nothing on its own, and every permission decision is made
server-side against your user token. They are the only values in this app
allowed that prefix. The database URL, the broker credentials and the report
token must never carry it; that prefix bundles a value into JavaScript anyone
can read.

`VITE_` values are read **at build time**, so changing them requires a
redeploy, not just a save. A build without them has no sign-in screen at all
and every request 401s — the panel says so explicitly rather than leaving you
to guess.

The `SUPABASE_*` variables and the database URL are read in completely
separate places and do not have to point at the same project. Pointing auth at
Vantage's existing Supabase means your current login works and your user id
already exists, while the ledger lives somewhere Vantage cannot be affected by.

Two things that will bite:

- **Use a pooler URI where one is offered.** Serverless functions open a
  connection per invocation; a direct-connection limit is small and you will
  exhaust it. The pool is capped at one connection per invocation when a
  serverless environment is detected.
- **`sslmode=require` is mandatory for anything remote.** `getPool()` refuses
  a non-loopback URL without it rather than connecting in plaintext, and
  rather than silently adding it — you should be able to tell from the
  connection string whether a given deploy was encrypted. Netlify DB and Neon
  include it already.

**Never set `AUTH_MODE`.** It is a local-development bypass that skips the
owner check entirely. The handler refuses to start with it on a hosted
platform, but the safest version of that rule is not setting it.

Nothing here may be prefixed `VITE_`. That prefix bundles a value into public
JavaScript.

## 3. What "working" looks like

- `https://<site>/` → a sign-in screen
- Sign in with your Vantage account → the control panel
- Signed in as anyone else → "this account is not the owner"
- `https://<site>/api/report` with no token → `401 {"error":"not authorised"}`

Then, from an empty database, the first run is:

1. **Record cash in** — the amber bar. This records a bank transfer you have
   already made; it does not move money, because no broker API can.
2. **Add an agent** — starts idle, with no capital and an empty universe, so
   it can place nothing.
3. **Capital** — allocate from the pool. A budget cap, not a transfer.
4. **Universe** — the symbols it may open a position in.
5. **Start**.

Nothing will trade: no broker is connected and the agent runner is not
scheduled. Everything else — allocation, halt, kill, the ledger — is live.

If functions return 500, check the function log: a missing or non-SSL database
URL throws with a message saying exactly that.

## 4. The report token for Vantage

Mint it against the deployed database, not your local one:

```bash
DATABASE_URL='<the deployed database URL>' npm run token:mint -- "vantage hub widget"
```

With Netlify DB, copy the URL from the Neon console for this one command. It
is the only time you need it by hand.

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
