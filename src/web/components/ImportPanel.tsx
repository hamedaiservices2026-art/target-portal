// "Import from Excel" for the Users, Packs and Hierarchy screens: template,
// file, server preview (counts + problems by sheet row), then Apply. Nothing is
// written before Apply; the server checks everything again on Apply.
import { useRef, useState } from 'preact/hooks';
import {
  hasErrors, IMPORT_COLUMNS, IMPORT_MAX_ROWS, parseImportSheet,
  type ImportIssue, type ImportKind, type ImportRowOf, type PasswordOp, type UserImportRow,
} from '../../shared/imports';
import { api, ApiError } from '../api';
import { readSheet, writeXlsx } from '../excel';
import { isolate, stagePasswords, templateFor, type Generated } from '../importFlow';
import { fmtNum, t, tf, useLang, type TextKey } from '../i18n';
import { errText, TreeChangeBanner, type TreeChange } from './AdminBits';

type Preview = { create: number; update: number; unchanged: number; issues: ImportIssue[]; pending?: PasswordOp[] };
type Applied = { created: number; updated: number; unchanged: number; treeChange?: TreeChange | null };
type Checked = { fileName: string; rows: ImportRowOf<ImportKind>[]; importId: string; preview: Preview; generated: Generated[] };
type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'passwords'; done: number; total: number }
  | { kind: 'problem'; message: string }
  | { kind: 'checked'; c: Checked }
  | { kind: 'applying'; c: Checked }
  | { kind: 'done'; fileName: string; result: Applied; generated: Generated[] };

const MAX_SHOWN = 200;
const INTRO: Record<ImportKind, TextKey> = { users: 'imIntroUsers', packs: 'imIntroPacks', hierarchy: 'imIntroHierarchy' };
const COLS: Record<ImportKind, TextKey> = { users: 'imColsUsers', packs: 'imColsPacks', hierarchy: 'imColsHierarchy' };

function issueText(i: ImportIssue): string {
  const vars = isolate({ ...(i.column ? { column: i.column } : {}), ...(i.vars ?? {}) });
  return tf(`imIssue_${i.code}` as TextKey, vars);
}

