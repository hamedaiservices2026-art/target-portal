// The filter row under the distribution table's header, and the numeric filter
// parser. This module has no i18n import (labels come in as props) so that
// parseNumFilter can be unit-tested in Node.

export type StatusFilter = 'all' | 'ok' | 'bad';

export interface FilterState {
  pack: string;
  tgt: string;
  moved: string;
  status: StatusFilter;
  /** One expression per team member (by index in the workspace's children). */
  members: string[];
}

export const emptyFilters = (members: number): FilterState => ({
  pack: '', tgt: '', moved: '', status: 'all', members: Array.from({ length: members }, () => ''),
});

export const filtersActive = (f: FilterState): boolean =>
  !!(f.pack || f.tgt || f.moved || f.status !== 'all' || f.members.some(Boolean));

function westernDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * A numeric column filter: `>500`, `<100`, `>=500`, `<=100`, `=0` (a bare
 * number also means equals), `100-500` (inclusive). Blank always passes.
 * Spaces, thousands commas, bidi marks and Arabic-Indic digits are tolerated.
 * An expression that cannot be read hides nothing. A NaN value (an invalid
 * cell) fails every non-blank filter.
 */
export function parseNumFilter(expr: string): (v: number) => boolean {
  const s = westernDigits(expr).replace(/[\s,‎‏؜]/g, '');
  if (!s) return () => true;
  const range = /^(\d+)-(\d+)$/.exec(s);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return (v) => v >= lo && v <= hi;
  }
  const cmp = /^(>=|<=|>|<|=)?(\d+)$/.exec(s);
  if (!cmp) return () => true;
  const n = Number(cmp[2]);
  switch (cmp[1]) {
    case '>': return (v) => v > n;
    case '<': return (v) => v < n;
    case '>=': return (v) => v >= n;
    case '<=': return (v) => v <= n;
    default: return (v) => v === n;
  }
}

export interface FilterLabels {
  text: string;
  num: string;
  /** Accessible name for a column's filter: receives the column name. */
  label: (col: string) => string;
  pack: string;
  target: string;
  moved: string;
  status: string;
  all: string;
  ok: string;
  problems: string;
}

function Box({ value, num, name, placeholder, onInput }: {
  value: string; num: boolean; name: string; placeholder: string; onInput: (v: string) => void;
}) {
  return (
    <input
      type="text" class={`f${num ? ' num' : ''}${value ? ' on' : ''}`} value={value} placeholder={placeholder}
      aria-label={name} dir={num ? 'ltr' : undefined} inputMode={num ? 'numeric' : undefined}
      onInput={(e) => onInput((e.target as HTMLInputElement).value)}
    />
  );
}

/** The `<tr>` of filters: Pack (text), target, each visible member and moved (numeric), status (select). */
export function FilterRow({ f, vis, memberNames, labels, onChange }: {
  f: FilterState;
  vis: number[];
  memberNames: string[];
  labels: FilterLabels;
  onChange: (next: FilterState) => void;
}) {
  const set = (patch: Partial<FilterState>) => onChange({ ...f, ...patch });
  return (
    <tr class="h2">
      <th class="s">
        <Box value={f.pack} num={false} name={labels.label(labels.pack)} placeholder={labels.text} onInput={(pack) => set({ pack })} />
      </th>
      <th>
        <Box value={f.tgt} num name={labels.label(labels.target)} placeholder={labels.num} onInput={(tgt) => set({ tgt })} />
      </th>
      {vis.map((i) => (
        <th key={i}>
          <Box
            value={f.members[i] ?? ''} num name={labels.label(memberNames[i] ?? '')} placeholder={labels.num}
            onInput={(v) => set({ members: f.members.map((m, j) => (j === i ? v : m)) })}
          />
        </th>
      ))}
      <th>
        <Box value={f.moved} num name={labels.label(labels.moved)} placeholder={labels.num} onInput={(moved) => set({ moved })} />
      </th>
      <th class="s">
        <select
          class={`f${f.status !== 'all' ? ' on' : ''}`} value={f.status} aria-label={labels.label(labels.status)}
          onChange={(e) => set({ status: (e.target as HTMLSelectElement).value as StatusFilter })}
        >
          <option value="all">{labels.all}</option>
          <option value="ok">{labels.ok}</option>
          <option value="bad">{labels.problems}</option>
        </select>
      </th>
      <th />
    </tr>
  );
}
