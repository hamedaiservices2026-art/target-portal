// Admin: packs. Group is one of exactly three; changes save as soon as a control changes.
import { useState } from 'preact/hooks';
import type { PackDto } from '../../../worker/services/masters';
import { api } from '../../api';
import { ConfirmButton, errText, Field, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { tc } from '../../cycle/i18n';
import { ImportPanel } from '../../components/ImportPanel';
import { PackMappingCard } from './PackMapping';
import { t, useLang } from '../../i18n';

export const PACK_GROUPS = ['CSD', 'Water', 'LRB-Others'] as const;

function GroupOptions() {
  return <>{PACK_GROUPS.map((g) => <option value={g}>{g}</option>)}</>;
}

function PackRow({ p, added, onChanged, onError }: { p: PackDto; added: boolean; onChanged: () => void; onError: (m: string) => void }) {
  useLang();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.code);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (x) {
      onError(errText(x));
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  const patch = (body: Partial<Pick<PackDto, 'grp' | 'active'>>) => run(() => api('PATCH', `/api/admin/packs/${encodeURIComponent(p.code)}`, body));
  const rename = () => {
    const to = name.trim();
    if (!to || to === p.code) return setEditing(false);
    void run(() => api('POST', `/api/admin/packs/${encodeURIComponent(p.code)}/rename`, { code: to })).then(() => setEditing(false));
  };

  return (
    <tr data-testid="pack-row" class={p.active ? '' : 'off'}>
      <td class="s">
        {editing
          ? <input value={name} aria-label={`${tc('pkNewName')} ${p.code}`} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') rename(); }} />
          : <b>{p.code}</b>}
      </td>
      <td class="s">
        <select aria-label={t('adGroup')} value={p.grp} disabled={busy} onChange={(e) => patch({ grp: e.currentTarget.value as PackDto['grp'] })}>
          <GroupOptions />
        </select>
      </td>
      <td class="s">
        <label class="check">
          <input type="checkbox" checked={p.active} disabled={busy} onChange={(e) => patch({ active: e.currentTarget.checked })} />
          {p.active ? t('adActive') : t('adInactive')}
        </label>
      </td>
      <td class="s">
        {added && (editing ? (
          <>
            <button type="button" class="btn primary" disabled={busy} onClick={rename}>{tc('save')}</button>{' '}
            <button type="button" class="btn" onClick={() => { setEditing(false); setName(p.code); }}>{tc('cancel')}</button>
          </>
        ) : (
          <>
            <button type="button" class="btn" data-testid="pack-edit" disabled={busy} onClick={() => setEditing(true)}>{tc('pkEdit')}</button>{' '}
            <ConfirmButton label={tc('pkRemove')} question={tc('pkRemoveQ', { code: p.code })} yesLabel={tc('pkRemove')} testId="pack-remove"
              onConfirm={() => run(() => api('DELETE', `/api/admin/packs/${encodeURIComponent(p.code)}`))} />
          </>
        ))}
      </td>
    </tr>
  );
}

export function Packs() {
  useLang();
  const res = useResource<{ packs: PackDto[] }>('/api/admin/packs');
  const addedRes = useResource<{ packs: string[] }>('/api/admin/packs-added');
  const [code, setCode] = useState('');
  const [grp, setGrp] = useState<PackDto['grp']>('CSD');
  const [sort, setSort] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);

  async function add(e: Event) {
    e.preventDefault();
    if (!code.trim()) return setErr(t('adPackErrCode'));
    const nextSort = Math.max(0, ...(res.data?.packs ?? []).map((p) => p.sort)) + 1;
    if (!Number.isInteger(nextSort)) return setErr(t('adPackErrSort'));
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/api/admin/packs', { code: code.trim(), grp, sort: nextSort });
      setCode('');
      setSort('');
      setFlash(t('adPackCreated'));
      res.reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="admin-packs">
      <PageHead title={t('navPacks')} intro={t('adPacksIntro')}>
        <button type="button" class="btn" aria-expanded={importing} onClick={() => setImporting(!importing)}>
          {importing ? t('imClose') : t('imOpen')}
        </button>
      </PageHead>
      {importing && <ImportPanel kind="packs" onApplied={res.reload} />}
      <PackMappingCard onSaved={res.reload} />
      <form class="card ad-form" onSubmit={add} noValidate>
        <h2>{t('adPackAdd')}</h2>
        <div class="grid">
          <Field id="p-code" label={t('adPackCode')} hint={t('adPackCodeHint')}>
            <input id="p-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
          </Field>
          <Field id="p-grp" label={t('adGroup')}>
            <select id="p-grp" data-testid="new-pack-group" value={grp} onChange={(e) => setGrp(e.currentTarget.value as PackDto['grp'])}>
              <GroupOptions />
            </select>
          </Field>
        </div>
        {err && <div class="alert" role="alert">{err}</div>}
        <div class="actions"><button type="submit" class="btn primary" disabled={busy}>{t('adPackAddBtn')}</button></div>
      </form>
      {flash && <div class="banner ok" role="status">{flash}</div>}
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {!res.data && !res.error && <p class="muted">{t('loading')}</p>}
      {res.data && (
        <>
          <p class="muted">{t('adPacksNote')}</p>
          <div class="tablewrap">
            <table class="ad-table">
              <thead>
                <tr><th class="s">{t('adPackCode')}</th><th class="s">{t('adGroup')}</th><th class="s">{t('adStatus')}</th><th class="s" /></tr>
              </thead>
              <tbody>
                {res.data.packs.length === 0 && <tr><td class="empty" colSpan={4}>{t('adPackEmpty')}</td></tr>}
                {res.data.packs.map((p) => (
                  <PackRow key={`${p.code}-${p.grp}-${p.active}`} p={p} added={(addedRes.data?.packs ?? []).includes(p.code)} onChanged={() => { res.reload(); addedRes.reload(); }} onError={setErr} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
