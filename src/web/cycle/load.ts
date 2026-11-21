// Loading the cycle data for the browser calculations. Route rows are fetched
// one month at a time (each is one JSON string built by the database) and
// cached for the page session.
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Workspace } from '../../worker/auth';
import type { CycleDto } from '../../worker/services/cycle';
import type { OrgDto } from '../../worker/services/cycleData';
import { api } from '../api';
import { errText } from '../components/AdminBits';
import type { RouteMonthData } from './parsers';

type RouteRow = { r: string; v: Record<string, number>; x: Record<string, unknown> | null };

const cache = new Map<string, Promise<RouteRow[]>>();

export function clearRouteCache(ws?: Workspace): void {
  for (const k of [...cache.keys()]) if (!ws || k.startsWith(`${ws}|`)) cache.delete(k);
}

function routeRows(ws: Workspace, kind: 'sales' | 'prev_target', month: string): Promise<RouteRow[]> {
  const key = `${ws}|${kind}|${month}`;
  let p = cache.get(key);
  if (!p) {
    p = api<RouteRow[]>('GET', `/api/data/${ws}/routes?kind=${kind}&month=${month}`);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** month -> route -> pack -> cases for the given months (missing months are simply absent). */
export async function loadRouteData(ws: Workspace, kind: 'sales' | 'prev_target', months: string[]): Promise<{ data: RouteMonthData; extra: Record<string, Record<string, Record<string, unknown> | null>> }> {
  const data: RouteMonthData = {};
  const extra: Record<string, Record<string, Record<string, unknown> | null>> = {};
  const uniq = [...new Set(months)];
  const rows = await Promise.all(uniq.map((m) => routeRows(ws, kind, m)));
  uniq.forEach((m, i) => {
    const list = rows[i]!;
    if (!list.length) return;
    data[m] = Object.fromEntries(list.map((r) => [r.r, r.v]));
    extra[m] = Object.fromEntries(list.map((r) => [r.r, r.x]));
  });
  return { data, extra };
}

export async function loadMonthData<T>(ws: Workspace, kind: 'new_target' | 'aop' | 'fy_target' | 'dept_channel'): Promise<Record<string, T>> {
  return api<Record<string, T>>('GET', `/api/data/${ws}/months?kind=${kind}`);
}

export function useAsync<T>(fn: (() => Promise<T>) | null, deps: unknown[]): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!fn) return;
    let live = true;
    setLoading(true);
    setError(null);
    fn().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(errText(e)); }).finally(() => { if (live) setLoading(false); });
    return () => void (live = false);
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, reload, loading };
}

export function getCycle(ws: Workspace, period: string): Promise<CycleDto> {
  return api<CycleDto>('GET', `/api/cycle/${ws}/${period}`);
}

export function getOrg(ws: Workspace): Promise<OrgDto> {
  return api<OrgDto>('GET', `/api/data/${ws}/org`);
}
