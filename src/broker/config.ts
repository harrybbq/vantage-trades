/**
 * Which broker this deployment is talking to.
 *
 * Paper unless something says otherwise, because `CLAUDE.md` puts live money
 * last and a default that has to be remembered is not a default. Setting
 * `BROKER` to anything other than `paper` means a real account, and the
 * simulator is left alone from then on.
 *
 * The one thing this decides today is whether recording a bank transfer also
 * credits the simulated account. Against a real broker it must not: the money
 * genuinely moved at the bank and the broker already knows. Against the paper
 * broker it must, because otherwise nothing outside this app ever tells the
 * simulator the cash arrived, and reconciliation reports a divergence equal to
 * every deposit ever made.
 */

export type BrokerKind = 'paper' | 'live';

export function brokerKind(): BrokerKind {
  return process.env['BROKER']?.trim().toLowerCase() === 'live' ? 'live' : 'paper';
}

export const usingPaperBroker = (): boolean => brokerKind() === 'paper';
