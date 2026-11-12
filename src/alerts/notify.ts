/**
 * Telling the owner something went wrong, without them having to look.
 *
 * The panel shows everything, but only to someone who opens it. A system
 * meant to run unattended needs the opposite: silence while things are fine
 * and a message the day they are not — a failed check, an agent that halted
 * itself, a price that stopped arriving.
 *
 * Two channels, whichever is configured (push wins if both are):
 *
 *   ALERT_NTFY_TOPIC            a push notification through ntfy.sh. No
 *                               account; the phone app subscribes to the same
 *                               topic. The topic name is the only secret, so
 *                               a short or guessable one is refused.
 *   RESEND_API_KEY, ALERT_EMAIL an email through Resend.
 *
 * Alerts go through a third party in plain text, so they say what happened and
 * which agent, and the weekly summary says how much — the owner's choice to
 * make by configuring a channel at all. Nothing here ever includes a
 * credential.
 *
 * `notify` never throws. A job that fails because its alarm failed has two
 * problems and reports neither.
 */

export interface Alert {
  /** Plain ASCII: it travels in an HTTP header on the push channel. */
  title: string;
  body: string;
  urgent?: boolean;
}

export type NotifyResult = 'sent' | 'unconfigured' | 'failed';

const TOPIC = /^[A-Za-z0-9_-]{20,64}$/;

export function alertChannel(env: NodeJS.ProcessEnv = process.env): 'push' | 'email' | null {
  if (env['ALERT_NTFY_TOPIC']?.trim()) return 'push';
  if (env['RESEND_API_KEY']?.trim() && env['ALERT_EMAIL']?.trim()) return 'email';
  return null;
}

const ascii = (text: string) => text.replace(/[^\x20-\x7E]/g, '').slice(0, 120);

export async function notify(
  alert: Alert,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const channel = alertChannel(env);
  if (channel === null) {
    console.log(`alert not sent (no channel configured): ${alert.title}`);
    return 'unconfigured';
  }

  try {
    let response: Response;
    if (channel === 'push') {
      const topic = env['ALERT_NTFY_TOPIC']!.trim();
      if (!TOPIC.test(topic)) {
        // Anyone who guesses a topic can read what is sent to it.
        console.error('ALERT_NTFY_TOPIC must be 20-64 letters, digits, - or _; alert not sent');
        return 'failed';
      }
      response = await fetchImpl(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: {
          Title: ascii(alert.title),
          Priority: alert.urgent ? 'high' : 'default',
          Tags: alert.urgent ? 'warning' : 'chart_with_upwards_trend',
        },
        body: alert.body,
        signal: AbortSignal.timeout(8_000),
      });
    } else {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env['RESEND_API_KEY']!.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env['ALERT_FROM']?.trim() || 'Vantage Trades <onboarding@resend.dev>',
          to: [env['ALERT_EMAIL']!.trim()],
          subject: alert.title,
          text: alert.body,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    }

    if (!response.ok) {
      console.error(`alert not delivered: the ${channel} service answered ${response.status}`);
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    console.error(`alert not delivered: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}
