# Testing strategies without fooling yourself

The most likely way this project loses money is not a bug. It is testing
twenty variants, picking the best, and mistaking the winner of a search for a
discovery.

This document is about the limits of what can be established before real
money, and the tooling that keeps those limits visible.

## The statistical wall

To tell skill from luck you need roughly `t ≈ Sharpe × √years`, and you want
`t ≈ 2`.

| Strategy Sharpe | Years to prove it isn't luck |
|---|---|
| 0.3 (a decent retail strategy) | ~44 |
| 0.5 | ~16 |
| 1.0 (very good) | ~4 |
| 2.0 (institutional-grade) | ~1 |

Six months of daily decisions is about 125 observations. That has **almost no
power** to separate a good strategy from a lucky one. It is enough to prove
the plumbing works. It is not enough to prove the strategy works, and no
amount of care in the code changes that — it is a property of the noise in
the data.

`assessSignificance()` computes this and says so in words rather than leaving
you to remember it.

## Multiple comparisons

Test twenty variants at a 5% bar and roughly one clears it by chance. The
searching *is* the overfitting, and it happens across sessions rather than
inside any one run, which is why nothing in the code would otherwise notice.

`research.experiments` is the defence:

- every variant is registered **before** it runs, with a written hypothesis
- name, parameters, hypothesis and window are **immutable** once written
- an experiment can be completed **once** — a bad run cannot be re-rolled
- experiments cannot be deleted
- the number registered is fed into the significance bar

`currentSignificance()` re-judges a stored result against every trial
registered to date, not against however many existed when it finished. The
seventh of twelve was chosen as the best of twelve, and that is the number
that should determine how impressive winning was.

## The hold-out

`research.holdouts` seals a date range. `assertNotLocked()` refuses any
research window that overlaps it.

Unlocking requires a reason, records who did it, and is **one-way**. There is
no re-locking, because a period that has been looked at cannot honestly be
presented as fresh evidence later. The hold-out is spent after one use — that
is what makes it worth anything.

## What the backtester cannot do

It runs the same `Strategy` interface as the live runner, through the same
cost model as the paper broker. Sharing both is deliberate: separate copies
would eventually disagree, and the flattering number is the one that survives.

It still cannot account for:

- **market impact** — irrelevant at £1,000, real at £50,000
- **queue position, partial fills, rejections** — it assumes you get filled
- **splits, dividends, halts** — entirely unmodelled
- **survivorship bias** — that is a property of the data you feed it
- **stamp duty** — 0.5% on UK purchases, enormous for frequent trading

It does refuse look-ahead: a strategy never sees a bar that has not happened,
and misaligned series are rejected rather than silently shifted.

## The LLM problem

Training-cutoff contamination is fatal to backtesting an LLM agent. A model
asked what happens next for a date inside its training data has *read what
happened next*. Those backtests look excellent for exactly the wrong reason.

For an LLM agent, only genuinely future data is out-of-sample — which puts you
straight back at the statistical wall, from a standing start, with no history
to lean on.

LLMs are good at reading filings, summarising news, classifying sentiment and
enforcing a rule set. Anything shaped like "ask the model what will go up" is
a known dead end.

## What you *can* establish before real money

- attribution and reconciliation hold over real elapsed time
- halt and kill work under live-ish conditions
- the cost model is calibrated against real quotes
- the order lifecycle survives partial fills, rejections and reconnects
- the operational failure modes are known

None of that says the strategy makes money. It says that if it does, you will
be able to see it, and if it does not, you will find out before it is
expensive.

## Suggested workflow

```bash
npm run demo:research   # watch the whole thing happen on synthetic data
```

1. Seal a hold-out before looking at anything.
2. Register each variant before running it, with a hypothesis.
3. Search on the training window. Expect the winner to be partly luck.
4. Check `currentSignificance()`. It will almost always say "not
   distinguishable from luck". Believe it.
5. Commit to one rule. Unlock the hold-out once. Evaluate.
6. Paper trade forward — the only genuinely out-of-sample data is the future.

## Go-live criteria

Write these down **before** seeing results, or you will talk yourself into it
afterwards. Ours are not set yet. They should cover at least:

- months of clean daily reconciliation
- beating the benchmark after costs, out of sample
- a maximum drawdown you would actually tolerate
- the broker-side limits in place, not just the app-side ones
