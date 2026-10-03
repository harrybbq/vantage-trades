/**
 * Refuse to run the suite against anything but a local database.
 *
 * The tests TRUNCATE every ledger table between cases — TRUNCATE, not DELETE,
 * which also sidesteps the append-only triggers that protect the journal. So
 * the suite pointed at the deployed database would erase every order, fill and
 * position lot, which is the one outcome this codebase treats as worse than a
 * loss: losing track of positions.
 *
 * The deploy guide has the owner run a command against the deployed
 * DATABASE_URL. Exporting it rather than setting it inline, and then running
 * the tests in the same shell, is one ordinary mistake away. The demos already
 * refused non-local databases; the suite did not.
 *
 * Runs before any test file is loaded, so no truncate can get there first.
 */

process.env['DATABASE_URL'] ??= 'postgres://postgres:postgres@localhost:5432/vantage_trades';

const url = process.env['DATABASE_URL'] ?? '';
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
})();

if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  throw new Error(
    `refusing to run the test suite against ${host || 'an unparseable DATABASE_URL'}: ` +
      'the tests truncate every ledger table. Point DATABASE_URL at a local database.',
  );
}
