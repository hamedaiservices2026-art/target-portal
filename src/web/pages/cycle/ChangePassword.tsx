// First sign-in: the person must choose their own password before anything else.
import { useState } from 'preact/hooks';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { loadSession } from '../../session';

export function ChangePassword() {
  useLang();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mismatch = pw2 !== '' && pw !== pw2;
  async function submit(e: Event) {
    e.preventDefault();
    if (pw.length < 8 || pw !== pw2) return;
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/api/me/password', { password: pw });
      await loadSession();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="card narrow" data-testid="change-password">
      <h1>{tc('pwTitle')}</h1>
      <p class="muted">{tc('pwIntro')}</p>
      <form onSubmit={submit}>
        <label class="field"><span>{tc('pwNew')}</span>
          <input type="password" autocomplete="new-password" value={pw} minLength={8} onInput={(e) => setPw(e.currentTarget.value)} /></label>
        <label class="field"><span>{tc('pwAgain')}</span>
          <input type="password" autocomplete="new-password" value={pw2} onInput={(e) => setPw2(e.currentTarget.value)} /></label>
        {mismatch && <p class="small bad-text">{tc('pwMismatch')}</p>}
        <p class="small muted">{tc('pwRule')}</p>
        {err && <div class="alert" role="alert">{err}</div>}
        <button type="submit" class="btn primary" disabled={busy || pw.length < 8 || pw !== pw2}>{tc('pwSave')}</button>
      </form>
    </section>
  );
}
