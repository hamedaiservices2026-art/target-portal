// Admin › Cycle setup: distribution rules (caps per level, rules 2 and 3,
// per-person exceptions), each Head's workspace and channels, and who is the
// Commercial Director of each workspace.
import { useEffect, useState } from 'preact/hooks';
import type { Workspace } from '../../../worker/auth';
import type { OrgDto, SetupChange } from '../../../worker/services/cycleData';
import type { DepartmentDto, UserDto } from '../../../worker/services/masters';
import type { RulesSettings } from '../../../worker/services/rulesSettings';
import { api } from '../../api';
import { ConfirmButton, errText, PageHead, useResource } from '../../components/AdminBits';
import { fmtDateTime } from '../../format';
import { useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { useAsync } from '../../cycle/load';
import { Section, WS_LABEL } from '../../cycle/ui';

function Saver({ busy, err, msg }: { busy: boolean; err: string | null; msg: string | null }) {
  return (
    <>
      {busy && <span class="muted small">{tc('saving')}</span>}
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
    </>
  );
}

function RulesForm() {
  useLang();
  const res = useResource<RulesSettings>('/api/admin/rules');
  // Heads and managers (both workspaces) to pick a cap exception from.
  const people = useAsync(async () => {
    const orgs = await Promise.all([api<OrgDto>('GET', '/api/data/ops/org'), api<OrgDto>('GET', '/api/data/ka/org')]);
    const out: { name: string; role: 'head' | 'manager'; dept: string }[] = [];
    for (const o of orgs) {
      const dept = new Map(o.depts.map((d) => [d.id, d.name]));
      const byId = new Map(o.nodes.map((n) => [n.id, n]));
      for (const n of o.nodes) {
        const parent = n.parentId === null ? undefined : byId.get(n.parentId);
        const role = n.parentId === null ? 'head' : parent && parent.parentId === null ? 'manager' : null;
        if (role) out.push({ name: n.name, role, dept: dept.get(n.deptId) ?? '' });
      }
    }
    return out;
  }, []);
  const [r, setR] = useState<RulesSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (res.data) setR(res.data); }, [res.data]);
  if (res.error) return <div class="alert">{res.error}</div>;
  if (!r) return <p class="muted">{tc('loading')}</p>;
  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      setR(await api<RulesSettings>('PUT', '/api/admin/rules', { ...r, exceptions: r!.exceptions.filter((e) => e.name.trim()) }));
      setMsg(tc('saved'));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  const cap = (k: 'head' | 'manager' | 'supervisor', label: string) => (
    <label class="field"><span>{label}</span>
      <input type="number" min={0} max={100} step="0.5" value={r.caps[k]} onInput={(e) => setR({ ...r, caps: { ...r.caps, [k]: Number(e.currentTarget.value) } })} /></label>
  );
  return (
    <Section title={tc('rulesTitle')}>
      <p class="muted small">{tc('rulesHelp')}</p>
      <label class="cy-capon"><input type="checkbox" data-testid="cap-on" checked={r.enabled !== false} onChange={(e) => setR({ ...r, enabled: e.currentTarget.checked })} /> <b>{tc('capApply')}</b></label>
      {r.enabled === false && <p class="banner warn small">{tc('capOffHelp')}</p>}
      <div class="cy-grid" style={r.enabled === false ? { opacity: 0.5 } : undefined}>
        {cap('head', tc('capHead'))}
        {cap('manager', tc('capManager'))}
        {cap('supervisor', tc('capSupervisor'))}
      </div>
      <label><input type="checkbox" checked disabled /> {tc('rule1On')}</label><br />
      <label><input type="checkbox" disabled={r.enabled === false} checked={r.rule2} onChange={(e) => setR({ ...r, rule2: e.currentTarget.checked })} /> {tc('rule2On')}</label><br />
      <label><input type="checkbox" disabled={r.enabled === false} checked={r.rule3} onChange={(e) => setR({ ...r, rule3: e.currentTarget.checked })} /> {tc('rule3On')}</label>
      <h3>{tc('exceptions')}</h3>
      <p class="muted small">{tc('exceptionsHelp')}</p>
      <table class="ad-table cy-table">
        <thead><tr><th>{tc('excName')}</th><th>{tc('excRole')}</th><th class="num">{tc('excPct')}</th><th /></tr></thead>
        <tbody>
          {r.exceptions.map((e, i) => (
            <tr key={i}>
              <td><select value={e.name} aria-label={tc('excName')} data-testid="exc-name" onChange={(ev) => setR({ ...r, exceptions: r.exceptions.map((x, j) => (j === i ? { ...x, name: ev.currentTarget.value } : x)) })}>
                <option value="">{tc('excPick')}</option>
                {e.name && !(people.data ?? []).some((p) => p.name.toLowerCase() === e.name.toLowerCase()) && <option value={e.name}>{e.name}</option>}
                <optgroup label={tc('excHeads')}>{(people.data ?? []).filter((p) => p.role === 'head').map((p) => <option key={`h${p.name}`} value={p.name}>{p.name}</option>)}</optgroup>
                <optgroup label={tc('excManagers')}>{(people.data ?? []).filter((p) => p.role === 'manager').map((p) => <option key={`m${p.name}${p.dept}`} value={p.name}>{p.name} · {p.dept}</option>)}</optgroup>
              </select></td>
              <td class="small muted">{(() => { const p = (people.data ?? []).find((x) => x.name.toLowerCase() === e.name.toLowerCase()); return p ? `${p.role === 'head' ? tc('lvHead') : tc('lvManager')} · ${p.dept}` : ''; })()}</td>
              <td class="num"><input type="number" min={0} max={100} value={e.pct} aria-label={tc('excPct')} onInput={(ev) => setR({ ...r, exceptions: r.exceptions.map((x, j) => (j === i ? { ...x, pct: Number(ev.currentTarget.value) } : x)) })} /></td>
              <td><button type="button" class="btn link" onClick={() => setR({ ...r, exceptions: r.exceptions.filter((_x, j) => j !== i) })}>{tc('remove')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="actions">
        <button type="button" class="btn" onClick={() => setR({ ...r, exceptions: [...r.exceptions, { name: '', pct: r.caps.supervisor }] })}>{tc('addException')}</button>
        <button type="button" class="btn primary" disabled={busy} onClick={() => void save()}>{tc('save')}</button>
      </div>
      <Saver busy={busy} err={err} msg={msg} />
    </Section>
  );
}

function DeptRow({ d, channels, onSaved }: { d: DepartmentDto; channels: { channel: string; grp: string }[]; onSaved: () => void }) {
  useLang();
  const [ws, setWs] = useState<Workspace>(d.workspace === 'ka' ? 'ka' : 'ops');
  const [sort, setSort] = useState(String(d.sort ?? 0));
  const [text, setText] = useState(channels.map((c) => c.channel).join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api('PUT', `/api/admin/departments/${d.id}/workspace`, { workspace: ws, sort: Number(sort) || 0 });
      const list = text.split(',').map((s) => s.trim()).filter(Boolean);
      await api('PUT', `/api/admin/departments/${d.id}/channels`, { channels: list.map((channel) => ({ channel, grp: d.code })) });
      setMsg(tc('saved'));
      onSaved();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr data-testid="dept-setup">
      <td><b>{d.name}</b><div class="muted small">{d.code}</div></td>
      <td><select value={ws} aria-label={tc('workspace')} onChange={(e) => setWs(e.currentTarget.value as Workspace)}>
        <option value="ops">{WS_LABEL('ops')}</option><option value="ka">{WS_LABEL('ka')}</option></select></td>
      <td><input type="number" value={sort} aria-label={tc('order')} onInput={(e) => setSort(e.currentTarget.value)} style={{ width: '5em' }} /></td>
      <td><input value={text} aria-label={tc('channels')} placeholder="TT DMM, TT Outer" onInput={(e) => setText(e.currentTarget.value)} /></td>
      <td><button type="button" class="btn" disabled={busy} onClick={() => void save()}>{tc('save')}</button><Saver busy={false} err={err} msg={msg} /></td>
    </tr>
  );
}

function DeptSetup() {
  useLang();
  const depts = useResource<{ departments: DepartmentDto[] }>('/api/admin/departments');
  const orgs = useAsync(async () => {
    const [ops, ka] = await Promise.all([api<OrgDto>('GET', '/api/data/ops/org'), api<OrgDto>('GET', '/api/data/ka/org')]);
    return [...ops.depts, ...ka.depts];
  }, []);
  const chans = (id: number) => orgs.data?.find((d) => d.id === id)?.channels ?? [];
  const hist = useResource<{ changes: SetupChange[] }>('/api/admin/departments/setup-history');
  return (
    <Section title={tc('deptSetupTitle')}>
      <p class="muted small">{tc('deptSetupHelp')}</p>
      {(depts.error || orgs.error) && <div class="alert">{depts.error ?? orgs.error}</div>}
      {depts.data && orgs.data && (
        <div class="tablewrap"><table class="ad-table cy-table">
          <thead><tr><th>{tc('head')}</th><th>{tc('workspace')}</th><th>{tc('order')}</th><th>{tc('channels')}</th><th /></tr></thead>
          <tbody>{depts.data.departments.map((d) => <DeptRow key={`${d.id}${d.workspace}${d.sort}${chans(d.id).map((c) => c.channel).join()}`} d={d} channels={chans(d.id)} onSaved={() => { depts.reload(); orgs.reload(); hist.reload(); }} />)}</tbody>
        </table></div>
      )}
      <SetupHistory hist={hist} onUndone={() => { depts.reload(); orgs.reload(); hist.reload(); }} />
    </Section>
  );
}

/** Every change to the Heads' channels and workspace, with what it was before and an undo. */
function SetupHistory({ hist, onUndone }: { hist: ReturnType<typeof useResource<{ changes: SetupChange[] }>>; onUndone: () => void }) {
  const [lang] = useLang();
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function undo(c: SetupChange) {
    setErr(null); setMsg(null);
    try {
      await api('POST', `/api/admin/departments/setup-history/${c.id}/undo`, {});
      setMsg(tc('shUndone', { dept: c.dept, value: c.before ?? '' }));
      onUndone();
    } catch (x) {
      setErr(errText(x));
    }
  }
  const list = hist.data?.changes ?? [];
  return (
    <details class="card ad-card" data-testid="setup-history" open={list.length > 0}>
      <summary><b>{tc('shTitle')}</b> <span class="muted small">({list.length})</span></summary>
      <p class="small muted">{tc('shHelp')}</p>
      {hist.error && <div class="alert">{hist.error}</div>}
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      {list.length === 0 ? <p class="muted small">{tc('shNone')}</p> : (
        <div class="tablewrap" style={{ maxHeight: '320px' }}><table class="ad-table cy-table">
          <thead><tr><th>{tc('shWhen')}</th><th>{tc('head')}</th><th>{tc('shWhat')}</th><th>{tc('shBefore')}</th><th>{tc('shAfter')}</th><th /></tr></thead>
          <tbody>{list.map((c) => (
            <tr key={c.id} data-testid="setup-change">
              <td class="small">{fmtDateTime(c.at, lang)}<div class="muted">{c.by ?? ''}</div></td>
              <td><b>{c.dept}</b></td>
              <td class="small">{c.kind === 'channels' ? tc('channels') : tc('workspace')}</td>
              <td class="small">{c.before ?? <span class="muted">{tc('shNotRecorded')}</span>}</td>
              <td class="small">{c.after}</td>
              <td>{c.undoable && <ConfirmButton label={tc('shUndo')} question={tc('shUndoQ', { dept: c.dept, value: c.before ?? '' })} yesLabel={tc('shUndo')} danger={false} testId="setup-undo" onConfirm={() => undo(c)} />}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </details>
  );
}

function CdRoles() {
  useLang();
  const users = useResource<{ users: UserDto[] }>('/api/admin/users');
  const roles = useResource<{ roles: { userId: number; workspace: Workspace }[] }>('/api/admin/cd-roles');
  const [err, setErr] = useState<string | null>(null);
  async function toggle(u: UserDto, w: Workspace, on: boolean) {
    setErr(null);
    const cur = (roles.data?.roles ?? []).filter((r) => r.userId === u.id).map((r) => r.workspace);
    const cd = on ? [...new Set([...cur, w])] : cur.filter((x) => x !== w);
    try {
      await api('PUT', `/api/admin/users/${u.id}/cd`, { cd });
      roles.reload();
    } catch (x) {
      setErr(errText(x));
    }
  }
  const has = (id: number, w: Workspace) => !!roles.data?.roles.some((r) => r.userId === id && r.workspace === w);
  return (
    <Section title={tc('cdRolesTitle')}>
      <p class="muted small">{tc('cdRolesHelp')}</p>
      {err && <div class="alert" role="alert">{err}</div>}
      {users.data && roles.data && (
        <div class="tablewrap"><table class="ad-table cy-table">
          <thead><tr><th>{tc('user')}</th><th>{WS_LABEL('ops')}</th><th>{WS_LABEL('ka')}</th></tr></thead>
          <tbody>{users.data.users.filter((u) => u.active).map((u) => (
            <tr key={u.id}>
              <td>{u.name}<div class="muted small">{u.username}</div></td>
              {(['ops', 'ka'] as Workspace[]).map((w) => (
                <td key={w}><input type="checkbox" aria-label={`${u.name} ${WS_LABEL(w)}`} checked={has(u.id, w)} onChange={(e) => void toggle(u, w, e.currentTarget.checked)} /></td>
              ))}
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Section>
  );
}

export function CycleSetup() {
  useLang();
  return (
    <section class="cycle" data-testid="cycle-setup">
      <PageHead title={tc('setupTitle')} intro={tc('setupIntro')} />
      <RulesForm />
      <DeptSetup />
      <CdRoles />
    </section>
  );
}
