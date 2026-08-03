#!/usr/bin/env tsx
/**
 * Bundle the Netlify functions the way Netlify does, then run one.
 *
 * `npm run build` builds the browser bundle and never touches the functions,
 * so a function could typecheck, test green, build clean, deploy — and then
 * fail to load. That is not hypothetical: node-postgres is CommonJS, and
 * inlined into an ESM bundle it throws
 *
 *   Dynamic require of "events" is not supported
 *
 * before a line of our code runs. Every test passed the whole time, because
 * tests import the source directly and never see the bundle.
 *
 * So this builds the artefact that actually gets deployed and executes it.
 * The externals come from netlify.toml rather than being repeated here — the
 * check has to fail if that setting is removed, which is the entire point.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FUNCTIONS = ['control', 'report', 'health'];

/**
 * The `external_node_modules` list, read from the deployment config itself.
 *
 * Comment lines are dropped first. The whole value of this check is that it
 * fails when the setting goes away, and a version that happily reads the
 * setting out of a `#`-commented line would pass in exactly the case it is
 * meant to catch.
 */
function externals(): string[] {
  const toml = readFileSync('netlify.toml', 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const match = /external_node_modules\s*=\s*\[([^\]]*)\]/.exec(toml);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const external = externals();
console.log(`external_node_modules: ${external.length ? external.join(', ') : '(none)'}`);

// Inside the repository, not the system temp directory: an externalised
// dependency has to be resolvable at runtime, and Node resolves it by walking
// up from the bundle. Netlify does the same thing by shipping node_modules
// beside the function. A bundle in /tmp cannot see node_modules at all, which
// would fail for a reason that has nothing to do with what is being checked.
const out = '.fn-bundle';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of FUNCTIONS) {
  execFileSync(
    'npx',
    [
      'esbuild',
      `netlify/functions/${name}.ts`,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      ...external.map((pkg) => `--external:${pkg}`),
      `--outfile=${join(out, `${name}.mjs`)}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  console.log(`  bundled ${name}`);
}

// Importing is the check that matters: a CommonJS dependency inlined into an
// ESM bundle throws at load, not at call.
for (const name of FUNCTIONS) {
  await import(pathToFileURL(join(out, `${name}.mjs`)).href);
  console.log(`  loaded ${name}`);
}

// And then actually serve a request, so a driver that loads but cannot connect
// is caught here rather than in a browser.
if (process.env['DATABASE_URL']) {
  const { default: control } = (await import(
    pathToFileURL(join(out, 'control.mjs')).href
  )) as { default: (request: Request) => Promise<Response> };

  const response = await control(
    new Request('https://example.invalid/api/control', {
      headers: { authorization: 'Bearer checked-by-AUTH_MODE' },
    }),
  );
  const body = await response.text();

  if (response.status !== 200) {
    console.error(`\nthe bundled control function answered ${response.status}: ${body}`);
    process.exit(1);
  }
  console.log(`  served a request: ${response.status} ${body.slice(0, 120)}`);
}

console.log('functions bundle and run');
process.exit(0);
