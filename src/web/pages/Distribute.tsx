// Manager distribution screen (spec section 9, mockup v4): rebalance the
// node's locked per-pack totals between its direct team members under the cap.
//
// Cells hold the text as typed; parseCaseInput turns it into cases (invalid
// text, including an empty cell, is never treated as 0). Live checks run with
// the same checkPack the server uses. Edits are mirrored to sessionStorage
// under draft:{mid}:{nid}:{version} so an expired session (or a reload) does
// not lose them; the mirror is restored when the same version is loaded again.
import { useLocation } from 'preact-iso';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { checkPack, parseCaseInput, type PackCheck } from '../../shared/rules';
import type { PackGroup } from '../../shared/types';
import type { Workspace } from '../../worker/services/distribution';
import { api, ApiError } from '../api';
import { DistributionTable, type Member, type PackInfo, type TableGroup } from '../components/DistributionTable';
import { emptyFilters, parseNumFilter, type FilterLabels, type FilterState } from '../components/Filters';
import { GroupTabs, type GroupTab } from '../components/GroupTabs';
import { statusText } from '../components/StatusBadge';
import { StatusPill } from '../components/StatusPill';
import { fmtDeadline, fmtPeriod } from '../format';
import { fmtNum, t, tf, useLang, type TextKey } from '../i18n';
import { BenchControls, ByCategory, SalesmanPanel, useBench } from './cycle/DistributeExtras';
import { tc } from '../cycle/i18n';

const GROUPS: PackGroup[] = ['CSD', 'Water', 'LRB-Others'];

type Raw = Record<string, string[]>;
type Mirror = Record<string, Record<string, string>>;

// ---------- sessionStorage mirror ----------

const mirrorPrefix = (mid: string, nid: string) => `draft:${mid}:${nid}:`;
const mirrorKey = (mid: string, nid: string, version: number) => `${mirrorPrefix(mid, nid)}${version}`;

function readMirror(key: string): Mirror | null {
  try {
    const s = sessionStorage.getItem(key);
    if (!s) return null;
    const m = JSON.parse(s) as unknown;
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Mirror) : null;
  } catch {
    return null;
  }
}

function writeMirror(key: string, m: Mirror): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(m));
  } catch { /* storage full or blocked: the edits just are not mirrored */ }
}

/** Removes this node's mirrors, except `keep`. */
function clearMirrors(mid: string, nid: string, keep?: string): void {
  try {
    const prefix = mirrorPrefix(mid, nid);
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(prefix) && k !== keep) doomed.push(k);
    }
    doomed.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

// ---------- formatting ----------

function rawFromServer(w: Workspace): Raw {
  return Object.fromEntries(w.packs.map((p) => [p.code, w.children.map((c) => String(c.values[p.code] ?? 0))]));
}

// ---------- page ----------

