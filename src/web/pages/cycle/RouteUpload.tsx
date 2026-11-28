// Admin › Target calculator, "Upload the target" source: instead of the
// system calculation, the admin uploads the target already distributed on the
// routes (Operation, MTFL file) or on the KAEs (Key Accounts, MDD file). The
// file is checked against the hierarchy and, for Operation, against the
// department target, then applied the same way as the calculation.
import { useState } from 'preact/hooks';
import { CATEGORIES } from '../../../shared/calc/packs';
import type { Workspace } from '../../../worker/auth';
import type { OrgDto } from '../../../worker/services/cycleData';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { readSheet } from '../../excel';
import { fmtNum, useLang } from '../../i18n';
import { useSession } from '../../session';
import { catMap, inPackOrder, sumCat, total, type Grid } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { packIndex, parseRouteTarget, type Check, type RouteTargetFile } from '../../cycle/parsers';
import { writeTargetFile, type TargetLine } from '../../cycle/targetFiles';
import { Checks, Section } from '../../cycle/ui';

export type Source = 'system' | 'upload';

/** The "system calculation or upload" choice shown at the top of both calculators. */
export function SourcePicker({ ws, value, onChange }: { ws: Workspace; value: Source; onChange: (s: Source) => void }) {
  useLang();
  return (
    <Section title={tc('srcTitle')}>
      <div class="toolbar" role="radiogroup" aria-label={tc('srcTitle')} data-testid="target-source">
        <label class="small"><input type="radio" name="tsrc" checked={value === 'system'} data-testid="src-system" onChange={() => onChange('system')} /> {tc('srcSystem')}</label>
        <label class="small"><input type="radio" name="tsrc" checked={value === 'upload'} data-testid="src-upload" onChange={() => onChange('upload')} /> {ws === 'ka' ? tc('srcUploadKa') : tc('srcUploadOps')}</label>
      </div>
      <p class="muted small">{value === 'system' ? tc('srcSystemHelp') : ws === 'ka' ? tc('srcUploadKaHelp') : tc('srcUploadOpsHelp')}</p>
    </Section>
  );
}

type Parsed = { name: string; file: RouteTargetFile; byDept: Record<string, Record<string, Grid>>; checks: Check[] };

