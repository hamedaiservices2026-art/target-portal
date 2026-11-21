// The distribution table: header, filter row, collapsible group rows with member
// subtotals, and one row per pack with an input per team member. Pack rows are
// a component that only re-renders when its own props change, so typing in
// one cell does not redraw the other 41 packs.
import { Component, type ComponentChild } from 'preact';
import type { PackCheck } from '../../shared/rules';
import type { PackGroup } from '../../shared/types';
import { fmtNum, t, tf, type Lang, type TextKey } from '../i18n';
import { FilterRow, type FilterLabels, type FilterState } from './Filters';
import { StatusBadge } from './StatusBadge';

/** A pack's live state, derived from its raw cell texts (cached per raw array). */
export interface PackInfo {
  /** Parsed cases per member; NaN where the text is not a valid number. */
  nums: number[];
  invalid: boolean[];
  anyInvalid: boolean;
  check: PackCheck;
}

export interface Member {
  key: string;
  /** Column header, first line (e.g. "Route 314023" or a node name). */
  title: string;
  /** Column header, second line (e.g. "Salesman 42059" or the manager). */
  sub: string;
  /** Accessible name part for the member's cells. */
  aria: string;
}

export type CellHandler = (pack: string, i: number, value: string) => void;
export type PackHandler = (pack: string, i: number) => void;

const GROUP_LABEL: Record<PackGroup, TextKey> = { CSD: 'dsGroupCSD', Water: 'dsGroupWater', 'LRB-Others': 'dsGroupLRB' };

interface RowProps {
  pack: string;
  /** Position of the pack in the month (used for element ids: codes may hold spaces). */
  idx: number;
  total: number;
  starts: number[];
  raw: string[];
  info: PackInfo;
  vis: number[];
  members: Member[];
  editable: boolean;
  lang: Lang;
  onCell: CellHandler;
  onCommit: PackHandler;
  onReset: (pack: string) => void;
}

/** A number (or "x / y") kept left-to-right inside Arabic text: "-21" never shows as "21-". */
const ltr = (text: string) => <bdi dir="ltr">{text}</bdi>;
const signed = (d: number) => ltr(`${d > 0 ? '+' : ''}${fmtNum(d)}`);

/** `tf` that keeps the {placeholders} as nodes (so numbers can be isolated). */
function tparts(key: TextKey, vars: Record<string, ComponentChild>): ComponentChild[] {
  return t(key).split(/(\{\w+\})/).filter(Boolean).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1]! in vars ? vars[m[1]!] : part;
  });
}

function hintFor(info: PackInfo, start: number, i: number): { text: ComponentChild[]; cls: string } {
  if (info.invalid[i]) return { text: [t('dsHintInvalid')], cls: 'd bad' };
  const d = (info.nums[i] ?? 0) - start;
  if (d === 0) return { text: tparts('dsHintStart', { n: ltr(fmtNum(start)) }), cls: 'd' };
  return { text: tparts('dsHintFrom', { d: signed(d), n: ltr(fmtNum(start)) }), cls: d > 0 ? 'd up' : 'd down' };
}

class PackRow extends Component<RowProps> {
  shouldComponentUpdate(next: RowProps): boolean {
    const cur = this.props as unknown as Record<string, unknown>;
    const nxt = next as unknown as Record<string, unknown>;
    for (const k in nxt) if (cur[k] !== nxt[k]) return true;
    return false;
  }

  render() {
    const { pack, idx, total, starts, raw, info, vis, members, editable, onCell, onCommit, onReset } = this.props;
    const { check } = info;
    return (
      <tr data-pack={pack}>
        <td class="s pack">{pack}</td>
        <td class="tgt">{fmtNum(total)}</td>
        {vis.map((i) => {
          const start = starts[i] ?? 0;
          const hint = hintFor(info, start, i);
          const overCap = !info.invalid[i] && Math.abs((info.nums[i] ?? 0) - start) > check.cap;
          const hintId = `h-${idx}-${i}`;
          return (
            <td key={i}>
              <div class={`cell${info.invalid[i] || overCap ? ' over' : ''}`}>
                <input
                  type="text" inputMode="numeric" dir="ltr" autoComplete="off" spellcheck={false}
                  value={raw[i] ?? ''} disabled={!editable}
                  aria-label={`${pack} · ${members[i]?.aria ?? ''}`}
                  aria-invalid={info.invalid[i] ? 'true' : undefined}
                  aria-describedby={hintId}
                  onInput={(e) => onCell(pack, i, (e.target as HTMLInputElement).value)}
                  onBlur={() => onCommit(pack, i)}
                />
                <span id={hintId} class={hint.cls} data-testid={`hint-${pack}-${i}`}>{hint.text}</span>
              </div>
            </td>
          );
        })}
        <td>
          <span class={`moved${check.moved > check.cap ? ' bad' : ''}`} data-testid={`moved-${pack}`}>
            {ltr(`${fmtNum(check.moved)} / ${fmtNum(check.cap)}`)}
          </span>
        </td>
        <td class="s"><StatusBadge check={check} testId={`status-${pack}`} /></td>
        <td>
          {editable && (
            <button type="button" class="reset" aria-label={tf('dsResetLabel', { pack })} onClick={() => onReset(pack)}>
              {t('dsReset')}
            </button>
          )}
        </td>
      </tr>
    );
  }
}

