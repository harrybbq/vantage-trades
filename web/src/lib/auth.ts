/**
 * Sign-in, using the same Supabase project Vantage uses.
 *
 * Two things that look like secrets here and are not: the project URL and the
 * anon key. The anon key is designed to be public — it identifies the project
 * and nothing more, and every real permission decision is made server-side
 * against the caller's own token. That is why these two, and only these two,
 * are allowed a `VITE_` prefix.
 *
 * Nothing else may ever carry that prefix. The database URL, the broker
 * credentials and the report token are server-side only; `VITE_` would bundle
 * them into JavaScript anyone can read.
 *
 * The signed-in session proves who you are. It does not prove you are allowed
 * here — the server compares your user id against OWNER_USER_ID on every
 * request. Signing in as somebody else gets you a valid session and a 401.
 */

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

/**
 * Auth is configured only when both are present.
 *
 * When they are absent the app is running against the local dev API, which has
 * its own explicit bypass, so there is nothing to sign in to. This is a
 * build-time constant rather than a runtime check: a deployed build always has
 * them, and a local one never does.
 */
export const authConfigured = Boolean(url && anonKey);

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  if (!authConfigured) {
    throw new Error('Supabase is not configured in this build');
  }
  client ??= createClient(url!, anonKey!, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}

export async function currentSession(): Promise<Session | null> {
  if (!authConfigured) return null;
  const { data } = await supabase().auth.getSession();
  return data.session;
}

export function onAuthChange(handler: (session: Session | null) => void): () => void {
  if (!authConfigured) return () => undefined;
  const { data } = supabase().auth.onAuthStateChange((_event, session) => handler(session));
  return () => data.subscription.unsubscribe();
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  if (!authConfigured) return;
  await supabase().auth.signOut();
}

/**
 * The bearer token for API calls, or undefined when running locally.
 *
 * Read fresh on every request rather than cached: the client refreshes tokens
 * in the background, and a cached one goes stale mid-session and produces a
 * 401 that looks like a permissions problem.
 */
export async function accessToken(): Promise<string | undefined> {
  const session = await currentSession();
  return session?.access_token;
}