export function RouteUpload({ ws, period, org, deptTarget, reload }: {
  ws: Workspace; period: string; org: OrgDto; deptTarget: Record<string, Grid> | null; reload: () => void;
}) {
  useLang();
  const me = useSession().user;
  const cats = catMap(org);
  const [p, setP] = useState<Parsed | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const kind = ws === 'ka' ? 'mdd' : 'mtfl';
  const deptName = (id: string) => org.depts.find((d) => String(d.id) === id)?.name ?? id;

  async function pick(f: File | undefined) {
    setErr(null);
    setMsg(null);
    setP(null);
    if (!f) return;
    try {
      const file = parseRouteTarget(await readSheet(f), period, packIndex(org.packs.map((x) => x.code)));
      const leafOf = new Map(org.leaves.map((x) => [x.routeCode, x]));
      const byDept: Record<string, Record<string, Grid>> = {};
      const unknown: string[] = [];
      for (const [code, g] of Object.entries(file.byLeaf)) {
        const leaf = leafOf.get(code);
        if (!leaf) { if (total(g) > 0) unknown.push(code); continue; }
        (byDept[String(leaf.deptId)] ??= {})[code] = g;
      }
      const checks: Check[] = [...file.checks];
      if (unknown.length) checks.push({ level: 'warning', text: tc('upUnknown', { n: unknown.length, list: unknown.slice(0, 15).join(', ') }) });
      for (const [d, routes] of Object.entries(byDept)) {
        const missing = org.leaves.filter((x) => String(x.deptId) === d && !(x.routeCode in routes)).length;
        if (missing) checks.push({ level: 'info', text: tc('upNoRows', { dept: deptName(d), n: missing }) });
        if (!deptTarget) continue;
        const t = deptTarget[d];
        if (!t) { checks.push({ level: 'error', text: tc('upNoDept', { dept: deptName(d) }) }); continue; }
        const sums: Grid = {};
        for (const g of Object.values(routes)) for (const [k, n] of Object.entries(g)) sums[k] = (sums[k] ?? 0) + n;
        const over = Object.keys(sums).filter((k) => (sums[k] ?? 0) > (t[k] ?? 0));
        if (over.length) checks.push({ level: 'error', text: tc('upOver', { dept: deptName(d), list: over.slice(0, 12).map((k) => `${k} ${fmtNum(sums[k]!)} / ${fmtNum(t[k] ?? 0)}`).join(', ') }) });
      }
      const nRoutes = Object.values(byDept).reduce((s, r) => s + Object.keys(r).length, 0);
      checks.push({ level: 'info', text: tc('upFound', { n: nRoutes, d: Object.keys(byDept).length }) });
      setP({ name: f.name, file, byDept, checks });
    } catch (x) {
      setErr(errText(x));
    }
  }

  const sumOf = (routes: Record<string, Grid>) => {
    const s: Grid = {};
    for (const g of Object.values(routes)) for (const [k, n] of Object.entries(g)) s[k] = (s[k] ?? 0) + n;
    return s;
  };
  const blocked = !p || p.checks.some((c) => c.level === 'error') || !Object.keys(p.byDept).length;

  async function apply() {
    if (!p) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const calc: Record<string, Record<string, Grid>> = {};
      const dept: Record<string, Grid> = {};
      for (const [d, routes] of Object.entries(p.byDept)) {
        calc[d] = {};
        for (const [r, g] of Object.entries(routes)) {
          const nz: Grid = {};
          for (const [k, n] of Object.entries(g)) if (n > 0) nz[k] = n;
          calc[d]![r] = nz;
        }
        dept[d] = sumOf(calc[d]!);
      }
      if (ws === 'ka') await api('PUT', `/api/admin/cycle/ka/${period}/dept-target`, { dept });
      const notes = { at: new Date().toISOString(), source: 'upload', file: p.name, salesmen: p.file.salesmen };
      const out = await api<{ applied: string[]; kept: string[] }>('PUT', `/api/admin/cycle/${ws}/${period}/calc`, { calc, notes });
      setMsg(`${tc('calcApplied', { n: out.applied.length, kept: out.kept.length })} ${tc('calcAppliedNext')}`);
      reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  function exportIt() {
    if (!p) return;
    const master = org.packs.map((x) => x.code);
    const lines: TargetLine[] = [];
    for (const leaf of org.leaves) {
      const g = p.byDept[String(leaf.deptId)]?.[leaf.routeCode];
      if (!g) continue;
      lines.push({ ds: p.file.deliverySystems[leaf.routeCode] ?? leaf.deliverySystem, code: leaf.routeCode, salesman: p.file.salesmen[leaf.routeCode], grid: g, packs: inPackOrder(Object.keys(g), master) });
    }
    void writeTargetFile(kind, `${kind === 'mtfl' ? 'MTFL_Targets' : 'SalesTarget_MDD'}_${period}.xlsx`, period, lines, { preparedBy: me?.name, formats: p.file.formats });
  }

  const depts = p ? Object.keys(p.byDept) : [];
  return (
    <Section title={ws === 'ka' ? tc('srcUploadKa') : tc('srcUploadOps')}>
      <div class="toolbar">
        <label class="btn">{tc('upPick')}
          <input type="file" accept=".xlsx,.xlsm" class="visually-hidden" data-testid="route-upload-file" onChange={(e) => void pick(e.currentTarget.files?.[0])} />
        </label>
        {p && <span class="small muted">{p.name}</span>}
      </div>
      {p && <Checks checks={p.checks} />}
      {p && depts.length > 0 && (
        <div class="tablewrap"><table class="ad-table cy-table" data-testid="route-upload-check">
          <thead><tr><th>{tc('head')}</th><th class="num">{ws === 'ka' ? 'KAE' : tc('lvRoute')}</th>
            {CATEGORIES.map((c) => <th key={c} class="num">{c}{deptTarget && <div class="small muted">{tc('calcVsTarget')}</div>}</th>)}
            <th class="num">{tc('total')}{deptTarget && <div class="small muted">{tc('calcVsTarget')}</div>}</th><th>{deptTarget ? tc('checkCol') : ''}</th></tr></thead>
          <tbody>{depts.map((d) => {
            const s = sumOf(p.byDept[d]!);
            const t = deptTarget?.[d];
            const tot = total(s);
            const tt = t ? total(t) : null;
            return (
              <tr key={d}><td>{deptName(d)}</td><td class="num">{Object.keys(p.byDept[d]!).length}</td>
                {CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(sumCat(s, cats, c))}{t && <div class="small muted">{tc('targetN', { n: fmtNum(sumCat(t, cats, c)) })}</div>}</td>)}
                <td class="num tot">{fmtNum(tot)}{tt !== null && <div class="small muted">{tc('targetN', { n: fmtNum(tt) })}</div>}</td>
                <td>{tt === null ? '' : tot === tt ? <span class="status ok">{tc('matches')}</span>
                  : tot > tt ? <span class="status bad">{tc('overBy', { n: fmtNum(tot - tt) })}</span>
                    : <span class="status warn">{tc('underBy', { n: fmtNum(tt - tot) })}</span>}</td></tr>
            );
          })}</tbody>
        </table></div>
      )}
      {msg && <div class="banner ok" role="status" data-testid="calc-applied">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="actions cy-end">
        <button type="button" class="btn" disabled={!p} onClick={exportIt}>{ws === 'ka' ? tc('exportMdd') : tc('exportMtfl')}</button>
        <button type="button" class="btn primary" disabled={busy || blocked} data-testid="apply-upload" onClick={() => void apply()}>{tc('applyN', { n: depts.length })}</button>
      </div>
    </Section>
  );
}
