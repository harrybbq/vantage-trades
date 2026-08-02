#!/usr/bin/env node
/**
 * Mint, list and revoke tokens for the read-only report endpoint.
 *
 *   npm run token:mint -- "vantage hub widget"
 *   npm run token:list
 *   npm run token:revoke -- <id>
 *
 * The token is printed once, at creation. Only its hash is stored, so nothing
 * here can show it to you again — if it is lost, mint a new one and revoke the
 * old. Rotation is the revocation mechanism.
 */

import { closePool, inTransaction } from '../db.js';
import { mintReportToken, revokeReportToken } from '../api/report.js';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'mint') {
    const label = rest.join(' ').trim() || 'unlabelled';
    const { id, token } = await inTransaction((tx) => mintReportToken(tx, label, 'owner'));

    console.log(`\nToken minted for "${label}"\n`);
    console.log(`  id     ${id}`);
    console.log(`  token  ${token}\n`);
    console.log('Copy it now — this is the only time it is shown. Store it as a');
    console.log('server-side secret in Vantage. It must never be prefixed VITE_,');
    console.log('and it must be sent as a header, never in a query string.\n');
    return;
  }

  if (command === 'revoke') {
    const id = rest[0];
    if (!id) throw new Error('usage: revoke <id>');
    const done = await inTransaction((tx) => revokeReportToken(tx, id, 'owner'));
    console.log(done ? `revoked ${id}` : `no active token with id ${id}`);
    return;
  }

  if (command === 'list' || command === undefined) {
    const rows = await inTransaction(async (tx) => {
      const result = await tx.query<{
        id: string;
        label: string;
        created_at: Date;
        last_used_at: Date | null;
        revoked_at: Date | null;
      }>(
        `select id, label, created_at, last_used_at, revoked_at
           from ledger.report_tokens order by created_at desc`,
      );
      return result.rows;
    });

    if (rows.length === 0) {
      console.log('no tokens. Mint one with: npm run token:mint -- "vantage hub widget"');
      return;
    }

    for (const row of rows) {
      const state = row.revoked_at ? `revoked ${row.revoked_at.toISOString()}` : 'active';
      const used = row.last_used_at ? `last used ${row.last_used_at.toISOString()}` : 'never used';
      console.log(`${row.id}  ${state.padEnd(38)} ${used.padEnd(38)} ${row.label}`);
    }
    return;
  }

  throw new Error(`unknown command: ${command}. Use mint, list or revoke.`);
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closePool();
    process.exit(1);
  });
