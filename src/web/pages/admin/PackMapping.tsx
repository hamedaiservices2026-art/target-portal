// Admin › Packs: the pack mapping (Sales Target Category -> Pacage sub category).
// Kept with the packs, apart from the target cycle steps.
import { useState } from 'preact/hooks';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { readSheet } from '../../excel';
import { useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { getOrg } from '../../cycle/load';
import * as T from '../../cycle/templates';
import { packIndex, parsePackMapping, type Check } from '../../cycle/parsers';
import { Checks } from '../../cycle/ui';

export function PackMappingCard({ onSaved }: { onSaved: () => void }) {
  useLang();
  const [checks, setChecks] = useState<Check[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function template() {
    setErr(null);
    try { await T.packMapping(await getOrg('ops')); } catch (x) { setErr(errText(x)); }
  }
  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    setErr(null); setMsg(null); setChecks([]);
    setBusy(true);
    try {
      const org = await getOrg('ops');
      const r = parsePackMapping(await readSheet(f), packIndex(org.packs.map((p) => p.code)));
      setChecks(r.checks);
      if (r.checks.some((c) => c.level === 'error')) return;
      const out = await api<{ updated: number }>('PUT', '/api/admin/packs-sub', { map: r.map });
      setMsg(tc('mappingSaved', { n: out.updated }));
      onSaved();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="card ad-card" data-testid="pack-mapping">
      <h2>{tc('stepMapping')}</h2>
      <p class="small muted">{tc('stepMappingHelp')}</p>
      <div class="actions">
        <button type="button" class="btn" onClick={() => void template()}>{tc('pmTemplate')}</button>
        <span class="filepick">
          <input id="pm-file" type="file" class="visually-hidden" accept=".xlsx,.xls" disabled={busy} onChange={onFile} data-testid="pm-file" />
          <label for="pm-file" class="btn primary">{tc('pmChoose')}</label>
        </span>
      </div>
      <Checks checks={checks} />
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}
