// Admin: settings. Only the cap % for now.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api';
import { errText, Field, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { t, useLang } from '../../i18n';

/** A decimal number written with Western or Arabic-Indic digits and either decimal mark; NaN when unreadable. */
export function parseCap(raw: string): number {
  const s = raw.trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.');
  return /^\d+(\.\d+)?$|^\.\d+$/.test(s) ? Number(s) : NaN;
}

export function Settings() {
  useLang();
  const res = useResource<{ capPct: number }>('/api/admin/settings');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (res.data) setText(String(res.data.capPct));
  }, [res.data]);

  const value = parseCap(text);
  const valid = Number.isFinite(value) && value > 0 && value <= 100;
  const unchanged = res.data !== null && valid && value === res.data.capPct;

  async function save(e: Event) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const out = await api<{ capPct: number }>('PUT', '/api/admin/settings', { capPct: value });
      res.setData(out);
      setText(String(out.capPct));
      setSaved(true);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="admin-settings">
      <PageHead title={t('navSettings')} />
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {!res.data && !res.error && <p class="muted">{t('loading')}</p>}
      {res.data && (
        <form class="card ad-form narrow" onSubmit={save} noValidate>
          <h2>{t('adCapTitle')}</h2>
          <p>{t('adCapExplain')}</p>
          <p class="muted">{t('adCapExample')}</p>
          <Field id="s-cap" label={t('adCapLabel')} hint={t('adCapHint')}>
            <input
              id="s-cap" inputMode="decimal" value={text} aria-invalid={!valid}
              onInput={(e) => { setText(e.currentTarget.value); setSaved(false); }}
            />
          </Field>
          {!valid && <div class="alert" role="alert">{t('adCapInvalid')}</div>}
          {err && <div class="alert" role="alert">{err}</div>}
          {saved && <div class="banner ok" role="status" data-testid="settings-saved">{t('adCapSaved')}</div>}
          <p class="muted small">{t('adCapApplies')}</p>
          <div class="actions">
            <button type="submit" class="btn primary" disabled={!valid || busy || unchanged}>{t('adCapSave')}</button>
          </div>
        </form>
      )}
    </section>
  );
}
