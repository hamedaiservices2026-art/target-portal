// Admin › Target cycle: one banner above the tabs that says where the cycle
// stands and what the admin does next, with a button to that tab. It is
// worked out from the cycle itself, so it moves on after every save, upload,
// apply or send.
import type { Workspace } from '../../../worker/auth';
import type { DataStatus } from '../../../worker/services/cycleData';
import { useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import type { Loaded } from './AdminCycle';

export type TabId = 'start' | 'calc' | 'control' | 'workflow' | 'routes';

type Next = { text: string; tab: TabId | null; wait?: boolean; done?: boolean; href?: string; hrefLabel?: string };

const has = (status: DataStatus, kind: string, month?: string) => status.some((s) => s.kind === kind && (month === undefined || s.month === month));

/** The next step of the cycle for the admin. */
export function nextStep(ws: Workspace, period: string, l: Loaded): Next {
  const { cycle, status } = l;
  const s = cycle.settings;
  const exists = cycle.version > 0 || cycle.updatedAt !== '';
  if (!exists) return { text: tc('nsOpen', { period }), tab: 'start' };
  const ka = ws === 'ka';
  // Already past the start (with the CD, or the department target set, or calculated): the uploads are no longer the next step.
  const pastStart = cycle.calcDepts.length > 0 || (!ka && (s.cdStep ? cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted' : !!cycle.dept));
  if (!pastStart) {
    const pre = startStep(ws, period, l);
    if (pre) return pre;
  }
  return afterStart(ws, l, period);
}

/** The start steps: the new target, the sales, the previous targets, then the CD (Operation). */
function startStep(ws: Workspace, period: string, l: Loaded): Next | null {
  const { cycle, status } = l;
  const s = cycle.settings;
  const ka = ws === 'ka';
  // 1. What the calculation needs.
  if (ka && s.ntMode === 'ops') {
    const linked = (l.links ?? []).filter((x) => x.opsDeptId !== null);
    if (!linked.length) return { text: tc('nsKaLink'), tab: 'start' };
    if (!linked.some((x) => l.ops?.dept?.[String(x.opsDeptId)])) return { text: tc('nsKaWaitOps', { period }), tab: null, wait: true };
  } else if (!has(status, 'new_target', period)) {
    return { text: s.ntMode === 'aop' ? tc('nsNtAop', { period }) : tc('nsNt', { period }), tab: 'start' };
  }
  if (!s.avgMonths.every((m) => has(status, 'sales', m))) return { text: ka ? tc('nsSalesKa') : tc('nsSales'), tab: 'start' };
  if (ka && !has(status, 'prev_target')) return { text: tc('nsPrevKa'), tab: 'start' };
  if (!ka) {
    if (s.cdStep) {
      if (cycle.cdStatus === 'draft') return { text: tc('nsSendCd'), tab: 'start' };
      if (cycle.cdStatus === 'returned') return { text: tc('nsCdReturned', { c: cycle.cdComment ?? '' }), tab: 'start' };
      if (cycle.cdStatus === 'with_cd') return { text: tc('nsWaitCd'), tab: null, wait: true };
    } else if (!cycle.dept) {
      return { text: tc('nsDeptTarget'), tab: 'start' };
    }
  }
  return null;
}

function afterStart(ws: Workspace, l: Loaded, period: string): Next {
  const { cycle } = l;
  const s = cycle.settings;
  const ka = ws === 'ka';
  if (!ka && s.cdStep && cycle.cdStatus === 'with_cd') return { text: tc('nsWaitCd'), tab: null, wait: true };
  // 2. Calculate and apply, then send to the Heads.
  if (cycle.calcDepts.length === 0) return { text: ka ? tc('nsCalcKa') : tc('nsCalc'), tab: 'calc' };
  const toSend = cycle.heads.filter((h) => cycle.calcDepts.includes(String(h.deptId)) && (h.status === 'draft' || h.status === 'returned'));
  // Operation: before the send, the Key Account target of the Heads with a Key Account department (Admin workflow step).
  if (!ka && toSend.length && l.ka && l.links) {
    const kaHeads = new Map(l.ka.heads.map((h) => [h.deptId, h]));
    const waiting = l.links.filter((k) => k.opsDeptId !== null && toSend.some((h) => h.deptId === k.opsDeptId)
      && !l.ka!.calcDepts.includes(String(k.kaDeptId)) && ['draft', 'returned', undefined].includes(kaHeads.get(k.kaDeptId)?.status));
    if (waiting.length) {
      return { text: tc('nsKaTarget', { names: waiting.map((k) => kaHeads.get(k.kaDeptId)?.name ?? String(k.kaDeptId)).join(', ') }),
        tab: null, href: `/admin/cycle/ka/${period}?tab=calc`, hrefLabel: tc('nsKaTargetGo') };
    }
  }
  const returned = cycle.heads.filter((h) => h.status === 'returned');
  if (returned.length) return { text: tc('nsReturned', { names: returned.map((h) => h.name).join(', ') }), tab: 'control' };
  if (toSend.length && ka) return { text: tc('nsKaSendFromOps'), tab: null, href: `/admin/cycle/ops/${period}?tab=control`, hrefLabel: tc('nsKaSendFromOpsGo') };
  if (toSend.length) return { text: tc('nsSend', { n: toSend.length }), tab: 'control' };
  const notCalc = cycle.heads.filter((h) => !cycle.calcDepts.includes(String(h.deptId)) && h.status === 'draft');
  if (notCalc.length && cycle.heads.every((h) => h.status === 'draft' || !cycle.calcDepts.includes(String(h.deptId)))) return { text: ka ? tc('nsCalcKa') : tc('nsCalc'), tab: 'calc' };
  // 3. The Heads review, distribute and approve; then the levels below.
  const pending = cycle.heads.filter((h) => h.status === 'pending');
  if (pending.length) return { text: tc('nsWaitHeads', { n: pending.length }), tab: 'workflow', wait: true };
  if (cycle.heads.length && cycle.heads.every((h) => h.monthState === 'complete')) return { text: tc('nsDone'), tab: 'routes', done: true };
  return { text: tc('nsWaitLevels'), tab: 'workflow', wait: true };
}

const TAB_LABEL: Record<TabId, 'tabStart' | 'tabCalc' | 'tabControl' | 'tabWorkflow' | 'tabRoutes'> = {
  start: 'tabStart', calc: 'tabCalc', control: 'tabControl', workflow: 'tabWorkflow', routes: 'tabRoutes',
};

export function NextStep({ ws, period, l, tab, onGo }: { ws: Workspace; period: string; l: Loaded; tab: TabId; onGo: (t: TabId) => void }) {
  useLang();
  const n = nextStep(ws, period, l);
  return (
    <div class={`banner ${n.done ? 'ok' : n.wait ? 'info' : 'warn'} cy-next`} role="status" data-testid="next-step">
      <b>{n.done ? tc('nsTitleDone') : n.wait ? tc('nsTitleWait') : tc('nsTitle')}</b> {n.text}
      {n.tab && n.tab !== tab && (
        <button type="button" class="btn primary" data-testid="next-go" onClick={() => onGo(n.tab!)}>{tc('nsGo', { tab: tc(TAB_LABEL[n.tab]) })}</button>
      )}
      {n.href && <a class="btn primary" data-testid="next-go-ka" href={n.href}>{n.hrefLabel}</a>}
    </div>
  );
}
