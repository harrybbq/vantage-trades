#!/usr/bin/env node
/**
 * Generate the Vantage: Trades marks.
 *
 * The V is drawn as paths rather than set in a font: a logo must render
 * identically everywhere, and text depends on a face being installed.
 *
 * The family works like this — the V, the dark tile and the rule beneath are
 * constant across every Vantage app. What varies is the rule's colour and the
 * small serif letter beside the V. That way a new sibling is two values, not a
 * new logo, and they all read as one family at a glance.
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const DARK = '#101014';
const EM = '#4dc485';
const ACCENT = { vantage: '#c8970a', trades: '#2bb6cc', home: '#9b7bd4' };

/** High-contrast serif V: thick left stroke, hairline right, bracketed serifs. */
function V(col, cx, cy, s) {
  const P = (x, y) => `${(cx + (x - 256) * s).toFixed(1)},${(cy + (y - 250) * s).toFixed(1)}`;
  return `  <g fill="${col}">
    <path d="M ${P(176, 170)} L ${P(249, 356)} L ${P(263, 356)} L ${P(340, 170)} L ${P(328, 170)} L ${P(257, 314)} L ${P(220, 170)} Z"/>
    <path d="M ${P(146, 159)} C ${P(160, 159)} ${P(168, 163)} ${P(172, 170)} L ${P(224, 170)} C ${P(228, 163)} ${P(236, 159)} ${P(250, 159)} L ${P(250, 150)} L ${P(146, 150)} Z"/>
    <path d="M ${P(306, 159)} C ${P(318, 159)} ${P(324, 163)} ${P(326, 170)} L ${P(342, 170)} C ${P(345, 163)} ${P(352, 159)} ${P(366, 159)} L ${P(366, 150)} L ${P(306, 150)} Z"/>
  </g>`;
}

/** Sub-brand letter, same serif skeleton as the V. */
function letter(glyph, col, cx, cy, s) {
  const P = (x, y) => `${(cx + x * s).toFixed(1)},${(cy + y * s).toFixed(1)}`;
  const box = (a, b, c, d) => `<path d="M ${P(a, b)} L ${P(c, b)} L ${P(c, d)} L ${P(a, d)} Z"/>`;
  const parts =
    glyph === 'T'
      ? [box(-38, -36, 38, -22), box(-9, -22, 9, 30), box(-24, 30, 24, 44)]
      : [
          box(-34, -36, -16, 44), box(16, -36, 34, 44), box(-16, -8, 16, 6),
          box(-44, -36, -6, -26), box(6, -36, 44, -26),
          box(-44, 34, -6, 44), box(6, 34, 44, 44),
        ];
  return `  <g fill="${col}">\n    ${parts.join('\n    ')}\n  </g>`;
}

const rule = (cx, y, w, col) =>
  `  <rect x="${cx - w / 2}" y="${y}" width="${w}" height="13" rx="2.5" fill="${col}"/>`;

const svg = (title, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${title}">
  <title>${title}</title>
  <rect width="512" height="512" rx="112" fill="${DARK}"/>
${inner}
</svg>
`;

const full = (accent, glyph, title) =>
  svg(title, [V(EM, 228, 248, 0.88), letter(glyph, EM, 364, 212, 0.58), rule(256, 388, 116, accent)].join('\n'));

const compact = (accent, title) =>
  svg(title, [V(EM, 256, 246, 1), rule(256, 388, 116, accent)].join('\n'));

mkdirSync('brand', { recursive: true });
mkdirSync('web/public', { recursive: true });

const tradesFull = full(ACCENT.trades, 'T', 'Vantage: Trades');
// No letter below ~32px: it turns to mush, and the rule colour is what
// actually distinguishes the siblings at that size.
const tradesIcon = compact(ACCENT.trades, 'Vantage: Trades');

const files = {
  'brand/vantage-trades.svg': tradesFull,
  'brand/vantage-trades-icon.svg': tradesIcon,
  'brand/vantage-home.svg': full(ACCENT.home, 'H', 'Vantage: Home'),

  // The app's copies are written from here rather than copied by hand, so the
  // favicon cannot quietly fall behind the mark it is supposed to be.
  'web/public/logo.svg': tradesFull,
  'web/public/favicon.svg': tradesIcon,
};

for (const [path, content] of Object.entries(files)) {
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
}
