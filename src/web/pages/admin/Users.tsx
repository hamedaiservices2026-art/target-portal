// Admin › Users, laid out like the v16 prototype: one account per person of
// the sales hierarchy (Channel Head, Sales Manager, Sales Supervisor) and the
// Commercial Director. Each account shows its roles, status and first
// password; the admin can reset or change a password, unlock, disable and
// download the logins to send. The API never returns password hashes.
import { useMemo, useState } from 'preact/hooks';
import type { AccountDto, AccountRole } from '../../../worker/services/accounts';
import { api } from '../../api';
import { errText, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { writeXlsx } from '../../excel';
import { fmtDateTime } from '../../format';
import { t, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { useSession } from '../../session';

type Data = { accounts: AccountDto[]; missing: number };
const ws = (w?: string) => (w === 'ka' ? tc('wsKa') : tc('wsOps'));

export function roleText(r: AccountRole): string {
  if (r.kind === 'admin') return tc('urAdmin');
  if (r.kind === 'cd') return `${tc('ppCd')} · ${ws(r.ws)}`;
  // Key Accounts: the manager level is the KAM, the level under it the KAE.
  const ka = r.ws === 'ka';
  const pos = r.kind === 'head' ? (ka ? tc('urKaHead') : tc('ppHead')) : r.kind === 'manager' ? (ka ? 'KAM' : tc('ppManager')) : (ka ? 'KAE' : tc('ppSupervisor'));
  return `${pos} · ${r.dept ?? '—'}`;
}
const STATUS: Record<AccountDto['status'], [string, string]> = {
  disabled: ['urDisabled', 'muted'], locked: ['urLocked', 'bad'], norole: ['urNoRole', 'muted'], pending: ['urPending', 'warn'], active: ['urActive', 'ok'],
};
const statusText = (s: AccountDto['status']) => tc(STATUS[s][0] as 'urActive');

function newPassword(): string {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789';
  const a = new Uint32Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (x, i) => (i < 4 ? L[x % L.length] : D[x % D.length])).join('');
}

type Kind = 'cd' | 'admin' | 'head' | 'manager' | 'supervisor' | 'kam' | 'kae' | 'other' | `custom:${string}`;
type NodeLite = { id: number; name: string; parent_id: number | null; manager_user_id: number | null; dept_id?: number };
type DeptLite = { id: number; workspace?: 'ops' | 'ka' };
/** The hierarchy level each position links to, and in which workspace. */
const LEVEL: Partial<Record<Kind, { depth: number; ws: 'ops' | 'ka' }>> = {
  head: { depth: 0, ws: 'ops' }, manager: { depth: 1, ws: 'ops' }, supervisor: { depth: 2, ws: 'ops' },
  kam: { depth: 1, ws: 'ka' }, kae: { depth: 2, ws: 'ka' },
};

/** Hierarchy people of one level and workspace (Head 0, Manager/KAM 1, Supervisor/KAE 2+) without an account yet. */
function openNodes(nodes: NodeLite[], depts: DeptLite[], depth: number, wsWanted: 'ops' | 'ka'): NodeLite[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wsOf = new Map(depts.map((d) => [d.id, d.workspace ?? 'ops']));
  const depthOf = (n: NodeLite) => { let d = 0; for (let p = n.parent_id; p !== null && d < 20; p = byId.get(p)?.parent_id ?? null) d++; return d; };
  return nodes.filter((n) => n.manager_user_id === null && (wsOf.get(n.dept_id ?? 0) ?? 'ops') === wsWanted && (depth === 2 ? depthOf(n) >= 2 : depthOf(n) === depth))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function AddAccount({ taken, positions, onPositions, onDone }: { taken: Set<string>; positions: string[]; onPositions: (p: string[]) => void; onDone: (msg: string) => void }) {
  useLang();
  const nodesRes = useResource<{ nodes: NodeLite[] }>('/api/admin/nodes');
  const deptRes = useResource<{ departments: DeptLite[] }>('/api/admin/departments');
  const [newPos, setNewPos] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [kind, setKind] = useState<Kind>('supervisor');
  const [nodeId, setNodeId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const level = LEVEL[kind];
  const depth = level?.depth;
  const choices = level === undefined ? [] : openNodes(nodesRes.data?.nodes ?? [], deptRes.data?.departments ?? [], level.depth, level.ws);
  async function addPosition() {
    const v = (newPos ?? '').trim();
    if (!v) return;
    try {
      const r = await api<{ positions: string[] }>('PUT', '/api/admin/positions', { positions: [...positions, v] });
      onPositions(r.positions);
      setKind(`custom:${v}`);
      setNewPos(null);
    } catch (x) {
      setErr(errText(x));
    }
  }
  function pickNode(v: string) {
    setNodeId(v);
    const n = choices.find((x) => String(x.id) === v);
    if (n && !name.trim()) { setName(n.name); if (!username) setUsername(slug(n.name)); }
  }
  async function save(e: Event) {
    e.preventDefault();
    setErr(null);
    const u = username.trim().toLowerCase();
    if (!name.trim() || !u || /\s/.test(u)) return setErr(tc('urNeedName'));
    if (taken.has(u)) return setErr(tc('urTaken', { u }));
    setBusy(true);
    try {
      const pw = newPassword();
      const position = kind.startsWith('custom:') ? kind.slice(7) : kind === 'other' ? tc('urOther') : null;
      const { user } = await api<{ user: { id: number } }>('POST', '/api/admin/users', { username: u, name: name.trim(), role: kind === 'admin' ? 'admin' : 'manager', password: pw, ...(position ? { position } : {}) });
      if (kind === 'cd') await api('PUT', `/api/admin/users/${user.id}/cd`, { cd: ['ops', 'ka'] });
      if (nodeId && depth !== undefined) await api('PATCH', `/api/admin/nodes/${nodeId}`, { managerUserId: user.id });
      onDone(tc('urCreated', { u, pw }));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form class="card ad-card" onSubmit={save} data-testid="add-account">
      <h2>{tc('urAddTitle')}</h2>
      <div class="toolbar">
        <label>{tc('ppPosition')} <select value={kind} data-testid="add-kind" onChange={(e) => { setKind(e.currentTarget.value as Kind); setNodeId(''); }}>
          <option value="supervisor">{tc('ppSupervisor')}</option>
          <option value="manager">{tc('ppManager')}</option>
          <option value="head">{tc('ppHead')}</option>
          <option value="kam">{tc('urKam')}</option>
          <option value="kae">{tc('urKae')}</option>
          <option value="other">{tc('urOther')}</option>
          {positions.map((p) => <option key={p} value={`custom:${p}`}>{p}</option>)}
          <option value="cd">{tc('ppCd')}</option>
          <option value="admin">{tc('urAdmin')}</option>
        </select></label>
        {newPos === null
          ? <button type="button" class="btn link" data-testid="add-position" onClick={() => setNewPos('')}>{tc('urAddPosition')}</button>
          : (
            <span class="toolbar">
              <input aria-label={tc('urNewPosition')} placeholder={tc('urNewPosition')} value={newPos} onInput={(e) => setNewPos(e.currentTarget.value)} />
              <button type="button" class="btn" onClick={() => void addPosition()}>{tc('urAddIt')}</button>
              <button type="button" class="btn link" onClick={() => setNewPos(null)}>{tc('cancel')}</button>
            </span>
          )}
        {depth !== undefined && (
          <label>{tc('urLinkTo')} <select value={nodeId} data-testid="add-node" onChange={(e) => pickNode(e.currentTarget.value)}>
            <option value="">{tc('urNoLink')}</option>
            {choices.map((n) => <option key={n.id} value={String(n.id)}>{n.name}</option>)}
          </select></label>
        )}
        <label>{tc('ppName')} <input value={name} onInput={(e) => { const v = e.currentTarget.value; setName(v); if (!username || username === slug(name)) setUsername(slug(v)); }} /></label>
        <label>{t('username')} <input value={username} onInput={(e) => setUsername(e.currentTarget.value)} autocapitalize="none" spellcheck={false} /></label>
        <button type="submit" class="btn primary" disabled={busy}>{tc('urCreate')}</button>
      </div>
      <p class="muted small">{tc('urAddHelp')}</p>
      {err && <div class="alert" role="alert">{err}</div>}
    </form>
  );
}

/** Inline edit of a person's name and username. */
function EditAccount({ a, taken, onDone }: { a: AccountDto; taken: Set<string>; onDone: (msg: string) => void }) {
  useLang();
  const [name, setName] = useState(a.name);
  const [username, setUsername] = useState(a.username);
  const [err, setErr] = useState<string | null>(null);
  async function save(e: Event) {
    e.preventDefault();
    const u = username.trim().toLowerCase();
    if (!name.trim() || !u || /\s/.test(u)) return setErr(tc('urNeedName'));
    if (u !== a.username && taken.has(u)) return setErr(tc('urTaken', { u }));
    setErr(null);
    try {
      await api('PATCH', `/api/admin/users/${a.id}`, { name: name.trim(), username: u });
      onDone(tc('urEdited', { u }));
    } catch (x) {
      setErr(errText(x));
    }
  }
  return (
    <form class="toolbar" onSubmit={save} data-testid="edit-account">
      <label>{tc('ppName')} <input value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
      <label>{t('username')} <input value={username} autocapitalize="none" spellcheck={false} onInput={(e) => setUsername(e.currentTarget.value)} /></label>
      <button type="submit" class="btn primary">{tc('save')}</button>
      <button type="button" class="btn" onClick={() => onDone('')}>{tc('cancel')}</button>
      {err && <div class="alert" role="alert">{err}</div>}
    </form>
  );
}
const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s.-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');

function SetPassword({ a, onDone }: { a: AccountDto; onDone: (msg: string) => void }) {
  useLang();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function save(e: Event) {
    e.preventDefault();
    if (pw.length < 8) return setErr(t('adPasswordShort'));
    setErr(null);
    try {
      await api('POST', `/api/admin/users/${a.id}/password`, { password: pw });
      onDone(tc('urPwSet', { u: a.username }));
    } catch (x) {
      setErr(errText(x));
    }
  }
  return (
    <form class="toolbar" onSubmit={save}>
      <label>{tc('urNewPwFor', { u: a.username })} <input type="text" value={pw} autocomplete="new-password" onInput={(e) => setPw(e.currentTarget.value)} /></label>
      <button type="submit" class="btn primary">{tc('urSetPw')}</button>
      <button type="button" class="btn" onClick={() => setPw(newPassword())}>{tc('urSuggest')}</button>
      <button type="button" class="btn" onClick={() => onDone('')}>{tc('cancel')}</button>
      <span class="muted small">{tc('urSetPwHelp')}</span>
      {err && <div class="alert" role="alert">{err}</div>}
    </form>
  );
}

export function Users() {
  const [lang] = useLang();
  const { user: me } = useSession();
  const res = useResource<Data>('/api/admin/accounts');
  const [q, setQ] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [arm, setArm] = useState<number | null>(null);
  const [setting, setSetting] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [armDel, setArmDel] = useState<number | null>(null);
  const posRes = useResource<{ positions: string[] }>('/api/admin/positions');
  const [positions, setPositions] = useState<string[] | null>(null);
  const posList = positions ?? posRes.data?.positions ?? [];
  const [adding, setAdding] = useState(false);
  const [sync, setSync] = useState<{ done: number; left: number } | null>(null);
  const [made, setMade] = useState<string[][]>([]);

  const accounts = res.data?.accounts ?? [];
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    return accounts.filter((a) => !f || [a.name, a.username, ...a.roles.map(roleText)].join(' ').toLowerCase().includes(f));
  }, [accounts, q, lang]);
  const count = (s: AccountDto['status']) => accounts.filter((a) => a.status === s).length;

  const act = async (fn: () => Promise<string>) => {
    setFlash(null);
    try {
      setFlash({ ok: true, text: await fn() });
    } catch (x) {
      setFlash({ ok: false, text: errText(x) });
    }
    setArm(null);
    res.reload();
  };
  const reset = (a: AccountDto) => act(async () => {
    const r = await api<{ password: string }>('POST', `/api/admin/users/${a.id}/password`, {});
    return tc('urResetDone', { u: a.username, pw: r.password });
  });
  const remove = (a: AccountDto) => act(async () => { await api('DELETE', `/api/admin/users/${a.id}`); setArmDel(null); return tc('urDeleted', { u: a.username }); });
  const unlock = (a: AccountDto) => act(async () => { await api('POST', `/api/admin/users/${a.id}/unlock`, {}); return tc('urUnlocked', { u: a.username }); });
  const toggle = (a: AccountDto) => act(async () => {
    await api('PATCH', `/api/admin/users/${a.id}`, { active: !a.active });
    return tc(a.active ? 'urDisabledMsg' : 'urEnabledMsg', { u: a.username });
  });

  async function createMissing() {
    setFlash(null);
    const out: string[][] = [];
    try {
      for (let i = 0; i < 500; i++) {
        const r = await api<{ created: { name: string; username: string; password: string } | null; remaining: number }>('POST', '/api/admin/accounts/sync', {});
        if (r.created) out.push([r.created.name, r.created.username, r.created.password]);
        setSync({ done: out.length, left: r.remaining });
        if (!r.created || r.remaining === 0) break;
      }
      setFlash({ ok: true, text: tc('urSynced', { n: out.length }) });
    } catch (x) {
      setFlash({ ok: false, text: errText(x) });
    } finally {
      setSync(null);
      setMade(out);
      res.reload();
    }
  }

  function downloadLogins() {
    const rows = accounts.filter((a) => a.status !== 'disabled' && a.roles.length)
      .map((a) => [a.name, a.username, a.firstPw ?? tc('urChangedByUser'), a.roles.map(roleText).join('; '), statusText(a.status)]);
    void writeXlsx('user_logins.xlsx', [tc('ppName'), t('username'), tc('urFirstPw'), tc('urRoles'), tc('status')], rows);
  }

  return (
    <section data-testid="admin-users">
      <PageHead title={t('navUsers')} intro={tc('urIntro')} />
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {res.data && (
        <>
          <div class="summary">
            <div class="card"><div class="k">{tc('urAccounts')}</div><div class="v">{accounts.length}</div></div>
            <div class="card"><div class="k">{tc('urPending')}</div><div class="v">{count('pending')}</div></div>
            <div class="card"><div class="k">{tc('urLocked')}</div><div class="v">{count('locked')}</div></div>
            <div class="card"><div class="k">{tc('urDisabled')}</div><div class="v">{count('disabled')}</div></div>
          </div>
          {flash && <div class={flash.ok ? 'banner ok' : 'alert'} role={flash.ok ? 'status' : 'alert'} data-testid="users-flash">{flash.text}</div>}
          {res.data.missing > 0 && (
            <div class="banner warn">
              {tc('urMissing', { n: res.data.missing })}
              <button type="button" class="btn primary" data-testid="create-missing" disabled={sync !== null} onClick={() => void createMissing()}>
                {sync ? tc('urSyncing', { n: sync.done, left: sync.left }) : tc('urCreateMissing')}
              </button>
            </div>
          )}
          {made.length > 0 && (
            <div class="actions">
              <button type="button" class="btn primary" onClick={() => void writeXlsx('new_logins.xlsx', [tc('ppName'), t('username'), tc('urFirstPw')], made)}>{tc('urDownloadNew', { n: made.length })}</button>
            </div>
          )}
          <div class="toolbar">
            <input type="search" aria-label={t('adUserSearch')} placeholder={tc('urSearch')} value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ flex: 1, maxWidth: '380px' }} />
            <span class="spacer" />
            <button type="button" class="btn" onClick={() => setAdding(!adding)}>{tc('urAddTitle')}</button>
            <button type="button" class="btn" data-testid="dl-logins" onClick={downloadLogins}>{tc('urDownload')}</button>
          </div>
          {adding && <AddAccount taken={new Set(accounts.map((a) => a.username))} positions={posList} onPositions={setPositions} onDone={(m) => { setAdding(false); setFlash({ ok: true, text: m }); res.reload(); }} />}
          <div class="tablewrap" style={{ maxHeight: '620px' }}>
            <table class="ad-table">
              <thead><tr>
                <th>{tc('ppName')}</th><th>{t('username')}</th><th>{tc('urRoles')}</th><th>{tc('status')}</th>
                <th>{tc('urFirstPw')}</th><th>{tc('urLastLogin')}</th><th />
              </tr></thead>
              <tbody>
                {shown.map((a) => {
                  const self = me?.id === a.id;
                  return (
                    <>
                      <tr key={a.id} data-testid="user-row">
                        <td><b>{a.name}</b></td>
                        <td><code>{a.username}</code></td>
                        <td>{a.roles.length ? a.roles.map((r, i) => <span key={i} class={`status ${r.kind === 'admin' ? 'ok' : 'muted'}`} style={{ margin: '1px' }}>{roleText(r)}</span>) : a.position ? null : '—'}
                          {a.position && <span class="status muted" style={{ margin: '1px' }}>{a.position}</span>}</td>
                        <td><span class={`status ${STATUS[a.status][1]}`} data-testid="user-status">{statusText(a.status)}</span></td>
                        <td>{a.firstPw ? <code data-testid="first-pw">{a.firstPw}</code> : <span class="muted">{tc('urChangedByUser')}</span>}</td>
                        <td class="muted">{a.lastLogin ? fmtDateTime(a.lastLogin, lang) : '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {a.status === 'locked' && <button type="button" class="btn link" onClick={() => void unlock(a)}>{tc('urUnlock')}</button>}
                          {!self && (arm === a.id
                            ? <button type="button" class="btn link" onClick={() => void reset(a)}>{tc('urConfirmReset')}</button>
                            : <button type="button" class="btn link" onClick={() => setArm(a.id)}>{tc('urReset')}</button>)}
                          <button type="button" class="btn link" onClick={() => { setEditing(editing === a.id ? null : a.id); setSetting(null); }}>{tc('urEdit')}</button>
                          <button type="button" class="btn link" onClick={() => { setSetting(setting === a.id ? null : a.id); setEditing(null); }}>{tc('urChangePw')}</button>
                          {!self && <button type="button" class={`btn link${a.active ? ' danger' : ''}`} onClick={() => void toggle(a)}>{a.active ? t('adDisable') : t('adEnable')}</button>}
                          {!self && (armDel === a.id
                            ? <button type="button" class="btn link danger" data-testid="confirm-delete" onClick={() => void remove(a)}>{tc('urConfirmDelete')}</button>
                            : <button type="button" class="btn link danger" onClick={() => setArmDel(a.id)}>{tc('urDelete')}</button>)}
                        </td>
                      </tr>
                      {editing === a.id && (
                        <tr key={`e${a.id}`}><td colSpan={7}><EditAccount a={a} taken={new Set(accounts.map((x) => x.username))} onDone={(m) => { setEditing(null); if (m) setFlash({ ok: true, text: m }); res.reload(); }} /></td></tr>
                      )}
                      {setting === a.id && (
                        <tr key={`p${a.id}`}><td colSpan={7}><SetPassword a={a} onDone={(m) => { setSetting(null); if (m) setFlash({ ok: true, text: m }); res.reload(); }} /></td></tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
