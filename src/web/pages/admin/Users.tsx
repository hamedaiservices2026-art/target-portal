// Admin: users. Create, edit, disable/enable, reset password. The API never returns password hashes.
import { useState } from 'preact/hooks';
import type { UserDto } from '../../../worker/services/masters';
import { api } from '../../api';
import { ConfirmButton, errText, Field, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { t, useLang } from '../../i18n';
import { useSession } from '../../session';

type Form = { username: string; name: string; email: string; role: 'admin' | 'manager'; lang: 'en' | 'ar'; password: string };
const EMPTY: Form = { username: '', name: '', email: '', role: 'manager', lang: 'ar', password: '' };

function validate(f: Form, creating: boolean): string | null {
  if (!f.username.trim() || /\s/.test(f.username.trim())) return t('adUserErrUsername');
  if (!f.name.trim()) return t('adUserErrName');
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(f.email.trim())) return t('adUserErrEmail');
  if (creating && f.password.length < 8) return t('adPasswordShort');
  return null;
}

function UserForm({ editing, me, onDone }: { editing: UserDto | null; me: number | undefined; onDone: (msg: string) => void }) {
  useLang();
  const [f, setF] = useState<Form>(editing
    ? { username: editing.username, name: editing.name, email: editing.email ?? '', role: editing.role, lang: editing.lang, password: '' }
    : EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const self = editing !== null && editing.id === me;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: Event) {
    e.preventDefault();
    const problem = validate(f, !editing);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    try {
      const body = { username: f.username.trim(), name: f.name.trim(), email: f.email.trim() || null, role: f.role, lang: f.lang };
      if (editing) await api('PATCH', `/api/admin/users/${editing.id}`, body);
      else await api('POST', '/api/admin/users', { ...body, password: f.password });
      onDone(editing ? t('adSaved') : t('adUserCreated'));
    } catch (x) {
      setErr(errText(x));
      setBusy(false);
    }
  }

  return (
    <form class="card ad-form" onSubmit={submit} data-testid="user-form" noValidate>
      <h2>{editing ? t('adUserEdit') : t('adUserAdd')}</h2>
      <div class="grid">
        <Field id="u-username" label={t('username')} hint={t('adUserUsernameHint')}>
          <input id="u-username" value={f.username} autocomplete="off" onInput={(e) => set('username', e.currentTarget.value)} />
        </Field>
        <Field id="u-name" label={t('adFullName')}>
          <input id="u-name" value={f.name} onInput={(e) => set('name', e.currentTarget.value)} />
        </Field>
        <Field id="u-email" label={t('adEmail')} hint={t('adOptional')}>
          <input id="u-email" type="email" value={f.email} onInput={(e) => set('email', e.currentTarget.value)} />
        </Field>
        <Field id="u-role" label={t('adRole')} hint={self ? t('adUserSelfRole') : t('adRoleHint')}>
          <select id="u-role" value={f.role} disabled={self} onChange={(e) => set('role', e.currentTarget.value as Form['role'])}>
            <option value="manager">{t('roleManager')}</option>
            <option value="admin">{t('roleAdmin')}</option>
          </select>
        </Field>
        <Field id="u-lang" label={t('adLanguage')}>
          <select id="u-lang" value={f.lang} onChange={(e) => set('lang', e.currentTarget.value as Form['lang'])}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </Field>
        {!editing && (
          <Field id="u-password" label={t('password')} hint={t('adPasswordHint')}>
            <input id="u-password" type="password" autocomplete="new-password" value={f.password} onInput={(e) => set('password', e.currentTarget.value)} />
          </Field>
        )}
      </div>
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="actions">
        <button type="submit" class="btn primary" disabled={busy}>{busy ? t('dsSaving') : t('adUserSave')}</button>
        <button type="button" class="btn" onClick={() => onDone('')}>{t('dsCancel')}</button>
      </div>
    </form>
  );
}