export function Distribute({ mid = '', nid = '' }: { mid?: string; nid?: string }) {
  const { route } = useLocation();
  const [lang] = useLang();
  const [ws, setWs] = useState<Workspace | null>(null);
  const bench = useBench(ws, mid, nid);
  const [loadErr, setLoadErr] = useState<TextKey | null>(null);
  const [raw, setRaw] = useState<Raw>({});
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<TextKey | null>(null);
  const [restored, setRestored] = useState(false);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState<Record<string, PackCheck> | null>(null);
  const [error, setError] = useState<TextKey | null>(null);
  const [noRoutesNode, setNoRoutesNode] = useState<string | null>(null);

  const [tab, setTab] = useState<GroupTab>('all');
  const [q, setQ] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<FilterState>(() => emptyFilters(0));

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const w = await api<Workspace>('GET', `/api/months/${mid}/nodes/${nid}`);
      const server = rawFromServer(w);
      let r = server;
      let back = false;
      const key = mirrorKey(mid, nid, w.version);
      clearMirrors(mid, nid, w.editable ? key : undefined);
      const m = w.editable ? readMirror(key) : null;
      if (m) {
        r = Object.fromEntries(Object.entries(server).map(([p, arr]) => [p, arr.map((v, i) => {
          const saved = m[w.children[i]!.key]?.[p];
          return typeof saved === 'string' ? saved : v;
        })]));
        back = Object.keys(r).some((p) => r[p]!.some((v, i) => v !== server[p]![i]));
        if (!back) clearMirrors(mid, nid);
      }
      setWs(w);
      setVersion(w.version);
      setRaw(r);
      setDirty(back);
      setRestored(back);
      setStale(false);
      setFailed(null);
      setError(null);
      setLoadErr(null);
      setConfirming(false);
      setFilters((f) => (f.members.length === w.children.length ? f : emptyFilters(w.children.length)));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false; // the app goes to /login
      // Not this person's team (a link or a page left open by someone else): their own Home instead.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) { route('/', true); return false; }
      setLoadErr('dsLoadError');
      return false;
    }
  }, [mid, nid]);

  useEffect(() => {
    setWs(null);
    void load();
  }, [load]);

  // ---- derived, per workspace ----
  const codes = useMemo(() => (ws ? ws.packs.map((p) => p.code) : []), [ws]);
  const packIdx = useMemo(() => Object.fromEntries(codes.map((c, i) => [c, i])), [codes]);
  const totals = useMemo<Record<string, number>>(() => (ws ? { ...ws.totals } : {}), [ws]);
  const starts = useMemo<Record<string, number[]>>(
    () => (ws ? Object.fromEntries(codes.map((p) => [p, ws.children.map((c) => c.starts[p] ?? 0)])) : {}),
    [ws, codes],
  );
  const ordered = useMemo(() => {
    const byGroup = new Map<PackGroup, string[]>(GROUPS.map((g) => [g, []]));
    if (ws) {
      const sorted = [...ws.packs].sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      for (const p of sorted) (byGroup.get(p.grp as PackGroup) ?? byGroup.get('LRB-Others')!).push(p.code);
    }
    return byGroup;
  }, [ws]);
  const members = useMemo<Member[]>(() => (ws ? ws.children.map((c) => {
    const leaf = c.key.startsWith('l:');
    const title = leaf ? `${ws.node.workspace === 'ka' ? 'KAE' : t('dsRoute')} ${c.label}` : c.label;
    const sub = leaf ? (c.sub ? `${t('dsSalesman')} ${c.sub}` : '') : c.sub;
    return { key: c.key, title, sub, aria: sub ? `${title} · ${sub}` : title };
  }) : []), [ws, lang]);

  // Visible member columns: a search that matches a member (route, salesman,
  // node or manager name) shows only those columns. Memoized so pack rows keep
  // the same `vis` array while typing in a cell.
  const [vis, memberHit] = useMemo((): [number[], boolean] => {
    const needle = q.trim().toLowerCase();
    const hits = needle ? members.map((m, i) => (`${m.title} ${m.sub}`.toLowerCase().includes(needle) ? i : -1)).filter((i) => i >= 0) : [];
    return hits.length ? [hits, true] : [members.map((_m, i) => i), false];
  }, [members, q]);

  const ruleOpts = useMemo(() => (ws ? {
    rule2: ws.rules.rule2, rule3: ws.rules.rule3, personCapPct: ws.rules.personCapPct.map((x) => x ?? undefined), personBase: ws.rules.base,
  } : {}), [ws]);

  // Per-pack checks, cached by the identity of the pack's raw array: an edit
  // replaces one pack's array, so only that pack is re-checked.
  const cache = useMemo(() => new WeakMap<string[], PackInfo>(), [ws]);
  const info = useCallback((pack: string): PackInfo => {
    const r = raw[pack] ?? [];
    let hit = cache.get(r);
    if (!hit) {
      const nums = r.map((v) => parseCaseInput(v) ?? Number.NaN);
      const invalid = nums.map((n) => Number.isNaN(n));
      hit = {
        nums, invalid, anyInvalid: invalid.some(Boolean),
        check: checkPack(totals[pack] ?? 0, starts[pack] ?? [], nums, ws?.capPct ?? 0, ruleOpts),
      };
      cache.set(r, hit);
    }
    return hit;
  }, [raw, cache, totals, starts, ws, ruleOpts]);

  // Mirror unsaved edits for this version.
  useEffect(() => {
    if (!ws || !ws.editable || !dirty) return;
    const m: Mirror = {};
    ws.children.forEach((c, i) => {
      m[c.key] = Object.fromEntries(codes.map((p) => [p, raw[p]?.[i] ?? '']));
    });
    writeMirror(mirrorKey(mid, nid, version), m);
  }, [raw, dirty, version, ws]);

  // ---- edits ----
  const touched = () => {
    setDirty(true);
    setNotice(null);
    setFailed(null);
  };
  const onCell = useCallback((pack: string, i: number, value: string) => {
    setRaw((prev) => ({ ...prev, [pack]: (prev[pack] ?? []).map((v, j) => (j === i ? value : v)) }));
    touched();
  }, []);
  const onCommit = useCallback((pack: string, i: number) => {
    // Show what was understood: "٣٥٠" or "1,200" becomes 350 / 1200.
    setRaw((prev) => {
      const v = prev[pack]?.[i] ?? '';
      const n = parseCaseInput(v);
      if (n === null || String(n) === v) return prev;
      return { ...prev, [pack]: prev[pack]!.map((x, j) => (j === i ? String(n) : x)) };
    });
  }, []);
  const onReset = useCallback((pack: string) => {
    setRaw((prev) => ({ ...prev, [pack]: (starts[pack] ?? []).map(String) }));
    touched();
  }, [starts]);
  const onToggle = useCallback((g: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  if (loadErr) {
    return (
      <section class="card">
        <h1>{t('distributeTitle')}</h1>
        <div class="alert" role="alert">{t(loadErr)}</div>
        <p><button type="button" class="btn" onClick={() => void load()}>{t('dsRetry')}</button></p>
      </section>
    );
  }
  if (!ws) {
    return (
      <section class="card">
        <h1>{t('distributeTitle')}</h1>
        <p class="muted">{t('loading')}</p>
      </section>
    );
  }

  // ---- live state over all packs (cached per pack) ----
  let passing = 0;
  let counted = 0;
  let allOk = true;
  let anyInvalid = false;
  for (const p of codes) {
    const inf = info(p);
    if (!inf.check.ok) allOk = false;
    if (inf.anyInvalid) anyInvalid = true;
    if ((totals[p] ?? 0) > 0) {
      counted++;
      if (inf.check.ok) passing++;
    }
  }
  const grandTotal = codes.reduce((a, p) => a + (totals[p] ?? 0), 0);
  const leafTeam = ws.children.length > 0 && ws.children.every((c) => c.key.startsWith('l:'));

  // ---- search and filters ----
  const s = q.trim().toLowerCase();
  const fTgt = parseNumFilter(filters.tgt);
  const fMoved = parseNumFilter(filters.moved);
  const fMembers = filters.members.map(parseNumFilter);
  const fPack = filters.pack.trim().toLowerCase();
  const passes = (p: string): boolean => {
    const lower = p.toLowerCase();
    if (s && !memberHit && !lower.includes(s)) return false;
    if (fPack && !lower.includes(fPack)) return false;
    const inf = info(p);
    if (!fTgt(totals[p] ?? 0)) return false;
    for (const i of vis) if (!(fMembers[i] ?? (() => true))(inf.nums[i] ?? Number.NaN)) return false;
    if (!fMoved(inf.check.moved)) return false;
    if (filters.status === 'ok' && !inf.check.ok) return false;
    if (filters.status === 'bad' && inf.check.ok) return false;
    return true;
  };
  const groups: TableGroup[] = GROUPS.filter((g) => tab === 'all' || g === tab).map((grp) => {
    const all = (ordered.get(grp) ?? []).filter((p) => !(hideZero && (totals[p] ?? 0) === 0));
    return { grp, all, shown: all.filter(passes) };
  });

  const filterLabels: FilterLabels = {
    text: t('dsFilterText'), num: t('dsFilterNum'), label: (col) => tf('dsFilterLabel', { col }),
    pack: t('dsColPack'), target: t('dsColTarget'), moved: t('dsColMoved'), status: t('dsColStatus'),
    all: t('dsAll'), ok: t('dsOk'), problems: t('dsProblems'),
  };

  // ---- save / submit ----
  const editable = ws.editable;
  const canSave = editable && !stale && busy === null && !anyInvalid;
  // A supervisor submits only once every route has a salesman ID.
  const noSalesman = ws.node.level === 'head' || ws.node.workspace === 'ka' ? [] : ws.children.filter((c) => c.key.startsWith('l:') && !c.sub?.trim()).map((c) => c.label);
  const canSubmit = canSave && allOk && noSalesman.length === 0;

  function handleError(e: unknown) {
    if (e instanceof ApiError) {
      if (e.status === 401) return; // the app goes to /login; the mirror keeps the edits
      if (e.status === 409) return setStale(true);
      if (e.status === 400 && e.body.error === 'rules_failed' && e.body.byPack && typeof e.body.byPack === 'object') {
        return setFailed(e.body.byPack as Record<string, PackCheck>);
      }
      if (e.status === 400 && e.body.error === 'salesman_missing') {
        void load();
        return setError('errGeneric');
      }
      if (e.status === 400 && e.body.error === 'no_routes' && typeof e.body.node === 'string') {
        setNoRoutesNode(e.body.node);
        return setError('errNoRoutes');
      }
      return setError('errGeneric');
    }
    setError('errNetwork');
  }

  /** PUT the draft; returns the new version. */
  async function putDraft(): Promise<number> {
    const values = Object.fromEntries(ws!.children.map((c, i) => [c.key, Object.fromEntries(codes.map((p) => [p, info(p).nums[i]!]))]));
    const res = await api<{ version: number }>('PUT', `/api/months/${mid}/nodes/${nid}/draft`, { values, version });
    clearMirrors(mid, nid);
    setDirty(false);
    setRestored(false);
    setVersion(res.version);
    return res.version;
  }

  async function onSave() {
    if (!canSave) return;
    setBusy('save');
    setNotice(null);
    setError(null);
    try {
      await putDraft();
      setNotice('dsSaved');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  async function onSubmit() {
    if (!canSubmit) return;
    setConfirming(false);
    setBusy('submit');
    setNotice(null);
    setError(null);
    try {
      // Submit sends the saved draft: save what is on screen first.
      const v = await putDraft();
      await api('POST', `/api/months/${mid}/nodes/${nid}/submit`, { version: v });
      clearMirrors(mid, nid);
      if (await load()) setNotice('dsSubmitted');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  function onDiscard() {
    clearMirrors(mid, nid);
    setRaw(rawFromServer(ws!));
    setDirty(false);
    setRestored(false);
  }

  const readOnlyKey: TextKey | null = editable ? null
    : ws.node.status === 'submitted' ? 'dsRoSubmitted' : ws.node.status === 'waiting' ? 'dsRoWaiting' : 'dsRoView';
  const failedPacks = failed ? Object.entries(failed).filter(([, c]) => !c.ok) : [];

  return (
    <section class="distribute">
      <div class="ds-head">
        <div>
          <p class="crumbs muted">
            {fmtPeriod(ws.month.period, lang)} › {ws.node.deptCode} › {ws.node.name}
          </p>
          <h1>{t('distributeTitle')}</h1>
        </div>
        <StatusPill status={ws.node.status} testId="node-status" />
        <a class="btn" href={`/m/${mid}/n/${nid}/branch`}>{t('viewBranch')}</a>
      </div>

      <div class="summary">
        <div class="card">
          <div class="k">{t('dsMyTarget')}<span class="lock">{t('dsLocked')}</span></div>
          <div class="v">{fmtNum(grandTotal)} <small>{t('dsCases')}</small></div>
        </div>
        <div class="card">
          <div class="k">{t('dsTeam')}</div>
          <div class="v">{fmtNum(ws.children.length)} <small>{t(leafTeam ? 'dsSalesmen' : 'dsMembers')}</small></div>
        </div>
        <div class="card">
          <div class="k">{t('dsCap')}</div>
          <div class="v">{ws.rules.capOn === false ? <small data-testid="cap-off">{tc('capOffShort')}</small> : <><bdi>{ws.capPct}%</bdi> <small>{t('dsCapSub')}</small></>}</div>
        </div>
        <div class="card">
          <div class="k">{t('dsPassing')}</div>
          <div class="v" data-testid="passing">{fmtNum(passing)} <small>{t('dsOf')} {fmtNum(counted)}</small></div>
        </div>
        <div class="card">
          <div class="k">{t('dsDeadline')}</div>
          <div class="v" data-testid="deadline">{fmtDeadline(ws.month.deadline, lang)}</div>
        </div>
      </div>

      <p class="legend">
        <span><b>{t('dsRule1h')}</b> {t('dsRule1')}</span>
        {ws.rules.rule2 && <span><b>{t('dsRule2h')}</b> {t('dsRule2')}</span>}
        {ws.rules.rule3 && <span><b>{t('dsRule3h')}</b> {t('dsRule3')}</span>}
      </p>

      {readOnlyKey && <div class="banner info" data-testid="read-only">{t(readOnlyKey)}</div>}
      {stale && (
        <div class="banner bad" role="alert" data-testid="stale-banner">
          <b>{t('dsStale')}</b> <span>{t('dsStaleText')}</span>
          <button type="button" class="btn" onClick={() => void load()}>{t('dsReload')}</button>
        </div>
      )}
      {restored && (
        <div class="banner warn" role="status" data-testid="restored-notice">
          <span>{t('dsRestored')}</span>
          <button type="button" class="btn link" onClick={onDiscard}>{t('dsDiscard')}</button>
        </div>
      )}
      {failed && (
        <div class="banner bad" role="alert" data-testid="rules-failed">
          <b>{t('dsRulesFailed')}</b>
          <ul>{failedPacks.map(([p, c]) => <li key={p}><bdi>{p}</bdi>: {statusText(c)}</li>)}</ul>
        </div>
      )}
      {error && <div class="alert" role="alert">{error === 'errNoRoutes' ? tf(error, { node: noRoutesNode ?? '' }) : t(error)}</div>}
      {notice && <div class="banner ok" role="status" data-testid="notice">{t(notice)}</div>}

      <GroupTabs value={tab} onChange={setTab} />
      <div class="toolbar">
        <div class="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
          <input
            type="search" value={q} placeholder={t('dsSearch')} aria-label={t('dsSearchLabel')}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        </div>
        <label>
          <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero((e.target as HTMLInputElement).checked)} />
          {' '}{t('dsHideZero')}
        </label>
        <button type="button" class="btn link" onClick={() => setCollapsed(new Set())}>{t('dsExpandAll')}</button>
        <button type="button" class="btn link" onClick={() => setCollapsed(new Set(GROUPS))}>{t('dsCollapseAll')}</button>
        <button type="button" class="btn link" onClick={() => { setFilters(emptyFilters(ws.children.length)); setQ(''); }}>
          {t('dsClearFilters')}
        </button>
        <span class="spacer" />
        {editable && (
          <>
            <button type="button" class="btn" disabled={!canSave} onClick={() => void onSave()}>
              {busy === 'save' ? t('dsSaving') : t('dsSave')}
            </button>
            <button type="button" class="btn primary" disabled={!canSubmit} onClick={() => setConfirming(true)}>
              {busy === 'submit' ? t('dsSubmitting') : ws.node.level === 'head' ? tc('approveSendMgrs') : t('dsSubmit')}
            </button>
          </>
        )}
      </div>
      {editable && noSalesman.length > 0 && (
        <div class="banner warn" role="status" data-testid="salesman-missing">
          {tc('salesmanMissing', { n: noSalesman.length, list: noSalesman.slice(0, 10).join(', ') + (noSalesman.length > 10 ? '…' : '') })}
        </div>
      )}
      {confirming && editable && (
        <div class="banner warn confirm" role="alertdialog" aria-label={t('dsSubmit')}>
          <span>{t('dsConfirm')}</span>
          <button type="button" class="btn primary" disabled={!canSubmit} onClick={() => void onSubmit()}>{t('dsConfirmYes')}</button>
          <button type="button" class="btn" onClick={() => setConfirming(false)}>{t('dsCancel')}</button>
        </div>
      )}

      <BenchControls ws={ws} b={bench} />
      <ByCategory ws={ws} codes={codes} info={info} totals={totals} editable={editable} bench={bench.fn}
        onApply={(next) => { setRaw((prev) => ({ ...prev, ...next })); touched(); }} />
      {ws.children.some((c) => c.key.startsWith('l:')) && <SalesmanPanel ws={ws} mid={mid} onChanged={() => void load()} />}
      <h2 class="cy-step-title"><span class="n">2</span> {tc('distByPack')}</h2>

      <DistributionTable
        groups={groups} members={members} vis={vis} totals={totals} starts={starts} raw={raw} packIdx={packIdx}
        info={info} collapsed={collapsed} onToggle={onToggle} editable={editable} lang={lang}
        filters={filters} onFilters={setFilters} filterLabels={filterLabels}
        onCell={onCell} onCommit={onCommit} onReset={onReset} bench={bench.fn}
      />
      {editable && <p class="foot">{t('dsFoot')}</p>}
    </section>
  );
}
