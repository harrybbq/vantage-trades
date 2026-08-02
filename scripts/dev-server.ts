#!/usr/bin/env node
/**
 * Local dev API. Serves the same handler Netlify serves, on localhost, so the
 * UI can be run and driven without deploying anything.
 *
 * Refuses to start unless AUTH_MODE=insecure-local is set explicitly, and
 * refuses outright when NODE_ENV is production. This server has no real auth;
 * making that a deliberate opt-in is the point.
 */

import { createServer } from 'node:http';
import { handle, serialise } from '../src/server/handler.js';
import { healthReport } from '../src/server/health.js';
import { closePool } from '../src/db.js';

const PORT = Number(process.env['API_PORT'] ?? 8788);

if (process.env['NODE_ENV'] === 'production') {
  console.error('dev-server must never run in production');
  process.exit(1);
}
if (process.env['AUTH_MODE'] !== 'insecure-local') {
  console.error('refusing to start: set AUTH_MODE=insecure-local to run the unauthenticated dev API');
  process.exit(1);
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    void (async () => {
      // The dev server and the Vite dev server are different origins.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      // Served here too, so the check behaves the same locally as deployed.
      // The Vite proxy rewrites only /api/control, so this arrives unchanged.
      if (/^\/(api\/)?health\b/.test(req.url ?? '')) {
        const report = await healthReport(req.headers as Record<string, string | undefined>);
        res.writeHead(report.ok ? 200 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(serialise(report));
        return;
      }

      let body: unknown = null;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(serialise({ error: 'body must be JSON' }));
          return;
        }
      }

      const result = await handle({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers as Record<string, string | undefined>,
        body,
      });

      res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(serialise(result.body));
    })();
  });
});

server.listen(PORT, () => {
  console.log(`control API (local, unauthenticated) on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
  });
}
