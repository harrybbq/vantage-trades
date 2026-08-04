#!/usr/bin/env node
/**
 * Parse every workflow file and report its triggers.
 *
 * A workflow whose YAML does not parse is not a failing workflow — it is an
 * absent one. GitHub silently declines to register it, and the only symptom is
 * that dispatching it answers "Workflow does not have 'workflow_dispatch'
 * trigger", which sounds like the trigger is missing rather than the file.
 *
 * That is exactly how it failed here: an inline script indented back to column
 * zero ended the YAML block scalar early, and the rest of the file became
 * nonsense. Nothing said so until the workflow was needed.
 *
 * Deliberately dependency-free. A validator that needs installing is one that
 * gets skipped, and this has to be cheap enough to run every time.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.github/workflows';

/**
 * Enough of a YAML check for this purpose.
 *
 * Not a parser: it looks for the mistake that actually happens, which is a
 * line inside a block scalar dedented past the key that opened it. Everything
 * after such a line is read as top-level YAML and usually still parses, which
 * is why the failure is silent.
 */
function blockScalarProblems(text) {
  const lines = text.split('\n');
  const problems = [];

  let openedAt = -1;
  let keyIndent = 0;

  lines.forEach((line, i) => {
    if (openedAt >= 0) {
      const blank = line.trim() === '';
      const indent = line.length - line.trimStart().length;

      if (!blank && indent <= keyIndent) {
        // The block ended. That is legal — unless it ended at column zero,
        // which no continuation of an indented key can legitimately do.
        if (indent === 0 && !/^[A-Za-z_-]+:/.test(line)) {
          problems.push(
            `line ${i + 1}: "${line.slice(0, 48)}" is at column 0 inside the block scalar ` +
              `opened on line ${openedAt + 1}. It ends the block and the file stops meaning ` +
              `what it looks like it means.`,
          );
        }
        openedAt = -1;
      }
      return;
    }

    const opener = /^(\s*)[\w.-]+:\s*[|>][-+]?\s*$/.exec(line);
    if (opener) {
      openedAt = i;
      keyIndent = opener[1].length;
    }
  });

  return problems;
}

let failed = false;

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  const path = join(DIR, file);
  const text = readFileSync(path, 'utf8');
  const problems = blockScalarProblems(text);

  if (problems.length) {
    failed = true;
    console.error(`FAIL ${path}`);
    for (const problem of problems) console.error(`       ${problem}`);
  } else {
    console.log(`  ok ${path}`);
  }
}

if (failed) {
  console.error('\nA workflow that does not parse is not registered by GitHub at all.');
  process.exit(1);
}
