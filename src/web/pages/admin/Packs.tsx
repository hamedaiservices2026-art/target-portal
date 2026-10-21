// Admin: packs. Group is one of exactly three; changes save as soon as a control changes.
import { useState } from 'preact/hooks';
import type { PackDto } from '../../../worker/services/masters';
import { api } from '../../api';
import { errText, Field, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { t, useLang } from '../../i18n';

export const PACK_GROUPS = ['CSD', 'Water', 'LRB-Others'] as const;

function GroupOptions() {
  return <>{PACK_GROUPS.map((g) => <option value={g}>{g}</option>)}</>;
}

function PackRow({ p, onChanged, onError }: { p: PackDto; onChanged: () => void; onError: (m: string) => void }) {
  useLang();
  const [sort, setSort] = useState(String(p.sort));
  const [busy, setBusy] = useState(false);

  async function patch(body: Partial<Pick<PackDto, 'grp' | 'active' | 'sort'>>) {
    setBusy(true);
    try {
      await api('PATCH', `/api/admin/packs/${encodeURIComponent(p.code)}`, body);
      onChanged();
    } catch (x) {
      onError(errText(x));
      setSort(String(p.sort));
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  const commitSort = () => {
    const n = Number(sort);
    if (!Number.isInteger(n)) return setSort(String(p.sort));
    if (n !== p.sort) void patch({ sort: n });
  };

  return (
    <tr data-testid="pack-row" class={p.active ? '' : 'off'}>
      <td class="s"><b>{p.code}</b></td>
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
        <input
          class="f num" type="number" step="1" aria-label={`${t('adSortOrder')} ${p.code}`} value={sort} disabled={busy}
          onInput={(e) => setSort(e.currentTarget.value)} onBlur={commitSort}
          onKeyDown={(e) => { if (e.key === 'Enter') commitSort(); }}
        />
      </td>
    </tr>
  );
}

export function Packs() {
  useLang();
  const res = useResource<{ packs: PackDto[] }>('/api/admin/packs');
  const [code, setCode] = useState('');
  const [grp, setGrp] = useState<PackDto['grp']>('CSD');
  const [sort, setSort] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e: Event) {
    e.preventDefault();
    if (!code.trim()) return setErr(t('adPackErrCode'));
    const nextSort = sort.trim() === '' ? Math.max(0, ...(res.data?.packs ?? []).map((p) => p.sort)) + 1 : Number(sort);
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
      <PageHead title={t('navPacks')} intro={t('adPacksIntro')} />
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
          <Field id="p-sort" label={t('adSortOrder')} hint={t('adSortHint')}>
            <input id="p-sort" type="number" step="1" value={sort} onInput={(e) => setSort(e.currentTarget.value)} />
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
                <tr><th class="s">{t('adPackCode')}</th><th class="s">{t('adGroup')}</th><th class="s">{t('adStatus')}</th><th class="s">{t('adSortOrder')}</th></tr>
              </thead>
              <tbody>
                {res.data.packs.length === 0 && <tr><td class="empty" colSpan={4}>{t('adPackEmpty')}</td></tr>}
                {res.data.packs.map((p) => (
                  <PackRow key={`${p.code}-${p.grp}-${p.active}-${p.sort}`} p={p} onChanged={res.reload} onError={setErr} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
