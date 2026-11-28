// Small shared pieces of the cycle screens: workspace/month picker, checks
// list, number and percent formats, editable number cell, tabs.
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { errText } from '../components/AdminBits';
import { addMonths } from '../../shared/calc/periods';
import { parseCaseInput } from '../../shared/rules';
import type { Workspace } from '../../worker/auth';
import { fmtNum, useLang } from '../i18n';
import { useSession } from '../session';
import { tc } from './i18n';
import type { Check } from './parsers';

export const fmtPct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;

export const fmtGap = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

export const fmtCases = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : fmtNum(Math.round(v));

export function gapClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return v >= 0 ? 'gap up' : 'gap down';
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PERIOD_KEY = 'cy.period';
const isPeriod = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/**
 * The target month a cycle screen opens on without one in its address: the
 * month last picked on any cycle screen (so moving between Target cycle,
 * Cycle setup, CD and Reports keeps it), else the month after the current one.
 */
export function defaultPeriod(): string {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    if (isPeriod(v)) return v;
  } catch { /* storage blocked */ }
  const d = new Date();
  const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return addMonths(m, 1);
}

/** Remembers the month on screen for the next cycle screen opened without one. */
export function rememberPeriod(period: string): void {
  if (!isPeriod(period)) return;
  try { localStorage.setItem(PERIOD_KEY, period); } catch { /* storage blocked */ }
}

export const WS_LABEL = (ws: Workspace) => (ws === 'ops' ? tc('wsOps') : tc('wsKa'));

/**
 * Workspace tabs + target month (a year and a month list: works the same in
 * every browser and changes the month at once); `onChange` gets the new pair.
 */
