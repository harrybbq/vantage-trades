import { useState } from 'react';
import { signIn } from '../lib/auth';
import { Mark } from './Mark';

/**
 * Sign in with the same account you use for Vantage.
 *
 * Deliberately says nothing about who the owner is. Signing in successfully
 * as anyone else produces a valid session and then a 401 from the API, which
 * is the correct outcome — the server decides, not this screen.
 */
export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      // No navigation: the auth listener swaps this screen out.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not sign in');
      setBusy(false);
    }
  };

  return (
    <div className="signin-page">
      <form className="signin-card" onSubmit={(e) => void submit(e)}>
        <div className="signin-head">
          <Mark size={56} />
          <span className="label">Digital factory</span>
          <h1>Agent control</h1>
          <p className="hint">Sign in with your Vantage account.</p>
        </div>

        {error && (
          <div className="banner-error">
            <span>{error}</span>
          </div>
        )}

        <label className="field">
          <span className="label">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span className="label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button className="btn-primary" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="hint">
          This panel can move capital between agents and liquidate positions. Access is checked on
          the server for every request.
        </p>
      </form>
    </div>
  );
}