function Issues({ issues, level }: { issues: ImportIssue[]; level: 'error' | 'warning' }) {
  useLang();
  const list = issues.filter((i) => i.level === level);
  if (list.length === 0) return null;
  return (
    <>
      <h3>{level === 'error' ? t('imErrorsTitle') : t('imWarningsTitle')}</h3>
      <div class="tablewrap">
        <table class="ad-table issues">
          <thead><tr><th class="s">{t('imColRow')}</th><th class="s">{t('imColProblem')}</th></tr></thead>
          <tbody>
            {list.slice(0, MAX_SHOWN).map((i, k) => (
              <tr key={k} data-testid={`import-${level}`} class={level === 'error' ? 'issue-bad' : 'issue-warn'}>
                <td class="s">{i.line === null ? t('imWholeFile') : fmtNum(i.line)}</td>
                <td class="s">{issueText(i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > MAX_SHOWN && <p class="muted small">{tf('adMapMoreErrors', { n: fmtNum(list.length - MAX_SHOWN) })}</p>}
    </>
  );
}

function newImportId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export function ImportPanel({ kind, example = {}, onApplied }: {
  kind: ImportKind; example?: { dept?: string; parent?: string }; onApplied: () => void;
}) {
  useLang();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const run = useRef(0);
  const base = `/api/admin/import/${kind}`;

  async function downloadTemplate() {
    const tpl = templateFor(kind, example);
    await writeXlsx(tpl.fileName, tpl.columns, tpl.rows, tpl.kinds);
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // choosing the same file again (after fixing it) runs again
    if (!file) return;
    const me = ++run.current;
    const set = (s: State) => { if (me === run.current) setState(s); };
    set({ kind: 'checking' });
    let sheet: unknown[][];
    try {
      sheet = await readSheet(file);
    } catch {
      return set({ kind: 'problem', message: t('adMapErrUnreadable') });
    }
    const parsed = parseImportSheet(kind, sheet);
    if (!parsed.ok) {
      const message = parsed.reason === 'no_header' ? tf('imErrHeader', { columns: parsed.missing.join(', ') })
        : parsed.reason === 'no_rows' ? t('imErrEmpty')
        : tf('imErrTooMany', { n: fmtNum(parsed.count), max: fmtNum(IMPORT_MAX_ROWS) });
      return set({ kind: 'problem', message });
    }
    const rows = parsed.rows;
    const importId = newImportId();
    const body = kind === 'users' ? { importId, rows } : { rows };
    try {
      let preview = await api<Preview>('POST', `${base}/preview`, body);
      let generated: Generated[] = [];
      if (kind === 'users' && !hasErrors(preview.issues) && preview.pending?.length) {
        const byLine = new Map((rows as UserImportRow[]).map((r) => [r.line, r.password]));
        generated = await stagePasswords(importId, preview.pending, byLine,
          (b) => api('POST', `${base}/password`, b),
          (done, total) => set({ kind: 'passwords', done, total }));
        preview = await api<Preview>('POST', `${base}/preview`, body);
      }
      set({ kind: 'checked', c: { fileName: file.name, rows, importId, preview, generated } });
    } catch (x) {
      set({ kind: 'problem', message: errText(x) });
    }
  }

  async function apply(c: Checked) {
    const me = ++run.current;
    const set = (s: State) => { if (me === run.current) setState(s); };
    set({ kind: 'applying', c });
    try {
      const result = await api<Applied>('POST', `${base}/apply`, kind === 'users' ? { importId: c.importId, rows: c.rows } : { rows: c.rows });
      set({ kind: 'done', fileName: c.fileName, result, generated: c.generated });
      onApplied();
    } catch (x) {
      // The server found problems the preview did not (data changed meanwhile): show them like a preview.
      if (x instanceof ApiError && x.status === 400 && Array.isArray(x.body.issues)) {
        const issues = x.body.issues as ImportIssue[];
        set({ kind: 'checked', c: { ...c, preview: { ...c.preview, issues } } });
      } else set({ kind: 'problem', message: errText(x) });
    }
  }

  async function downloadPasswords(list: Generated[]) {
    await writeXlsx('generated-passwords.xlsx', ['Username', 'Password'], list.map((g) => [g.username, g.password]), ['string', 'string']);
  }

  const busy = state.kind === 'checking' || state.kind === 'passwords' || state.kind === 'applying';
  const c = state.kind === 'checked' || state.kind === 'applying' ? state.c : null;
  const errors = c ? hasErrors(c.preview.issues) : false;
  const changes = c ? c.preview.create + c.preview.update : 0;
  const inputId = `import-file-${kind}`;

  return (
    <div class="card ad-card import-panel" data-testid={`import-${kind}`}>
      <h2>{t('imTitle')}</h2>
      <p>{t(INTRO[kind])}</p>
      <ol class="small">
        <li>{t('imStep1')}</li>
        <li>{t('imStep2')}</li>
        <li>{t('imStep3')}</li>
      </ol>
      <p class="small muted">
        {t('adMapColumns')} {IMPORT_COLUMNS[kind].map((col, i, all) => <><b><bdi>{col}</bdi></b>{i < all.length - 1 ? t('imListSep') : '.'}</>)}{' '}
        {t(COLS[kind])}
      </p>
      <div class="actions">
        <button type="button" class="btn" onClick={() => void downloadTemplate()}>{t('imTemplate')}</button>
        <span class="filepick">
          <input id={inputId} type="file" class="visually-hidden" data-testid={`import-file-${kind}`} disabled={busy} onChange={onFile}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
          <label for={inputId} class={`btn primary${busy ? ' disabled' : ''}`}>{t('imChoose')}</label>
        </span>
      </div>

      {state.kind === 'checking' && <p class="muted" role="status">{t('imChecking')}</p>}
      {state.kind === 'passwords' && (
        <div class="progress" role="status">
          <progress max={state.total} value={state.done} aria-label={t('imPasswordsLabel')} />
          <span>{tf('imPasswords', { done: fmtNum(state.done), total: fmtNum(state.total) })}</span>
        </div>
      )}
      {state.kind === 'problem' && <div class="alert" role="alert" data-testid="import-problem">{state.message}</div>}

      {c && (
        <div class="check-report">
          <p class={`banner ${errors ? 'bad' : c.preview.issues.length ? 'warn' : 'ok'}`} role="status" data-testid="import-summary">
            <span>
              <b><bdi>{c.fileName}</bdi></b>{': '}
              {tf('imCounts', { create: fmtNum(c.preview.create), update: fmtNum(c.preview.update), unchanged: fmtNum(c.preview.unchanged) })}
              {' '}{errors ? t('imErrorsBlock') : changes === 0 ? t('imNothingToDo') : c.preview.issues.length ? t('imWarningsOk') : t('imReady')}
            </span>
          </p>
          <Issues issues={c.preview.issues} level="error" />
          <Issues issues={c.preview.issues} level="warning" />
          <div class="actions">
            <button type="button" class="btn primary" data-testid="import-apply" disabled={errors || changes === 0 || state.kind === 'applying'}
              onClick={() => void apply(c)}>
              {state.kind === 'applying' ? t('imApplying') : t('imApply')}
            </button>
            <button type="button" class="btn" disabled={state.kind === 'applying'} onClick={() => { run.current++; setState({ kind: 'idle' }); }}>
              {t('dsCancel')}
            </button>
            {c.generated.length > 0 && <span class="muted small">{t('imGeneratedAfter')}</span>}
          </div>
        </div>
      )}

      {state.kind === 'done' && (
        <>
          <div class="banner ok" role="status" data-testid="import-done">
            <span>
              <b><bdi>{state.fileName}</bdi></b>{': '}
              {tf('imDone', { created: fmtNum(state.result.created), updated: fmtNum(state.result.updated), unchanged: fmtNum(state.result.unchanged) })}
            </span>
          </div>
          {state.result.treeChange && <TreeChangeBanner change={state.result.treeChange} />}
          {state.generated.length > 0 && (
            <div class="generated" data-testid="import-generated">
              <h3>{t('imGeneratedTitle')}</h3>
              <p class="banner warn">{t('imGeneratedNote')}</p>
              <div class="tablewrap">
                <table class="ad-table narrow-table">
                  <thead><tr><th class="s">{t('username')}</th><th class="s">{t('password')}</th></tr></thead>
                  <tbody>
                    {state.generated.map((g) => (
                      <tr key={g.username} data-testid="generated-row">
                        <td class="s"><bdi>{g.username}</bdi></td>
                        <td class="s"><code dir="ltr">{g.password}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div class="actions">
                <button type="button" class="btn" onClick={() => void downloadPasswords(state.generated)}>{t('imGeneratedDownload')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
