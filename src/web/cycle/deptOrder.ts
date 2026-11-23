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


/** The channels of the department target file, in its order (Total TT, Total MT and ABC are worked out). */
export const STANDARD_CHANNELS = ['TT DMM', 'TT Outer', 'MT', 'MT SSV', 'MT Bulk', 'HoReCa', 'WS'];

type OrgDept = { id: number; name: string; code: string; channels: { channel: string }[] };

/** Departments and their channels in the order of the department target file (one column per department without channels). */
export function orderedDeptCols(depts: OrgDept[], none: string): DeptCol[] {
  return depts
    .map((d, i) => ({ id: String(d.id), name: d.name, i, chans: d.channels.length ? sortChannels(d.channels.map((c) => c.channel)) : [none] }))
    .sort((a, b) => channelRank(a.chans[0]!) - channelRank(b.chans[0]!) || a.i - b.i)
    .map(({ id, name, chans }) => ({ id, name, chans }));
}

const isTotal = (s: string) => /^(total\b|abc$|grand total)/i.test(s.trim());

/**
 * The two header rows of the department target file: Head names on the row
 * above "Pack" (a name covers the columns up to the next name), channels on
 * the "Pack" row. Returns each Head with the channels under the name.
 */
export function fileHeads(rows: unknown[][]): { head: string; channels: string[] }[] {
  const at = rows.findIndex((r) => Array.isArray(r) && /^(pack|sales target category)$/i.test(String(r[0] ?? '').trim()));
  if (at < 1) return [];
  const top = rows[at - 1] ?? [];
  const chan = rows[at] ?? [];
  const out: { head: string; channels: string[] }[] = [];
  let cur: { head: string; channels: string[] } | null = null;
  for (let c = 1; c < chan.length; c++) {
    const h = String(top[c] ?? '').trim();
    if (h) { cur = { head: h, channels: [] }; out.push(cur); }
    const ch = String(chan[c] ?? '').trim();
    if (!ch || isTotal(ch)) continue;
    if (cur) cur.channels.push(ch);
  }
  return out.filter((x) => x.channels.length > 0);
}

const nameKey = (s: string) => s.toLowerCase().replace(/mohammad|mohammed|muhammad/g, 'mohamed').replace(/[^a-z؀-ۿ]+/g, ' ').trim();
function bigrams(s: string): string[] {
  const t = s.replace(/ /g, '');
  return Array.from({ length: Math.max(0, t.length - 1) }, (_x, i) => t.slice(i, i + 2));
}
/** How alike two person names are, 0 to 1 (first names count double). */
export function nameScore(a: string, b: string): number {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  const pool = [...by];
  let hit = 0;
  for (const g of bx) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  const dice = bx.length + by.length ? (2 * hit) / (bx.length + by.length) : 0;
  const first = x.split(' ')[0] === y.split(' ')[0] ? 1 : 0;
  return (2 * dice + first) / 3;
}

/** Each Head of the file matched to one department (by name or code), best matches first. */
export function matchHeads(heads: { head: string; channels: string[] }[], depts: OrgDept[]): { head: string; channels: string[]; deptId: number | null }[] {
  const pairs: { h: number; d: number; s: number }[] = [];
  heads.forEach((h, hi) => depts.forEach((d, di) => pairs.push({ h: hi, d: di, s: Math.max(nameScore(h.head, d.name), nameKey(h.head) === nameKey(d.code) ? 1 : 0) })));
  pairs.sort((a, b) => b.s - a.s);
  const usedH = new Set<number>();
  const usedD = new Set<number>();
  const deptOf = new Map<number, number>();
  for (const p of pairs) {
    if (p.s < 0.45 || usedH.has(p.h) || usedD.has(p.d)) continue;
    usedH.add(p.h); usedD.add(p.d); deptOf.set(p.h, depts[p.d]!.id);
  }
  return heads.map((h, i) => ({ ...h, deptId: deptOf.get(i) ?? null }));
}
