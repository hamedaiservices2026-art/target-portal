// The sales hierarchy file (Hierarchy.xlsx): Channel Head, Sales Manager,
// Sales Supervisor, Route Code (and an optional Delivery System).
import { findHeader } from './parsers';

export const HIERARCHY_COLUMNS = ['Channel Head', 'Sales Manager', 'Sales Supervisor', 'Route Code', 'Delivery System'] as const;

export type HierarchyRow = { head: string; manager: string; supervisor: string; route: string; ds: string };

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** Reads the hierarchy sheet: the header row may sit below a title; blank rows are skipped. */
export function parseHierarchySheet(rows: unknown[][]): { rows: HierarchyRow[]; error: 'no_header' | 'empty' | null } {
  const h = findHeader(rows, {
    head: ['Channel Head', 'Head of Department', 'HOD Name', 'HoD', 'Head'],
    manager: ['Sales Manager', 'Manager Name', 'Manager', 'KAM', 'KAM Name'],
    supervisor: ['Sales Supervisor', 'Supervisor Name', 'Supervisor'],
    route: ['Route Code', 'Route', 'KAE ID', 'KAE'],
    ds: ['Delivery System', 'Channel'],
  }, ['head', 'route']);
  if (!h) return { rows: [], error: 'no_header' };
  const out: HierarchyRow[] = [];
  for (const r of rows.slice(h.row + 1)) {
    if (!Array.isArray(r)) continue;
    const get = (k: string) => (h.col[k] === undefined ? '' : cell(r[h.col[k]!]));
    const row = { head: get('head'), manager: get('manager'), supervisor: get('supervisor'), route: get('route'), ds: get('ds') };
    if (!row.head && !row.route) continue;
    out.push(row);
  }
  return { rows: out, error: out.length ? null : 'empty' };
}

