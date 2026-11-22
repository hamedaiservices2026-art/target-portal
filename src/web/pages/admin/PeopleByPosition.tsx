// Admin › Users: everyone in the sales hierarchy by position (Commercial
// Director, Channel Head, Sales Manager, Sales Supervisor), with the sign-in
// account each one is linked to. Missing accounts can be created in one go
// (one request per user, since each password is hashed on its own).
import { useMemo, useState } from 'preact/hooks';
import type { UserDto } from '../../../worker/services/masters';
import type { PersonDto, Position } from '../../../worker/services/hierarchySync';
import { api } from '../../api';
import { errText, LoadError, useResource } from '../../components/AdminBits';
import { writeXlsx } from '../../excel';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';

const POS_KEY = { cd: 'ppCd', head: 'ppHead', manager: 'ppManager', supervisor: 'ppSupervisor' } as const;

/** A username from a name: first letter + last word, lower case, ASCII only, made unique. */
export function usernameFor(name: string, taken: Set<string>): string {
  const words = name.normalize('NFKD').replace(/[^\w\s]/g, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? `${words[0]![0]}${words[words.length - 1]}` : words[0] ?? '';
  base = base.replace(/[^a-z0-9_]/g, '') || 'user';
  let u = base;
  for (let i = 2; taken.has(u); i++) u = `${base}${i}`;
  taken.add(u);
  return u;
}

function password(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint32Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}

export function PeopleByPosition({ users, onUsersChanged }: { users: UserDto[]; onUsersChanged: () => void }) {
  useLang();
  const res = useResource<{ people: PersonDto[] }>('/api/admin/people');
  const [pos, setPos] = useState<Position | ''>('');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<string[][] | null>(null);

  const people = res.data?.people ?? [];
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return people.filter((p) => (!pos || p.position === pos) && (!s || `${p.name} ${p.dept ?? ''} ${p.parent ?? ''}`.toLowerCase().includes(s)));
  }, [people, pos, q]);
  const counts = useMemo(() => {
    const c: Record<Position, number> = { cd: 0, head: 0, manager: 0, supervisor: 0 };
    for (const p of people) c[p.position]++;
    return c;
  }, [people]);
  const linkable = users.filter((u) => u.active && (u.role === 'manager' || u.role === 'admin'));
  const userName = new Map(users.map((u) => [u.id, `${u.name} (${u.username})`]));
  // A name can sit on several nodes (e.g. Head and Manager): one account for all of them.
  const missing = shown.filter((p) => p.nodeId !== null && p.userId === null);

  async function link(p: PersonDto, userId: number | null) {
    setMsg(null);
    try {
      await api('PATCH', `/api/admin/nodes/${p.nodeId}`, { managerUserId: userId });
      setMsg({ ok: true, text: tc('ppLinked') });
      res.reload();
    } catch (x) {
      setMsg({ ok: false, text: errText(x) });
    }
  }

  async function createAll() {
    setMsg(null);
    setCreated(null);
    const taken = new Set(users.map((u) => u.username.toLowerCase()));
    const byName = new Map(users.filter((u) => u.active).map((u) => [u.name.trim().toLowerCase(), u.id]));
    const out: string[][] = [];
    try {
      for (let i = 0; i < missing.length; i++) {
        const p = missing[i]!;
        setBusy(tc('ppCreating', { i: i + 1, n: missing.length }));
        const key = p.name.trim().toLowerCase();
        let id = byName.get(key);
        if (id === undefined) {
          const username = usernameFor(p.name, taken);
          const pw = password();
          const r = await api<{ user: UserDto }>('POST', '/api/admin/users', { username, name: p.name.trim(), role: 'manager', lang: 'en', password: pw });
          id = r.user.id;
          byName.set(key, id);
          out.push([p.name, tc(POS_KEY[p.position]), p.dept ?? '', username, pw]);
        }
        await api('PATCH', `/api/admin/nodes/${p.nodeId}`, { managerUserId: id });
      }
      setMsg({ ok: true, text: tc('ppCreated', { n: out.length }) });
    } catch (x) {
      setMsg({ ok: false, text: errText(x) });
    } finally {
      setBusy(null);
      setCreated(out.length ? out : null);
      res.reload();
      onUsersChanged();
    }
  }

  if (res.error) return <LoadError message={res.error} onRetry={res.reload} />;
  return (
    <div class="card ad-card" data-testid="people-by-position">
      <h2>{tc('ppTitle')}</h2>
      <p class="small">{tc('ppIntro')}</p>
      <div class="toolbar">
        <div class="seg" role="group" aria-label={tc('ppPosition')}>
          <button type="button" class={`btn${pos === '' ? ' primary' : ''}`} aria-pressed={pos === ''} onClick={() => setPos('')}>{tc('ppAll')} ({fmtNum(people.length)})</button>
          {(Object.keys(POS_KEY) as Position[]).map((k) => (
            <button key={k} type="button" class={`btn${pos === k ? ' primary' : ''}`} aria-pressed={pos === k} data-testid={`pp-${k}`} onClick={() => setPos(k)}>
              {tc(POS_KEY[k])} ({fmtNum(counts[k])})
            </button>
          ))}
        </div>
        <input type="search" aria-label={tc('ppSearch')} placeholder={tc('ppSearch')} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {msg && <div class={msg.ok ? 'banner ok' : 'alert'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      {created && (
        <div class="actions">
          <button type="button" class="btn primary" data-testid="pp-download"
            onClick={() => void writeXlsx('new_accounts.xlsx', [tc('ppName'), tc('ppPosition'), tc('ppDept'), 'Username', 'Password'], created)}>
            {tc('ppDownload')}
          </button>
        </div>
      )}
      {missing.length > 0 && (
        <div class="actions">
          <span class="status warn">{tc('ppWithout', { n: fmtNum(missing.length) })}</span>
          <button type="button" class="btn" data-testid="pp-create" disabled={busy !== null} onClick={() => void createAll()}>
            {busy ?? tc('ppCreate', { n: fmtNum(missing.length) })}
          </button>
        </div>
      )}
      {res.data === null ? <p class="muted" role="status">{tc('loading')}</p> : shown.length === 0 ? <p class="muted">{tc('ppNone')}</p> : (
        <div class="tablewrap"><table class="ad-table" data-testid="pp-table">
          <thead><tr>
            <th>{tc('ppPosition')}</th><th>{tc('ppName')}</th><th>{tc('ppDept')}</th><th>{tc('ppReportsTo')}</th>
            <th class="num">{tc('routes')}</th><th>{tc('ppAccount')}</th>
          </tr></thead>
          <tbody>{shown.map((p) => (
            <tr key={p.nodeId ?? `cd-${p.userId}`} data-testid="pp-row">
              <td>{tc(POS_KEY[p.position])}</td>
              <td>{p.name}</td>
              <td>{p.position === 'cd' ? `${tc('ppWorkspaces')}: ${(p.workspaces ?? []).map((w) => (w === 'ka' ? tc('wsKa') : tc('wsOps'))).join(', ')}` : p.dept ?? '—'}</td>
              <td>{p.parent ?? '—'}</td>
              <td class="num">{p.position === 'cd' ? '' : fmtNum(p.routes)}</td>
              <td>
                {p.nodeId === null ? userName.get(p.userId!) ?? '—' : (
                  <select aria-label={`${tc('ppAccount')} ${p.name}`} value={p.userId ?? ''} onChange={(e) => { const v = e.currentTarget.value; void link(p, v ? Number(v) : null); }}>
                    <option value="">{tc('ppNoAccount')}</option>
                    {linkable.map((u) => <option key={u.id} value={u.id}>{`${u.name} (${u.username})`}</option>)}
                  </select>
                )}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
