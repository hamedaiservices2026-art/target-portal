// Small shared pieces of the cycle screens: workspace/month picker, checks
// list, number and percent formats, editable number cell, tabs.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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

/** The month after the current one (the usual target month). */
export function defaultPeriod(): string {
  const d = new Date();
  const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return addMonths(m, 1);
}

export const WS_LABEL = (ws: Workspace) => (ws === 'ops' ? tc('wsOps') : tc('wsKa'));

/** Workspace tabs + target month input; `onChange` gets the new pair. */
export function WsPeriod({ ws, period, onChange, allowed }: {
  ws: Workspace; period: string; onChange: (ws: Workspace, period: string) => void; allowed?: Workspace[];
}) {
  useLang();
  const list: Workspace[] = allowed ?? ['ops', 'ka'];
  return (
    <div class="toolbar cy-picker">
      {list.map((w) => (
        <button type="button" key={w} class={`tab${w === ws ? ' on' : ''}`} aria-pressed={w === ws} onClick={() => onChange(w, period)}>
          {WS_LABEL(w)}
        </button>
      ))}
      <label>
        {tc('targetMonth')}{' '}
        <input type="month" value={period} onChange={(e) => { const v = e.currentTarget.value; if (/^\d{4}-\d{2}$/.test(v)) onChange(ws, v); }} />
      </label>
    </div>
  );
}

export function Checks({ checks }: { checks: Check[] }) {
  if (!checks.length) return null;
  return (
    <ul class="cy-checks">
      {checks.map((c, i) => (
        <li key={i} class={`chk ${c.level}`}>
          <b>{c.level === 'error' ? tc('chkError') : c.level === 'warning' ? tc('chkWarning') : tc('chkInfo')}</b> {c.text}
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
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const bad = parseCaseInput(text) === null;
  return (
    <input
      class={`cy-num${bad || invalid ? ' bad' : ''}`} inputMode="numeric" value={text} disabled={disabled} aria-label={label}
      onInput={(e) => setText(e.currentTarget.value)}
      onBlur={() => {
        const n = parseCaseInput(text);
        if (n === null) setText(String(value));
        else if (n !== value) onChange(n);
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
  return user.cd ?? [];
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

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
