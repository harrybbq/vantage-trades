/**
 * The Vantage: Trades mark.
 *
 * Served from `/logo.svg` rather than inlined, so there is one copy of the
 * artwork and it comes from `scripts/build-brand.mjs` like the favicon does.
 * Inlining it here would be a second copy to keep in step, and the one that
 * drifts is always the one nobody is looking at.
 *
 * Decorative: the heading beside it already names the app, so an alt text
 * would just make a screen reader say it twice.
 */

export function Mark({ size = 40 }: { size?: number }) {
  return (
    <img
      className="mark"
      src="/logo.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