function ResetPassword({ user, onDone }: { user: UserDto; onDone: (msg: string) => void }) {
  useLang();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: Event) {
    e.preventDefault();
    if (pw.length < 8) return setErr(t('adPasswordShort'));
    setBusy(true);
    try {
      await api('POST', `/api/admin/users/${user.id}/password`, { password: pw });
      onDone(t('adPasswordReset'));
    } catch (x) {
      setErr(errText(x));
      setBusy(false);
    }
  }
  return (
    <form class="inline-form" onSubmit={submit}>
      <label for={`pw-${user.id}`}>{t('adNewPasswordFor')} {user.username}</label>
      <input id={`pw-${user.id}`} type="password" autocomplete="new-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} />
      <button type="submit" class="btn primary" disabled={busy}>{t('adPasswordSet')}</button>
      <button type="button" class="btn" onClick={() => onDone('')}>{t('dsCancel')}</button>
      <small class="muted">{t('adPasswordHint')} {t('adPasswordSignsOut')}</small>
      {err && <div class="alert" role="alert">{err}</div>}
    </form>
  );
}

export function Users() {
  useLang();
  const { user: me } = useSession();
  const res = useResource<{ users: UserDto[] }>('/api/admin/users');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<'new' | number | null>(null);
  const [resetting, setResetting] = useState<number | null>(null);
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const done = (msg: string) => {
    setForm(null);
    setResetting(null);
    if (msg) setFlash(msg);
    res.reload();
  };
  async function setActive(u: UserDto, active: boolean) {
    setErr(null);
    try {
      await api('PATCH', `/api/admin/users/${u.id}`, { active });
      setFlash(active ? t('adUserEnabled') : t('adUserDisabled'));
      res.reload();
    } catch (x) {
      setErr(errText(x));
    }
  }

  const needle = q.trim().toLowerCase();
  const users = (res.data?.users ?? []).filter((u) =>
    !needle || [u.username, u.name, u.email ?? ''].some((s) => s.toLowerCase().includes(needle)));
  const editing = typeof form === 'number' ? res.data?.users.find((u) => u.id === form) ?? null : null;

  return (
    <section data-testid="admin-users">
      <PageHead title={t('navUsers')} intro={t('adUsersIntro')}>
        <button type="button" class="btn primary" onClick={() => { setFlash(''); setForm('new'); }}>{t('adUserAddBtn')}</button>
      </PageHead>
      {flash && <div class="banner ok" role="status">{flash}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      {form !== null && <UserForm key={String(form)} editing={editing} me={me?.id} onDone={done} />}
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {!res.data && !res.error && <p class="muted">{t('loading')}</p>}
      {res.data && (
        <>
          <div class="toolbar">
            <div class="search">
              <input type="search" aria-label={t('adUserSearch')} placeholder={t('adUserSearch')} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
            </div>
          </div>
          <div class="tablewrap">
            <table class="ad-table">
              <thead>
                <tr>
                  <th class="s">{t('username')}</th><th class="s">{t('adFullName')}</th><th class="s">{t('adEmail')}</th>
                  <th class="s">{t('adRole')}</th><th class="s">{t('adLanguage')}</th><th class="s">{t('adStatus')}</th>
                  <th class="s">{t('adActions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && <tr><td class="empty" colSpan={7}>{t('adNothingFound')}</td></tr>}
                {users.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <>
                      <tr key={u.id} data-testid="user-row" class={u.active ? '' : 'off'}>
                        <td class="s">{u.username}</td>
                        <td class="s">{u.name}</td>
                        <td class="s">{u.email ?? '—'}</td>
                        <td class="s">{u.role === 'admin' ? t('roleAdmin') : t('roleManager')}</td>
                        <td class="s">{u.lang === 'ar' ? 'العربية' : 'English'}</td>
                        <td class="s">
                          <span class={`status ${u.active ? 'ok' : 'bad'}`} data-testid="user-status">{u.active ? t('adActive') : t('adDisabled')}</span>
                        </td>
                        <td class="s act">
                          <button type="button" class="btn" onClick={() => { setFlash(''); setForm(u.id); }}>{t('adEdit')}</button>
                          <button type="button" class="btn" onClick={() => { setFlash(''); setResetting(u.id); }}>{t('adResetPassword')}</button>
                          {u.active ? (
                            <ConfirmButton
                              label={t('adDisable')}
                              question={`${t('adDisable')} ${u.username}?`}
                              yesLabel={t('adDisableYes')}
                              disabled={self}
                              title={self ? t('adUserSelfLock') : undefined}
                              onConfirm={() => setActive(u, false)}
                            />
                          ) : (
                            <button type="button" class="btn" onClick={() => setActive(u, true)}>{t('adEnable')}</button>
                          )}
                        </td>
                      </tr>
                      {resetting === u.id && (
                        <tr key={`r${u.id}`}><td colSpan={7} class="s"><ResetPassword user={u} onDone={done} /></td></tr>
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