export function WsPeriod({ ws, period, onChange, allowed }: {
  ws: Workspace; period: string; onChange: (ws: Workspace, period: string) => void; allowed?: Workspace[];
}) {
  useLang();
  const list: Workspace[] = allowed ?? ['ops', 'ka'];
  useEffect(() => rememberPeriod(period), [period]);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const now = new Date().getUTCFullYear();
  // From two years back up to 2050.
  const years = Array.from(new Set([...Array.from({ length: Math.max(0, 2050 - (now - 2) + 1) }, (_x, i) => now - 2 + i), year])).sort((a, b) => a - b);
  const go = (y: number, m: number) => onChange(ws, `${y}-${String(m).padStart(2, '0')}`);
  return (
    <div class="toolbar cy-picker">
      {list.map((w) => (
        <button type="button" key={w} class={`tab${w === ws ? ' on' : ''}`} aria-pressed={w === ws} onClick={() => onChange(w, period)}>
          {WS_LABEL(w)}
        </button>
      ))}
      <span class="cy-month" role="group" aria-label={tc('targetMonth')}>
        <span>{tc('targetMonth')}</span>
        <button type="button" class="btn small" aria-label={tc('prevMonth')} onClick={() => onChange(ws, addMonths(period, -1))}>‹</button>
        <select aria-label={tc('monthWord')} value={month} data-testid="period-month" onChange={(e) => go(year, Number(e.currentTarget.value))}>
          {MONTH_SHORT.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
        </select>
        <select aria-label={tc('yearWord')} value={year} data-testid="period-year" onChange={(e) => go(Number(e.currentTarget.value), month)}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button type="button" class="btn small" aria-label={tc('nextMonth')} onClick={() => onChange(ws, addMonths(period, 1))}>›</button>
      </span>
    </div>
  );
}

/** Called after packs were added to the pack master from a check (reloads the packs and reads the file again). */
export const PacksAdded = createContext<(() => void) | null>(null);
/** Changes when the pack master changes, so an upload step reads its file again. */
export const PacksVersion = createContext(0);

const PACK_GRPS = ['CSD', 'Water', 'LRB-Others'] as const;
/** A first guess of the pack's category from its code; the admin can change it. */
export function guessGrp(code: string): (typeof PACK_GRPS)[number] {
  const c = code.toUpperCase();
  if (c.startsWith('CSD')) return 'CSD';
  if (/WATER|AQUA|NOVA|\bWTR/.test(c)) return 'Water';
  return 'LRB-Others';
}

/** The packs a file has but the pack master lacks: add them all at once, with a category each. */
function AddPacks({ packs, onDone }: { packs: string[]; onDone: () => void }) {
  useLang();
  const [grp, setGrp] = useState<Record<string, string>>(() => Object.fromEntries(packs.map((p) => [p, guessGrp(p)])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setErr(null);
    try {
      for (const code of packs) {
        try {
          await api('POST', '/api/admin/packs', { code, grp: grp[code], active: true });
        } catch (x) {
          if (!/already exists/i.test(errText(x))) throw x;
        }
      }
      onDone();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="cy-addpacks" data-testid="add-packs">
      <table class="ad-table cy-table"><tbody>{packs.map((p) => (
        <tr key={p}><td><bdi>{p}</bdi></td><td>
          <select aria-label={`${tc('packCategory')} ${p}`} value={grp[p]} onChange={(e) => setGrp({ ...grp, [p]: e.currentTarget.value })}>
            {PACK_GRPS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </td></tr>
      ))}</tbody></table>
      <button type="button" class="btn primary" disabled={busy} data-testid="add-packs-btn" onClick={() => void add()}>{tc('addPacksBtn', { n: packs.length })}</button>
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}

export function Checks({ checks }: { checks: Check[] }) {
  const onAdded = useContext(PacksAdded);
  if (!checks.length) return null;
  return (
    <ul class="cy-checks">
      {checks.map((c, i) => (
        <li key={i} class={`chk ${c.level}`}>
          <b>{c.level === 'error' ? tc('chkError') : c.level === 'warning' ? tc('chkWarning') : tc('chkInfo')}</b> {c.text}
          {c.packs?.length && onAdded ? <AddPacks packs={c.packs} onDone={onAdded} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function Tabs<T extends string>({ value, items, onChange }: { value: T; items: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="toolbar" role="tablist">
      {items.map((it) => (
        <button type="button" role="tab" key={it.id} class={`tab${value === it.id ? ' on' : ''}`} aria-selected={value === it.id} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** A whole-case input that keeps the text while typing and reports a number (or null) on change. */
export function NumCell({ value, onChange, disabled, label, invalid }: {
  value: number; onChange: (n: number) => void; disabled?: boolean; label: string; invalid?: boolean;
}) {
  const [text, setText] = useState(fmtNum(value));
  useEffect(() => setText(fmtNum(value)), [value]);
  const bad = parseCaseInput(text) === null;
  return (
    <input
      class={`cy-num${bad || invalid ? ' bad' : ''}`} inputMode="numeric" value={text} disabled={disabled} aria-label={label}
      onInput={(e) => setText(e.currentTarget.value)}
      onBlur={() => {
        const n = parseCaseInput(text);
        if (n === null || n === value) setText(fmtNum(value));
        else onChange(n);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
    />
  );
}

/** Workspaces the signed-in user may open as Admin or CD. */
export function useMyWorkspaces(): Workspace[] {
  const { user } = useSession();
  if (!user) return [];
  if (user.role === 'admin') return ['ops', 'ka'];
  // Operations first, so the CD lands on Operations.
  return [...(user.cd ?? [])].sort((a, b) => (a === 'ops' ? -1 : b === 'ops' ? 1 : 0));
}

export function Section({ title, children, right }: { title: string; children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <section class="card cy-section">
      <div class="cy-section-head"><h2>{title}</h2>{right}</div>
      {children}
    </section>
  );
}

/** Downloads a CSV (UTF-8 with BOM so Excel reads Arabic text). */
export function downloadCsv(file: string, columns: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [columns, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Several sheets in one .xlsx (the CD workbook, the calculator, the templates). `head` rows go above the column row. */
export async function writeWorkbook(file: string, sheets: { name: string; columns: string[]; rows: (string | number | null)[][]; head?: (string | number | null)[][] }[]): Promise<void> {
  const { default: write } = await import('write-excel-file/browser');
  const data = sheets.map((s) => ({
    sheet: s.name.slice(0, 31),
    data: [
      ...(s.head ?? []).map((r) => r.map((v) => ({ value: v ?? '', fontWeight: 'bold' as const }))),
      s.columns.map((value) => ({ value, fontWeight: 'bold' as const })),
      ...s.rows.map((r) => r.map((v) => (v === null || v === undefined ? null : { value: v }))),
    ],
  }));
  await (write as unknown as (d: unknown) => { toFile: (f: string) => Promise<void> })(data).toFile(file);
}


/** "Jul–Sep 2026" style label of a month list. */
export function monthsLabel(months: string[]): string {
  if (!months.length) return '—';
  const s = [...months].sort();
  const f = (m: string) => `${MONTH_SHORT[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
  return s.length === 1 ? f(s[0]!) : `${f(s[0]!)} – ${f(s[s.length - 1]!)}`;
}

/**
 * Month checkboxes for the average sales: the target year and the year
 * before, 12 months each. Months with no sales uploaded are greyed; PAGO and
 * YAGO are marked (they always show their own month).
 */
export function MonthPicker({ period, months, onChange, available, title, disabled }: {
  period: string; months: string[]; onChange: (m: string[]) => void; available: Set<string> | null; title?: string; disabled?: boolean;
}) {
  useLang();
  const year = Number(period.slice(0, 4));
  const pm = addMonths(period, -1);
  const ym = addMonths(period, -12);
  const toggle = (m: string) => onChange(months.includes(m) ? months.filter((x) => x !== m) : [...months, m].sort());
  return (
    <section class="card cy-section cy-monthpick" data-testid="month-picker">
      <div class="cy-section-head">
        <h2>{title ?? tc('avgBasedOn')}</h2>
        <span class="muted small">{tc('avgNow', { n: months.length, label: monthsLabel(months) })}</span>
      </div>
      {[year, year - 1].map((y) => (
        <div class="cy-mp-row" key={y}>
          <b>{y}</b>
          {MONTH_SHORT.map((name, i) => {
            const m = `${y}-${String(i + 1).padStart(2, '0')}`;
            const on = months.includes(m);
            const has = !available || available.has(m);
            const tag = m === pm ? ' · PAGO' : m === ym ? ' · YAGO' : '';
            return (
              <label key={m} class={`cy-mp${has ? '' : ' off'}${on ? ' on' : ''}`} title={has ? '' : tc('noSalesData')}>
                <input type="checkbox" checked={on} disabled={disabled || (!has && !on)} onChange={() => toggle(m)} /> {name}{tag}
              </label>
            );
          })}
        </div>
      ))}
      <p class="muted small">{tc('avgPickHelp')}</p>
    </section>
  );
}

/** The row colours of the AOP by pack and department file (Excel fills and font colours). */
const FILE_COLOURS: Record<string, [string, string, boolean]> = {
  'total cans': ['#C1E5F5', '#000', true], 'total ssnr': ['#C1E5F5', '#000', true], 'total mspet': ['#C1E5F5', '#000', true],
  'total abc': ['#00B050', '#000', true], 'total tt dmm': ['#00B050', '#000', true],
  'total water': ['#00B0F0', '#000', true], 'total lit': ['#FFFF00', '#000', true],
  'total gatorade': ['#FBE3D6', '#000', false], 'mplus_nrb300': ['#D9F2D0', '#000', false],
  'total rockstar': ['#000000', '#FFC000', true], 'total sting energy': ['#C00000', '#FFF', true], 'total energy': ['#000000', '#FFF', true],
  'total britvic': ['#CAEEFB', '#000', true], 'total lrb-others': ['#FFC000', '#000', true], 'total lrb': ['#0000FF', '#FFF', true],
};
export function rowColour(label: string): Record<string, string> | undefined {
  const c = FILE_COLOURS[label.trim().toLowerCase().replace(/\s+/g, ' ')];
  return c ? { '--ft-bg': c[0], '--ft-fg': c[1], '--ft-w': c[2] ? '700' : '400' } : undefined;
}
