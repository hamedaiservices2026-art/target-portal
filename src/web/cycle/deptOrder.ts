// Order and subtotal columns of the department target file (CD › Target by department).
// ---------- order of the department target file ----------

type DeptCol = { id: string; name: string; chans: string[] };
type FlatCol = { kind: 'cell'; d: DeptCol; c: string } | { kind: 'total'; label: string; cells: { d: string; c: string }[] };
type HeadCol = { kind: 'dept'; d: DeptCol; span: number } | { kind: 'total'; label: string };

/** Family of a channel for the subtotal columns: TT channels, MT channels, else the department itself. */
function familyOf(c: string, d: DeptCol): string {
  const n = norm(c);
  if (/(^| )tt( |$)/.test(n)) return 'TT';
  if (/(^| )mt( |$)/.test(n)) return 'MT';
  return `d:${d.id}`;
}

/**
 * The flat list of columns with "Total TT" after the last TT channel and
 * "Total MT" after the last MT channel (any department with more than one
 * channel of its own gets "Total <department>").
 */
export function deptColumns(cols: DeptCol[], totalOf: (name: string) => string): { flat: FlatCol[]; heads: HeadCol[] } {
  const cells = cols.flatMap((d) => d.chans.map((c) => ({ d, c, f: familyOf(c, d) })));
  const count = new Map<string, number>();
  for (const x of cells) count.set(x.f, (count.get(x.f) ?? 0) + 1);
  const flat: FlatCol[] = [];
  const heads: HeadCol[] = [];
  cells.forEach((x, i) => {
    flat.push({ kind: 'cell', d: x.d, c: x.c });
    const last = heads[heads.length - 1];
    if (last && last.kind === 'dept' && last.d === x.d) last.span++;
    else heads.push({ kind: 'dept', d: x.d, span: 1 });
    const next = cells[i + 1];
    if ((count.get(x.f) ?? 0) > 1 && (!next || next.f !== x.f)) {
      const label = x.f === 'TT' ? 'Total TT' : x.f === 'MT' ? 'Total MT' : totalOf(x.d.name);
      flat.push({ kind: 'total', label, cells: cells.filter((y) => y.f === x.f).map((y) => ({ d: y.d.id, c: y.c })) });
      heads.push({ kind: 'total', label });
    }
  });
  return { flat, heads };
}

const CHANNEL_ORDER = ['tt dmm', 'tt dam', 'tt outer', 'tt', 'mt', 'mt ssv', 'ssv mt', 'mt ps', 'mt bulk', 'horeca', 'non retail', 'ws', 'kam', 'kae'];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Rank of a channel in the department file (TT DMM, TT Outer, MT, MT SSV, MT Bulk, HoReCa, WS); unknown last. */
export function channelRank(c: string): number {
  const n = norm(c);
  const exact = CHANNEL_ORDER.indexOf(n);
  if (exact >= 0) return exact;
  // "Presell – TT" or "TT - DMM": the longest known name the channel ends with or contains.
  let best = -1;
  for (const [i, k] of CHANNEL_ORDER.entries()) if (new RegExp(`(^| )${k}( |$)`).test(n) && (best < 0 || k.length > CHANNEL_ORDER[best]!.length)) best = i;
  return best >= 0 ? best : CHANNEL_ORDER.length;
}
export const sortChannels = (list: string[]) => list.map((c, i) => ({ c, i })).sort((a, b) => channelRank(a.c) - channelRank(b.c) || a.i - b.i).map((x) => x.c);

