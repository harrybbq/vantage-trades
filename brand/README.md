# The Vantage mark, extended

`Vantage: Trades` is a sibling of Vantage, not a separate brand, so the mark is
the parent's with two variables changed.

## What is constant

- the dark tile (`#101014`), rounded at 22% of its width
- the emerald serif **V** (`#4dc485`) — the same letterform and proportions
- a rule beneath it

## What varies per app

| App | Rule colour | Letter |
|---|---|---|
| Vantage | `#c8970a` gold | none |
| Vantage: Trades | `#2bb6cc` teal | T |
| Vantage: Home | `#9b7bd4` violet | H |

A new sibling is two values, not a new logo, and they still read as one family
sitting next to each other on a home screen.

## Two sizes, not one

- **`vantage-trades.svg`** — the full mark, V with a small serif T. Use at
  32px and above.
- **`vantage-trades-icon.svg`** — V and rule only. Use at 32px and below:
  favicons, tab strips, notification badges.

The letter is dropped deliberately rather than scaled down. Below about 32px a
superscript T is three or four pixels and reads as dirt on the V; the rule
colour is what actually distinguishes the siblings at that size, and it holds
all the way down to 16px.

## Files

Paths, not text. A logo has to render identically everywhere, and text depends
on the face being installed. Regenerate with:

```bash
node scripts/build-brand.mjs
```

Edit the generator, never the SVGs — they are output.
