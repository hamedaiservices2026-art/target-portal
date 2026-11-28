// Admin › Workflow: where every person is in the month. The cycle stepper,
// then for each Head of Department their own steps (calculated, sent,
// approved, managers, supervisors, final) and every manager and supervisor
// with their status and submit time.
import { useState } from 'preact/hooks';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto, ProgressNode } from '../../../worker/services/cycle';
import type { OrgDto } from '../../../worker/services/cycleData';
import { api } from '../../api';
import { ConfirmButton, errText } from '../../components/AdminBits';
import { fmtDateTime } from '../../format';
import { useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { useAsync } from '../../cycle/load';
import { Section } from '../../cycle/ui';
import { workflowSteps } from './Reports';

type Loaded = { cycle: CycleDto; org: OrgDto };
type Progress = { monthId: number | null; deadline: string | null; nodes: ProgressNode[] };

const STATUS_KEY: Record<string, string> = { waiting: 'nsWaiting', in_progress: 'nsWorking', submitted: 'nsSubmitted' };

function depthOf(n: ProgressNode, byId: Map<number, ProgressNode>): number {
  let d = 0;
  for (let p = n.parentId; p !== null; p = byId.get(p)?.parentId ?? null) d++;
  return d;
}

export function WorkflowTab({ ws, period, l }: { ws: Workspace; period: string; l: Loaded }) {
  const [lang] = useLang();
  const { cycle } = l;
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** Admin: a submitted target goes back to that manager / supervisor to change, with everyone under them (they start again after). */
  async function giveBack(n: ProgressNode) {
    setMsg(null);
    try {
      // Everyone under them is returned too: their turns open again once this target is resubmitted.
      await api('POST', `/api/admin/months/${prog.data!.monthId}/nodes/${n.nodeId}/reopen`, { team: true });
      setMsg({ ok: true, text: tc('wfReturned', { name: n.userName ?? n.name }) });
      prog.reload();
    } catch (x) {
      const t = errText(x);
      setMsg({ ok: false, text: /reopen_pending_below/.test(t) ? tc('wfReturnPendingBelow') : t });
    }
  }
  const prog = useAsync(() => api<Progress>('GET', `/api/cycle/${ws}/${period}/progress`), [ws, period, cycle.version]);
  const steps = workflowSteps(cycle);
  const nodes = prog.data?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const levelName = (d: number) => (d === 0 ? tc('lvHead') : d === 1 ? (ws === 'ka' ? 'KAM' : tc('lvManager')) : tc('lvSupervisor'));

  return (
    <>
      <Section title={tc('tabWorkflow')} right={prog.data?.deadline ? <span class="muted small">{tc('deadline')}: {prog.data.deadline}</span> : undefined}>
        <ol class="cy-stepper" data-testid="workflow-steps">
          {steps.map((s, i) => (
            <li key={s.key} class={s.done ? 'done' : s.current ? 'current' : ''}>
              <span class="n">{s.done ? '✓' : i + 1}</span>{tc(s.key as 'wfOpen')}
            </li>
          ))}
        </ol>
        <p class="small muted">{tc('cdStatus')}: <b>{tc(`cd_${cycle.cdStatus}` as 'cd_draft')}</b>{!cycle.settings.cdStep && ` (${tc('off')})`}</p>
      </Section>
      {prog.error && <div class="alert" role="alert">{prog.error}</div>}
      {msg && <div class={msg.ok ? 'banner ok' : 'alert'} role={msg.ok ? 'status' : 'alert'} data-testid="wf-msg">{msg.text}</div>}
      {cycle.heads.map((h) => {
        const mine = nodes.filter((n) => n.deptId === h.deptId);
        const withDepth = mine.map((n) => ({ n, d: depthOf(n, byId) }));
        const level = (d: number) => withDepth.filter((x) => x.d === d && mine.some((c) => c.parentId === x.n.nodeId));
        const allSubmitted = (d: number) => { const xs = level(d); return xs.length > 0 && xs.every((x) => x.n.status === 'submitted'); };
        const hSteps: [string, boolean][] = [
          ['wfHCalc', cycle.calcDepts.includes(String(h.deptId))],
          ['wfHSent', h.status !== 'draft'],
          ['wfHApproved', h.status === 'approved'],
          ['wfHManagers', allSubmitted(0)],
          ['wfHSupervisors', allSubmitted(1) || (level(1).length === 0 && allSubmitted(0))],
          ['wfHFinal', h.monthState === 'complete'],
        ];
        const firstOpen = hSteps.findIndex(([, d]) => !d);
        const counts = { waiting: 0, in_progress: 0, submitted: 0 } as Record<string, number>;
        for (const n of mine) counts[n.status] = (counts[n.status] ?? 0) + 1;
        const isOpen = open.has(h.deptId);
        return (
          <section key={h.deptId} class="card cy-section" data-testid="wf-head">
            <div class="cy-section-head">
              <h2>{h.name} <span class="muted small">{h.headName ?? ''}</span></h2>
              <span class={`pill ${h.status}`}>{tc(`hs_${h.status}` as 'hs_draft')}</span>
            </div>
            <ol class="cy-stepper">
              {hSteps.map(([k, done], i) => (
                <li key={k} class={done ? 'done' : i === firstOpen ? 'current' : ''}><span class="n">{done ? '✓' : i + 1}</span>{tc(k as 'wfHCalc')}</li>
              ))}
            </ol>
            {h.status === 'returned' && h.comment && <p class="small">{tc('comment')}: <q>{h.comment}</q></p>}
            {mine.length > 0 && (
              <>
                <button type="button" class="btn link small" aria-expanded={isOpen} onClick={() => {
                  const next = new Set(open);
                  if (isOpen) next.delete(h.deptId); else next.add(h.deptId);
                  setOpen(next);
                }}>
                  {isOpen ? '▾' : '▸'} {tc('progressText', { s: counts.submitted ?? 0, o: counts.in_progress ?? 0, w: counts.waiting ?? 0 })}
                </button>
                {isOpen && (
                  <div class="tablewrap"><table class="ad-table cy-table">
                    <thead><tr><th>{tc('name')}</th><th>{tc('level')}</th><th>{tc('user')}</th><th>{tc('status')}</th><th>{tc('openedAt')}</th><th>{tc('submittedAt')}</th><th /></tr></thead>
                    <tbody>{withDepth.sort((a, b) => a.d - b.d || a.n.name.localeCompare(b.n.name)).map(({ n, d }) => (
                      <tr key={n.nodeId}>
                        <td><span style={{ paddingInlineStart: `${d * 14}px` }}>{n.name}</span></td>
                        <td class="small">{levelName(d)}</td>
                        <td class="small">{n.userName ?? '—'}</td>
                        <td><span class={`pill ${n.status === 'submitted' ? 'ok' : n.status === 'in_progress' ? 'warn' : ''}`}>{tc((STATUS_KEY[n.status] ?? 'nsWaiting') as 'nsWaiting')}</span></td>
                        <td class="small">{fmtDateTime(n.openedAt, lang)}</td>
                        <td class="small">{fmtDateTime(n.submittedAt, lang)}</td>
                        <td>{n.status === 'submitted' && prog.data?.monthId && (
                          <ConfirmButton label={tc('wfReturn')} question={tc('wfReturnQ', { name: n.userName ?? n.name })} yesLabel={tc('wfReturn')} danger={false} testId="wf-return"
                            onConfirm={() => giveBack(n)} />
                        )}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
