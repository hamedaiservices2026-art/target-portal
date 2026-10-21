// Admin: departments (a short code and a name). The tree of each department is built on the Hierarchy screen.
import { useState } from 'preact/hooks';
import type { DepartmentDto } from '../../../worker/services/masters';
import { api } from '../../api';
import { errText, Field, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { t, useLang } from '../../i18n';

function Row({ d, onSaved }: { d: DepartmentDto; onSaved: (msg: string) => void }) {
  useLang();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(d.code);
  const [name, setName] = useState(d.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: Event) {
    e.preventDefault();
    if (!code.trim() || !name.trim()) return setErr(t('adDeptErrEmpty'));
    setBusy(true);
    setErr(null);
    try {
      await api('PATCH', `/api/admin/departments/${d.id}`, { code: code.trim(), name: name.trim() });
      setEditing(false);
      onSaved(t('adSaved'));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <tr data-testid="dept-row">
        <td class="s"><b>{d.code}</b></td>
        <td class="s">{d.name}</td>
        <td class="s act">
          <button type="button" class="btn" onClick={() => setEditing(true)}>{t('adEdit')}</button>
          <a class="btn" href={`/admin/hierarchy?dept=${d.id}`}>{t('adOpenTree')}</a>
        </td>
      </tr>
    );
  }
  return (
    <tr data-testid="dept-row">
      <td colSpan={3} class="s">
        <form class="inline-form" onSubmit={save}>
          <label for={`dc-${d.id}`}>{t('adCode')}</label>
          <input id={`dc-${d.id}`} value={code} onInput={(e) => setCode(e.currentTarget.value)} />
          <label for={`dn-${d.id}`}>{t('adName')}</label>
          <input id={`dn-${d.id}`} value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <button type="submit" class="btn primary" disabled={busy}>{t('adSave')}</button>
          <button type="button" class="btn" onClick={() => { setEditing(false); setCode(d.code); setName(d.name); setErr(null); }}>{t('dsCancel')}</button>
          {err && <div class="alert" role="alert">{err}</div>}
        </form>
      </td>
    </tr>
  );
}

export function Departments() {
  useLang();
  const res = useResource<{ departments: DepartmentDto[] }>('/api/admin/departments');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e: Event) {
    e.preventDefault();
    if (!code.trim() || !name.trim()) return setErr(t('adDeptErrEmpty'));
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/api/admin/departments', { code: code.trim(), name: name.trim() });
      setCode('');
      setName('');
      setFlash(t('adDeptCreated'));
      res.reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="admin-departments">
      <PageHead title={t('navDepartments')} intro={t('adDeptsIntro')} />
      <form class="card ad-form" onSubmit={add} noValidate>
        <h2>{t('adDeptAdd')}</h2>
        <div class="grid">
          <Field id="d-code" label={t('adCode')} hint={t('adDeptCodeHint')}>
            <input id="d-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
          </Field>
          <Field id="d-name" label={t('adName')}>
            <input id="d-name" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </Field>
        </div>
        {err && <div class="alert" role="alert">{err}</div>}
        <div class="actions">
          <button type="submit" class="btn primary" disabled={busy}>{t('adDeptAddBtn')}</button>
        </div>
      </form>
      {flash && <div class="banner ok" role="status">{flash}</div>}
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {!res.data && !res.error && <p class="muted">{t('loading')}</p>}
      {res.data && (
        <div class="tablewrap">
          <table class="ad-table">
            <thead><tr><th class="s">{t('adCode')}</th><th class="s">{t('adName')}</th><th class="s">{t('adActions')}</th></tr></thead>
            <tbody>
              {res.data.departments.length === 0 && <tr><td class="empty" colSpan={3}>{t('adDeptEmpty')}</td></tr>}
              {res.data.departments.map((d) => (
                <Row key={`${d.id}-${d.code}-${d.name}`} d={d} onSaved={(m) => { setFlash(m); res.reload(); }} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
