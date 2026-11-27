// Admin › Cycle setup › Sales attribution: the Modern Trade and Modern Bulk
// departments have no routes in the Operation sales file, so their sales are
// empty. The Admin picks a person (a Key Account KAE or KAM, or a code of the
// sales file that is in no hierarchy) and assigns them to a department and
// channel: their sales then count for it in the splits, Mix and reports.
import { useEffect, useState } from 'preact/hooks';
import type { OrgDto } from '../../../worker/services/cycleData';
import type { SalesAttr } from '../../../worker/services/salesAttr';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { clearRouteCache, useAsync } from '../../cycle/load';
import { Section } from '../../cycle/ui';

type Person = { id: string; label: string; group: 'kam' | 'kae' | 'ops'; codes: { code: string; src: 'ops' | 'ka'; name: string }[] };

export function SalesAttrForm() {
  useLang();
  const data = useAsync(async () => {
    const [ops, ka, cur] = await Promise.all([
      api<OrgDto>('GET', '/api/data/ops/org'),
      api<OrgDto>('GET', '/api/data/ka/org').catch(() => null),
      api<{ list: SalesAttr[]; unmapped: { month: string | null; codes: string[] } }>('GET', '/api/admin/sales-attr'),
    ]);
    return { ops, ka, cur };
  }, []);
  const [list, setList] = useState<SalesAttr[]>([]);
  const [pick, setPick] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (data.data) setList(data.data.cur.list); }, [data.data]);
  if (data.error) return <Section title={tc('attrTitle')}><div class="alert">{data.error}</div></Section>;
  if (!data.data) return <Section title={tc('attrTitle')}><p class="muted">{tc('loading')}</p></Section>;
  const { ops, ka, cur } = data.data;

  // People to pick from: KAMs (all their KAEs), KAEs, and sales-file codes in no hierarchy.
  const people: Person[] = [];
  if (ka) {
    const byId = new Map(ka.nodes.map((n) => [n.id, n]));
    const kamOf = (nodeId: number) => { let n = byId.get(nodeId); while (n && n.parentId !== null && byId.get(n.parentId)?.parentId !== null) n = byId.get(n.parentId); return n && n.parentId !== null ? n : undefined; };
    const kams = new Map<number, Person>();
    for (const leaf of ka.leaves) {
      const kam = kamOf(leaf.nodeId);
      const name = leaf.label && leaf.label !== leaf.routeCode ? `${leaf.routeCode} · ${leaf.label}` : leaf.routeCode;
      people.push({ id: `kae:${leaf.routeCode}`, label: `${name}${kam ? ` (${kam.name})` : ''}`, group: 'kae', codes: [{ code: leaf.routeCode, src: 'ka', name }] });
      if (kam) {
        const p = kams.get(kam.id) ?? { id: `kam:${kam.id}`, label: kam.name, group: 'kam' as const, codes: [] };
        p.codes.push({ code: leaf.routeCode, src: 'ka', name });
        kams.set(kam.id, p);
      }
    }
    people.unshift(...[...kams.values()].map((p) => ({ ...p, label: `${p.label} (${tc('attrKaes', { n: p.codes.length })})` })));
  }
  for (const c of cur.unmapped.codes) people.push({ id: `ops:${c}`, label: c, group: 'ops', codes: [{ code: c, src: 'ops', name: c }] });

  const targets = ops.depts.flatMap((d) => (d.channels.length ? d.channels.map((c) => ({ id: `${d.id}|${c.channel}`, label: `${d.name} › ${c.channel}`, deptId: d.id, channel: c.channel })) : [{ id: `${d.id}|`, label: d.name, deptId: d.id, channel: '' }]));
  const deptName = (id: number) => ops.depts.find((d) => d.id === id)?.name ?? String(id);

  function add() {
    const p = people.find((x) => x.id === pick);
    const t = targets.find((x) => x.id === target);
    if (!p || !t) return;
    const next = list.filter((a) => !p.codes.some((c) => c.code === a.code && c.src === a.src));
    next.push(...p.codes.map((c) => ({ code: c.code, src: c.src, deptId: t.deptId, channel: t.channel, name: c.name })));
    setList(next);
    setPick('');
    setMsg(null);
  }
  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api<{ list: SalesAttr[] }>('PUT', '/api/admin/sales-attr', { list });
      setList(r.list);
      clearRouteCache('ops');
      setMsg(tc('saved'));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  const dirty = JSON.stringify(list) !== JSON.stringify(cur.list);
  return (
    <Section title={tc('attrTitle')}>
      <p class="muted small">{tc('attrHelp')}</p>
      <div class="toolbar" data-testid="attr-add">
        <label class="field"><span>{tc('attrPerson')}</span>
          <select value={pick} data-testid="attr-person" onChange={(e) => setPick(e.currentTarget.value)}>
            <option value="">{tc('attrPick')}</option>
            {people.some((p) => p.group === 'kam') && <optgroup label="KAM">{people.filter((p) => p.group === 'kam').map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>}
            {people.some((p) => p.group === 'kae') && <optgroup label="KAE">{people.filter((p) => p.group === 'kae').map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>}
            {people.some((p) => p.group === 'ops') && <optgroup label={tc('attrUnmapped')}>{people.filter((p) => p.group === 'ops').map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>}
          </select></label>
        <label class="field"><span>{tc('attrTo')}</span>
          <select value={target} data-testid="attr-target" onChange={(e) => setTarget(e.currentTarget.value)}>
            <option value="">{tc('attrPick')}</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select></label>
        <button type="button" class="btn" disabled={!pick || !target} data-testid="attr-addbtn" onClick={add}>{tc('attrAdd')}</button>
      </div>
      {list.length > 0 ? (
        <div class="tablewrap cy-fit"><table class="ad-table cy-table" data-testid="attr-list">
          <thead><tr><th>{tc('attrPerson')}</th><th>{tc('attrSource')}</th><th>{tc('attrTo')}</th><th /></tr></thead>
          <tbody>{list.map((a, i) => (
            <tr key={`${a.src}:${a.code}`}>
              <td><bdi>{a.name ?? a.code}</bdi></td>
              <td class="small muted">{a.src === 'ka' ? 'Key Account' : tc('attrUnmapped')}</td>
              <td><select value={`${a.deptId}|${a.channel}`} aria-label={tc('attrTo')} onChange={(e) => { const t = targets.find((x) => x.id === e.currentTarget.value); if (t) setList(list.map((x, j) => (j === i ? { ...x, deptId: t.deptId, channel: t.channel } : x))); }}>
                {!targets.some((t) => t.id === `${a.deptId}|${a.channel}`) && <option value={`${a.deptId}|${a.channel}`}>{deptName(a.deptId)} › {a.channel}</option>}
                {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select></td>
              <td><button type="button" class="btn link" onClick={() => setList(list.filter((_x, j) => j !== i))}>{tc('remove')}</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p class="muted small">{tc('attrNone')}</p>}
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="actions"><button type="button" class="btn primary" disabled={busy || !dirty} data-testid="attr-save" onClick={() => void save()}>{tc('save')}</button></div>
    </Section>
  );
}