export interface TableGroup {
  grp: PackGroup;
  /** Packs kept after "hide zero", in display order. */
  all: string[];
  /** Of those, the ones passing the search and filters. */
  shown: string[];
}

export function DistributionTable(props: {
  groups: TableGroup[];
  members: Member[];
  vis: number[];
  totals: Record<string, number>;
  starts: Record<string, number[]>;
  raw: Record<string, string[]>;
  packIdx: Record<string, number>;
  info: (pack: string) => PackInfo;
  collapsed: Set<string>;
  onToggle: (grp: string) => void;
  editable: boolean;
  lang: Lang;
  filters: FilterState;
  onFilters: (f: FilterState) => void;
  filterLabels: FilterLabels;
  onCell: CellHandler;
  onCommit: PackHandler;
  onReset: (pack: string) => void;
}) {
  const { groups, members, vis, totals, starts, raw, info, collapsed, editable, lang } = props;
  const cols = vis.length + 5;
  const rows = [];
  for (const g of groups) {
    if (!g.shown.length) continue;
    const open = !collapsed.has(g.grp);
    const label = t(GROUP_LABEL[g.grp]);
    const target = g.all.reduce((a, p) => a + (totals[p] ?? 0), 0);
    const okN = g.all.filter((p) => info(p).check.ok).length;
    const caret = open ? '▾' : lang === 'ar' ? '◂' : '▸';
    rows.push(
      <tr class="grp" key={`g-${g.grp}`} data-testid={`group-${g.grp}`} onClick={() => props.onToggle(g.grp)}>
        <td class="s">
          <button type="button" class="grp-toggle" aria-expanded={open} aria-label={tf('dsToggleGroup', { g: label })}>
            <span class="caret" aria-hidden="true">{caret}</span>{label}
          </button>
          <span class="gsub">{tparts('dsShown', { n: ltr(`${g.shown.length} / ${g.all.length}`) })}</span>
        </td>
        <td>{fmtNum(target)}</td>
        {vis.map((i) => {
          let now = 0;
          let st = 0;
          for (const p of g.all) {
            const n = info(p).nums[i];
            now += n !== undefined && Number.isFinite(n) ? n : 0;
            st += starts[p]?.[i] ?? 0;
          }
          const d = now - st;
          return (
            <td key={i}>
              {fmtNum(now)}
              <span class={`gsub${d > 0 ? ' up' : d < 0 ? ' down' : ''}`}>
                {d === 0 ? tparts('dsHintStart', { n: ltr(fmtNum(st)) }) : signed(d)}
              </span>
            </td>
          );
        })}
        <td />
        <td class="s">
          <span class={`status ${okN === g.all.length ? 'ok' : 'bad'}`}>{tparts('dsGroupOk', { n: ltr(`${okN} / ${g.all.length}`) })}</span>
        </td>
        <td />
      </tr>,
    );
    if (!open) continue;
    for (const p of g.shown) {
      rows.push(
        <PackRow
          key={p} pack={p} idx={props.packIdx[p] ?? 0} total={totals[p] ?? 0} starts={starts[p] ?? []} raw={raw[p] ?? []}
          info={info(p)} vis={vis} members={members} editable={editable} lang={lang}
          onCell={props.onCell} onCommit={props.onCommit} onReset={props.onReset}
        />,
      );
    }
  }

  return (
    <div class="tablewrap">
      <table data-testid="distribution-table">
        <thead>
          <tr class="h1">
            <th class="s" scope="col">{t('dsColPack')}</th>
            <th scope="col">{t('dsColTarget')}<span class="sub">{t('dsLocked')}</span></th>
            {vis.map((i) => (
              <th scope="col" key={i}>{members[i]?.title}<span class="sub">{members[i]?.sub}</span></th>
            ))}
            <th scope="col">{t('dsColMoved')}</th>
            <th class="s" scope="col">{t('dsColStatus')}</th>
            <th scope="col"><span class="visually-hidden">{t('dsColReset')}</span></th>
          </tr>
          <FilterRow
            f={props.filters} vis={vis} memberNames={members.map((m) => m.title)} labels={props.filterLabels}
            onChange={props.onFilters}
          />
        </thead>
        <tbody>
          {rows.length ? rows : (
            <tr><td class="empty" colSpan={cols}>{t('dsNothing')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
