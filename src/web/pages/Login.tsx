import { useLocation } from 'preact-iso';
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import { LangToggle } from '../components/LangToggle';
import { t, useLang, type TextKey } from '../i18n';
import { login } from '../session';

/** Only same-site paths are followed after login. */
export function safeNext(raw: string | undefined): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login') ? raw : '/';
}

function errorKey(e: unknown): TextKey {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'errInvalidCredentials';
    if (e.status === 429) return 'errTooManyAttempts';
    return 'errGeneric';
  }
  return 'errNetwork';
}

export function Login() {
  useLang(); // re-render (labels, the error message) when the language changes
  const { query, route } = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Kept as a key, not text, so the message follows the language toggle.
  const [error, setError] = useState<TextKey | null>(null);

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      route(safeNext(query.next), true);
    } catch (err) {
      setError(errorKey(err));
      setBusy(false);
    }
  }

  return (
    <div class="login-wrap">
      <div class="login-top">
        <span class="logo">{t('appName')}</span>
        <LangToggle />
      </div>
      <form class="card login-card" onSubmit={onSubmit} noValidate>
        <h1>{t('loginTitle')}</h1>
        <p class="muted">{t('loginIntro')}</p>
        <label for="username">{t('loginName')}</label>
        <input
          id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck={false}
          required value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
        />
        <label for="password">{t('password')}</label>
        <input
          id="password" name="password" type="password" autocomplete="current-password"
          required value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        />
        {error && <div class="alert" role="alert" data-testid="login-error">{t(error)}</div>}
        <button type="submit" class="btn primary" disabled={busy || !username || !password}>
          {busy ? t('signingIn') : t('signIn')}
        </button>
      </form>
    </div>
  );
}
