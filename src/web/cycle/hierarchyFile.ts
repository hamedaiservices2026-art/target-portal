// The sales hierarchy file (Hierarchy.xlsx): Channel Head, Sales Manager,
// Sales Supervisor, Route Code (and an optional Delivery System).
import { findHeader } from './parsers';

export const HIERARCHY_COLUMNS = ['Channel Head', 'Sales Manager', 'Sales Supervisor', 'Route Code', 'Delivery System'] as const;

export type HierarchyRow = { head: string; manager: string; supervisor: string; route: string; ds: string };

/** The Key Account hierarchy: MDM Name (the Head), KAM Name, KAE Name, KAE ID. */
export const KA_HIERARCHY_COLUMNS = ['MDM Name', 'MDM ID', 'KAM Name', 'KAM ID', 'KAE Name', 'KAE ID'] as const;

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** Reads the hierarchy sheet: the header row may sit below a title; blank rows are skipped. */
export function parseHierarchySheet(rows: unknown[][]): { rows: HierarchyRow[]; error: 'no_header' | 'empty' | null; ka: boolean } {
  const h = findHeader(rows, {
    head: ['Channel Head', 'Head of Department', 'HOD Name', 'HoD', 'Head', 'MDM Name', 'MDM'],
    manager: ['Sales Manager', 'Manager Name', 'Manager', 'KAM Name', 'KAM'],
    supervisor: ['Sales Supervisor', 'Supervisor Name', 'Supervisor', 'KAE Name'],
    route: ['Route Code', 'Route', 'KAE ID', 'KAE'],
    ds: ['Delivery System', 'Channel'],
  }, ['head', 'route']);
  if (!h) return { rows: [], error: 'no_header', ka: false };
  // MDM / KAM / KAE headers: a Key Account hierarchy (KAM = manager, KAE = the person under the KAM, KAE ID = the route).
  const headerText = (rows[h.row] ?? []).map((c) => String(c ?? '').toLowerCase()).join('|');
  const ka = /\bmdm\b|\bkae\b|\bkam\b/.test(headerText);
  const out: HierarchyRow[] = [];
  for (const r of rows.slice(h.row + 1)) {
    if (!Array.isArray(r)) continue;
    const get = (k: string) => (h.col[k] === undefined ? '' : cell(r[h.col[k]!]));
    const row = { head: get('head'), manager: get('manager'), supervisor: get('supervisor'), route: get('route'), ds: get('ds') };
    if (!row.head && !row.route) continue;
    out.push(row);
  }
  return { rows: out, error: out.length ? null : 'empty', ka };
}

