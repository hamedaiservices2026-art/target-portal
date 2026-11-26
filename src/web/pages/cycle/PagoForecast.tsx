// PAGO forecast closing: the target month is prepared before the previous
// month (PAGO) closes, so its sales miss the last days. Before the approval
// download the CD or Admin can forecast the closing: actual sales / working
// days with sales (Fridays excluded) = sales by day; x remaining working days
// = remaining days sales; actual + remaining = forecast closing. The approval
// then uses the closing for PAGO.
import { useEffect, useState } from 'preact/hooks';
import { pago as pagoOf } from '../../../shared/calc/periods';
import type { Workspace } from '../../../worker/auth';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { loadRouteData, useAsync } from '../../cycle/load';
import { total } from '../../cycle/compute';

import { defaultFc, workingDays, type PagoFc } from '../../cycle/pagoFc';
export { fcFactor, type PagoFc } from '../../cycle/pagoFc';

const key = (ws: Workspace, period: string) => `pagoFc:${ws}:${period}`;
function stored(ws: Workspace, period: string): PagoFc | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(ws, period)) ?? 'null') as PagoFc | null;
    return v && typeof v.done === 'number' && typeof v.left === 'number' ? v : null;
  } catch { return null; }
}

export function usePagoFc(ws: Workspace, period: string): [PagoFc, (v: PagoFc) => void] {
  const [fc, setFc] = useState<PagoFc>(() => stored(ws, period) ?? defaultFc(pagoOf(period)));
  useEffect(() => setFc(stored(ws, period) ?? defaultFc(pagoOf(period))), [ws, period]);
  return [fc, (v: PagoFc) => { setFc(v); try { localStorage.setItem(key(ws, period), JSON.stringify(v)); } catch { /* private mode */ } }];
}

export function PagoForecast({ ws, period, fc, onChange }: { ws: Workspace; period: string; fc: PagoFc; onChange: (v: PagoFc) => void }) {
  useLang();
  const pm = pagoOf(period);
  const sales = useAsync(async () => {
    const d = await loadRouteData(ws, 'sales', [pm]);
    return Object.values(d.data[pm] ?? {}).reduce((s, g) => s + total(g), 0);
  }, [ws, pm]);
  const actual = sales.data ?? 0;
  const perDay = fc.done > 0 ? actual / fc.done : 0;
  const rest = perDay * fc.left;
  const num = (v: string) => Math.max(0, Math.min(31, Math.round(Number(v) || 0)));
  return (
    <div class="cy-pagofc" data-testid="pago-forecast">
      <label class="small"><input type="checkbox" checked={fc.on} data-testid="pago-fc-on" onChange={(e) => onChange({ ...fc, on: e.currentTarget.checked })} /> {tc('pfUse', { month: pm })}</label>
      {fc.on && (
        <>
          <div class="toolbar">
            <label class="small">{tc('pfDone')} <input type="number" min={0} max={31} value={fc.done} style={{ width: '4.5em' }} data-testid="pago-fc-done" onInput={(e) => onChange({ ...fc, done: num(e.currentTarget.value) })} /></label>
            <label class="small">{tc('pfLeft')} <input type="number" min={0} max={31} value={fc.left} style={{ width: '4.5em' }} data-testid="pago-fc-left" onInput={(e) => onChange({ ...fc, left: num(e.currentTarget.value) })} /></label>
            <span class="small muted">{tc('pfWorking', { n: workingDays(pm) })}</span>
          </div>
          <div class="tablewrap"><table class="ad-table cy-table" data-testid="pago-fc-table">
            <thead><tr><th class="num">{tc('pfActual', { n: fc.done })}</th><th class="num">{tc('pfPerDay')}</th><th class="num">{tc('pfRest')}</th><th class="num">{tc('pfClosing')}</th></tr></thead>
            <tbody><tr><td class="num">{fmtNum(Math.round(actual))}</td><td class="num">{fmtNum(Math.round(perDay))}</td><td class="num">{fmtNum(Math.round(rest))}</td><td class="num tot"><b>{fmtNum(Math.round(actual + rest))}</b></td></tr></tbody>
          </table></div>
        </>
      )}
    </div>
  );
}
