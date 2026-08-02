#!/usr/bin/env tsx
/**
 * Build-time check on the two variables that get compiled into the bundle.
 *
 * Vite reads VITE_* when the bundle is built, not when it runs. A wrong value
 * therefore cannot be corrected by editing it in the hosting dashboard — the
 * old value stays in the JavaScript until something triggers another build.
 * That makes a bad value unusually hard to see: the dashboard shows the value
 * you meant, the site keeps behaving as though it were the value you replaced,
 * and nothing anywhere disagrees with you.
 *
 * So the build fails instead. A failed deploy is loud; a deployed bundle that
 * cannot sign in is not.
 *
 * It also refuses to compile a service_role or sb_secret_ key into public
 * JavaScript. That is the one mistake here with consequences past this app:
 * both keys bypass row-level security on the database this shares with
 * Vantage, and a bundle is downloadable by anyone who visits.
 */

import { webConfigReport } from '../src/server/config.js';

const hosted = Boolean(
  process.env['NETLIFY'] ?? process.env['CI'] ?? process.env['VERCEL'] ?? process.env['CF_PAGES'],
);

const configured = Boolean(
  process.env['VITE_SUPABASE_URL']?.trim() ?? process.env['VITE_SUPABASE_ANON_KEY']?.trim(),
);

// A local build with neither set is the normal development case: the panel
// skips the sign-in screen and talks to the local API, which has its own
// explicit bypass. On a hosting platform it means a deployed control surface
// with no way to authenticate, which is not a thing to ship quietly.
if (!configured && !hosted) {
  console.log('web env: VITE_SUPABASE_* not set — building without sign-in (local development)');
  process.exit(0);
}

const report = webConfigReport();

for (const check of report.checks) {
  console.log(`${check.ok ? '  ok' : 'FAIL'}  ${check.name}: ${check.detail}`);
}

if (!report.ok) {
  console.error(
    '\nRefusing to build: the browser bundle would be compiled with a Supabase\n' +
      'configuration that cannot sign in. Fix the variables above and build again —\n' +
      'these are read at build time, so a rebuild is required either way.\n',
  );
  process.exit(1);
}
