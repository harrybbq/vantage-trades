/**
 * Performance metrics, and the statistics that say whether to believe them.
 *
 * The second half is the important half. A backtest that reports "+14%" and
 * stops there is worse than useless, because the number is real and the
 * conclusion is not. What matters is whether that result could easily have
 * come from luck — and with the sample sizes available to a personal project,
 * it very nearly always could.
 *
 * The rule of thumb underneath all of this: to tell skill from luck you need
 * roughly t = Sharpe x sqrt(years), and you want t of about 2. So a strategy
 * with a Sharpe of 0.5 needs about 16 years of data before its track record
 * means anything. Six months of daily decisions has essentially no power.
 */

const TRADING_DAYS = 252;

export interface Metrics {
  returnPct: number;
  annualisedReturnPct: number;
  /** Annualised. Null when there is not enough data to compute one. */
  sharpe: number | null;
  maxDrawdownPct: number;
  days: number;
  trades: number;
}

/** Equity points, oldest first, in minor units. */
export function computeMetrics(equity: readonly bigint[], trades: number): Metrics {
  const first = equity[0];
  const last = equity[equity.length - 1];

  if (first === undefined || last === undefined || first === 0n || equity.length < 2) {
    return {
      returnPct: 0,
      annualisedReturnPct: 0,
      sharpe: null,
      maxDrawdownPct: 0,
      days: equity.length,
      trades,
    };
  }

  const returnPct = Number(((last - first) * 10000n) / first) / 100;

  // Daily simple returns. Computed as floats, deliberately: these are
  // statistics about the equity curve, not money. Nothing here is ever
  // written back to the ledger.
  const daily: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const previous = equity[i - 1];
    const current = equity[i];
    if (previous === undefined || current === undefined || previous === 0n) continue;
    daily.push(Number(current - previous) / Number(previous));
  }

  const years = equity.length / TRADING_DAYS;
  const annualised = years > 0 ? (Math.pow(1 + returnPct / 100, 1 / years) - 1) * 100 : 0;

  let sharpe: number | null = null;
  if (daily.length > 1) {
    const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
    const variance = daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (daily.length - 1);
    const sd = Math.sqrt(variance);
    // Zero variance means the curve never moved. That is not an infinite
    // Sharpe, it is an absence of evidence.
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(TRADING_DAYS) : null;
  }

  let peak = first;
  let worst = 0;
  for (const point of equity) {
    if (point > peak) peak = point;
    if (peak > 0n) {
      const drawdown = Number(((peak - point) * 10000n) / peak) / 100;
      if (drawdown > worst) worst = drawdown;
    }
  }

  return {
    returnPct: Number(returnPct.toFixed(2)),
    annualisedReturnPct: Number(annualised.toFixed(2)),
    sharpe: sharpe === null ? null : Number(sharpe.toFixed(3)),
    maxDrawdownPct: Number(worst.toFixed(2)),
    days: equity.length,
    trades,
  };
}

/**
 * Inverse standard normal CDF (Acklam's approximation).
 *
 * Needed to work out how high the bar has to be once you account for how many
 * strategies were tried. Accurate to about 1e-9, which is far more than this
 * needs.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be between 0 and 1');

  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];

  const low = 0.02425;
  const high = 1 - low;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
           ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
            ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }

  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
         (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export interface Significance {
  /** Observed t-statistic for the Sharpe ratio. */
  tStat: number | null;
  /** The t it must clear, adjusted for how many strategies were tried. */
  requiredT: number;
  /** Number of registered experiments this is being judged against. */
  trials: number;
  significant: boolean;
  /** Years of data this Sharpe would need to clear the bar. */
  yearsNeeded: number | null;
  verdict: string;
}

/**
 * Is this result distinguishable from luck, given how many things were tried?
 *
 * The Bonferroni correction is crude and conservative, and that is the right
 * direction to be wrong in here. Testing twenty variants and judging the
 * winner at an uncorrected 5% means a one-in-three chance of anointing noise.
 */
export function assessSignificance(
  sharpe: number | null,
  days: number,
  trials: number,
  alpha = 0.05,
): Significance {
  const effectiveTrials = Math.max(1, trials);
  // Two-sided, split across the number of things tried.
  const requiredT = normalQuantile(1 - alpha / (2 * effectiveTrials));

  if (sharpe === null || days < 2) {
    return {
      tStat: null,
      requiredT: Number(requiredT.toFixed(2)),
      trials: effectiveTrials,
      significant: false,
      yearsNeeded: null,
      verdict: 'Not enough data to say anything at all.',
    };
  }

  const years = days / TRADING_DAYS;
  const tStat = sharpe * Math.sqrt(years);
  const significant = tStat >= requiredT;
  const yearsNeeded = sharpe > 0 ? (requiredT / sharpe) ** 2 : null;

  const verdict = significant
    ? `Clears the bar (t ${tStat.toFixed(2)} >= ${requiredT.toFixed(2)} after ${effectiveTrials} trial(s)). ` +
      'Still one path through one market. Confirm forward, out of sample, before believing it.'
    : sharpe <= 0
      ? `Sharpe is ${sharpe.toFixed(2)}. There is nothing here to test for significance.`
      : `Not distinguishable from luck: t ${tStat.toFixed(2)} against a bar of ${requiredT.toFixed(2)} ` +
        `for ${effectiveTrials} trial(s). At this Sharpe you would need about ` +
        `${yearsNeeded === null ? '?' : yearsNeeded.toFixed(1)} years of data, and you have ` +
        `${years.toFixed(2)}.`;

  return {
    tStat: Number(tStat.toFixed(3)),
    requiredT: Number(requiredT.toFixed(2)),
    trials: effectiveTrials,
    significant,
    yearsNeeded: yearsNeeded === null ? null : Number(yearsNeeded.toFixed(1)),
    verdict,
  };
}
