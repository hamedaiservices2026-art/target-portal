// Admin › Target cycle (Operation): the columns of "Target by department" on
// the CD screen. Each Head of Department gets its channels (TT DMM, TT Outer,
// MT, MT SSV, MT Bulk, HoReCa, WS); the screen then shows them as
// TT DMM, TT Outer, Total TT, MT, MT SSV, MT Bulk, Total MT, HoReCa, WS, ABC.
// The channels can be ticked by hand or read from the department target file
// (Head names on the first row, channels on the "Pack" row).
import { useState } from 'preact/hooks';
import type { OrgDto } from '../../../worker/services/cycleData';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { readSheet } from '../../excel';
import { useLang } from '../../i18n';
import { deptColumns, fileHeads, matchHeads, orderedDeptCols, STANDARD_CHANNELS } from '../../cycle/deptOrder';
import { NO_CHANNEL } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';

type Draft = Record<string, string[]>;

const fromOrg = (org: OrgDto): Draft => Object.fromEntries(org.depts.map((d) => [String(d.id), d.channels.map((c) => c.channel)]));

export function DeptColumnsStep({ org, onSaved }: { org: OrgDto; onSaved: () => void }) {
  useLang();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [notMatched, setNotMatched] = useState<string[]>([]);
  const saved = fromOrg(org);
  const d = draft ?? saved;
  const done = org.depts.length > 0 && org.depts.every((x) => x.channels.length > 0);
  const extra = [...new Set(Object.values(d).flat())].filter((c) => !STANDARD_CHANNELS.some((s) => s.toLowerCase() === c.toLowerCase()));
  const all = [...STANDARD_CHANNELS, ...extra];
  const owner = (c: string) => Object.entries(d).find(([, list]) => list.some((x) => x.toLowerCase() === c.toLowerCase()))?.[0] ?? null;

  function toggle(dept: string, c: string, on: boolean) {
    const next: Draft = {};
    for (const [k, list] of Object.entries(d)) next[k] = list.filter((x) => x.toLowerCase() !== c.toLowerCase());
    if (on) next[dept] = [...(next[dept] ?? []), c];
    setDraft(next);
    setMsg(null);
  }

  async function readFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    setErr(null);
    setMsg(null);
    try {
      const heads = fileHeads(await readSheet(f));
      if (!heads.length) throw new Error(tc('dcNoHeads'));
      const m = matchHeads(heads, org.depts);
      const next: Draft = { ...d };
      // A channel belongs to one Head: take it from any other Head first.
      for (const x of m) if (x.deptId !== null) for (const k of Object.keys(next)) next[k] = next[k]!.filter((c) => !x.channels.some((y) => y.toLowerCase() === c.toLowerCase()));
      for (const x of m) if (x.deptId !== null) next[String(x.deptId)] = [...x.channels];
      setDraft(next);
      setNotMatched(m.filter((x) => x.deptId === null).map((x) => `${x.head} (${x.channels.join(', ')})`));
      setMsg(tc('dcRead', { n: m.filter((x) => x.deptId !== null).length }));
    } catch (x) {
      setErr(errText(x));
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const changed = org.depts.filter((x) => JSON.stringify(d[String(x.id)] ?? []) !== JSON.stringify(saved[String(x.id)] ?? []));
      // Clear first so a channel can move from one Head to another.
      for (const x of changed) await api('PUT', `/api/admin/departments/${x.id}/channels`, { channels: [] });
      for (const x of changed) {
        const list = d[String(x.id)] ?? [];
        if (list.length) await api('PUT', `/api/admin/departments/${x.id}/channels`, { channels: list.map((channel) => ({ channel, grp: x.code })) });
      }
      setDraft(null);
      setMsg(tc('dcSaved'));
      onSaved();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  const preview = deptColumns(
    orderedDeptCols(org.depts.map((x) => ({ ...x, channels: (d[String(x.id)] ?? []).map((channel) => ({ channel })) })), NO_CHANNEL),
    (name) => tc('totalOf', { name }),
  ).flat.map((x) => (x.kind === 'cell' ? (x.c === NO_CHANNEL ? x.d.name : x.c) : x.label));

  return (
    <div class={`cy-step${done ? ' done' : ''}`} data-testid="dept-columns">
      <div class="cy-step-head">
        <span class="cy-step-n">{done ? '✓' : '•'}</span>
        <div><b>{tc('dcTitle')}</b><p class="muted small">{tc('dcHelp')}</p></div>
      </div>
      <div class="cy-step-body">
        {!done && <div class="banner warn" data-testid="dc-missing">{tc('dcMissing')}</div>}
        <div class="tablewrap"><table class="ad-table cy-table">
          <thead><tr><th>{tc('head')}</th>{all.map((c) => <th key={c} class="num">{c}</th>)}</tr></thead>
          <tbody>{orderedDeptCols(org.depts.map((x) => ({ ...x, channels: (d[String(x.id)] ?? []).map((channel) => ({ channel })) })), NO_CHANNEL).map((x) => (
            <tr key={x.id}>
              <td><b>{x.name}</b></td>
              {all.map((c) => {
                const own = owner(c);
                return (
                  <td key={c} class="num">
                    <input type="checkbox" aria-label={`${x.name} ${c}`} checked={own === x.id} onChange={(e) => toggle(x.id, c, e.currentTarget.checked)} />
                  </td>
                );
              })}
            </tr>
          ))}</tbody>
        </table></div>
        <p class="small">{tc('dcOrder')}: <b data-testid="dc-order">{[...preview, 'ABC'].join(' · ')}</b></p>
        {notMatched.length > 0 && <div class="banner warn small">{tc('dcNotMatched', { list: notMatched.join('; ') })}</div>}
        <div class="toolbar">
          <label class="btn">{tc('dcReadFile')}<input type="file" accept=".xlsx,.xls" class="visually-hidden" data-testid="dc-file" onChange={readFile} /></label>
          <span class="spacer" />
          {draft && <button type="button" class="btn" onClick={() => { setDraft(null); setNotMatched([]); }}>{tc('undoAll')}</button>}
          <button type="button" class="btn primary" data-testid="dc-save" disabled={busy || !draft} onClick={() => void save()}>{tc('save')}</button>
        </div>
        {msg && <div class="banner ok" role="status">{msg}</div>}
        {err && <div class="alert" role="alert">{err}</div>}
      </div>
    </div>
  );
}
