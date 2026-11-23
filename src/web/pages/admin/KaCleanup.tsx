// Admin › Hierarchy › Operation: take out a Key Account file that was uploaded
// on the Operation hierarchy (its KAMs, KAEs and KAE IDs under Operation Heads).
import { useState } from 'preact/hooks';
import type { KaCleanup as Plan } from '../../../worker/services/hierarchySync';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { readSheet } from '../../excel';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { parseHierarchySheet, type HierarchyRow } from '../../cycle/hierarchyFile';

export function KaCleanup({ onDone }: { onDone: () => void }) {
  useLang();
  const [rows, setRows] = useState<HierarchyRow[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    setErr(null); setMsg(null); setPlan(null);
    try {
      const parsed = parseHierarchySheet(await readSheet(f));
      if (parsed.error || !parsed.ka) throw new Error(tc('hsNotKaFile'));
      setBusy(true);
      setPlan(await api<Plan>('POST', '/api/admin/hierarchy/remove-ka-from-ops', { rows: parsed.rows, apply: false }));
      setRows(parsed.rows);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!rows) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<Plan>('POST', '/api/admin/hierarchy/remove-ka-from-ops', { rows, apply: true });
      setMsg(tc('kcDone', { nodes: fmtNum(r.nodes.length), routes: fmtNum(r.leaves.length) }));
      setPlan(null); setRows(null);
      onDone();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  const found = plan ? plan.nodes.length + plan.leaves.length : 0;
  return (
    <details class="card ad-card" data-testid="ka-cleanup">
      <summary><b>{tc('kcTitle')}</b></summary>
      <p class="small muted">{tc('kcHelp')}</p>
      <span class="filepick">
        <input id="kc-file" type="file" class="visually-hidden" data-testid="kc-file" accept=".xlsx" disabled={busy} onChange={onFile} />
        <label for="kc-file" class="btn">{tc('kcChoose')}</label>
      </span>
      {plan && (
        <>
          <p data-testid="kc-found">{found ? tc('kcFound', { nodes: fmtNum(plan.nodes.length), routes: fmtNum(plan.leaves.length) }) : tc('kcNone')}</p>
          {found > 0 && (
            <div class="tablewrap" style={{ maxHeight: '260px' }}><table class="ad-table">
              <thead><tr><th>{tc('ppName')}</th><th>{tc('ppHead')}</th></tr></thead>
              <tbody>
                {plan.nodes.map((n) => <tr key={`n${n.id}`}><td>{n.name}</td><td>{n.dept}</td></tr>)}
                {plan.leaves.map((l) => <tr key={`l${l.id}`}><td>{l.route} · {l.node}</td><td>{l.dept}</td></tr>)}
              </tbody>
            </table></div>
          )}
          {plan.kept.length > 0 && <p class="small muted">{tc('kcKept', { list: plan.kept.join(', ') })}</p>}
          {found > 0 && <div class="actions"><button type="button" class="btn danger" data-testid="kc-remove" disabled={busy} onClick={() => void remove()}>{tc('kcRemove')}</button></div>}
        </>
      )}
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
    </details>
  );
}
