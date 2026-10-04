/**
 * Display formatting. Nothing here does arithmetic on money.
 *
 * Amounts arrive from the server as integer strings of minor units and are
 * turned into text for the screen. They are never added, compared as numbers,
 * or round-tripped back through a float — every figure the panel shows was
 * already computed by the ledger, which is the only thing entitled to compute
 * it.
 */

/** `formatGBP('203872') === '£2,038.72'` */
export function formatGBP(minor: string | null): string {
  if (minor === null) return '—';

  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2);
  const pence = digits.slice(-2);

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}£${grouped}.${pence}`;
}

/** Rounded to the pound, for a headline where pence are noise. */
export function formatGBPRound(minor: string | null): string {
  if (minor === null) return '—';
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}£${whole}`;
}

export function formatPct(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** Trailing zeros on an 8dp quantity are noise; 4 whole shares is "4". */
export function formatQtyShort(qty: string): string {
  if (!qty.includes('.')) return qty;
  const trimmed = qty.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** Sign of a minor-unit string, without turning it into a number. */
export function signOf(minor: string | null): 'up' | 'down' | 'flat' | 'na' {
  if (minor === null) return 'na';
  if (minor.startsWith('-')) return 'down';
  return /^0+$/.test(minor) ? 'flat' : 'up';
}

export function directionClass(value: number | null): string {
  if (value === null) return 'na';
  return value >= 0 ? 'up' : 'down';
}

/** Signed pounds: `+£12.40`, `−£4.10`. A real minus sign, not a hyphen. */
export function formatSigned(minor: string | null): string {
  if (minor === null) return '—';
  const text = formatGBP(minor);
  if (minor.startsWith('-')) return `−${text.slice(1)}`;
  return /^-?0+$/.test(minor) ? text : `+${text}`;
}

/** Signed percent with an arrow, so the direction never rests on colour. */
export function formatPctArrow(value: number | null, dp = 2): string {
  if (value === null) return '—';
  if (Math.abs(value) < 10 ** -dp / 2) return `${(0).toFixed(dp)}%`;
  return `${value > 0 ? '▲ +' : '▼ −'}${Math.abs(value).toFixed(dp)}%`;
}

/** Percentage points: the gap between two returns. */
export function formatPp(value: number | null, dp = 1): string {
  if (value === null) return '—';
  if (Math.abs(value) < 10 ** -dp / 2) return `${(0).toFixed(dp)} pp`;
  return `${value > 0 ? '▲ +' : '▼ −'}${Math.abs(value).toFixed(dp)} pp`;
}

export function dirOf(value: number | null): 'up' | 'down' | 'flat' | 'unk' {
  if (value === null) return 'unk';
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

/** `2026-10-02` → `Fri 2 Oct`. */
export function formatDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** `2026-10-02` → `2 Oct`. */
export function formatDayShort(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
