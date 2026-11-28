// Manager home: the nodes assigned to the signed-in user, grouped by month.
import { useLocation } from 'preact-iso';
import { useEffect, useState } from 'preact/hooks';
import type { TaskDto } from '../../worker/services/distribution';
import { api, ApiError } from '../api';
import { tc } from '../cycle/i18n';
import { StatusPill } from '../components/StatusPill';
import { fmtDeadline, fmtPeriod } from '../format';
import { t, useLang, type TextKey } from '../i18n';
import { useSession } from '../session';

type Month = { monthId: number; period: string; tasks: TaskDto[] };

/** Server order is newest month first; inside a month the open turns come first (stable otherwise). */
export function groupByMonth(tasks: TaskDto[]): Month[] {
  const months: Month[] = [];
  for (const task of tasks) {
    let m = months.find((x) => x.monthId === task.monthId);
    if (!m) months.push((m = { monthId: task.monthId, period: task.period, tasks: [] }));
    m.tasks.push(task);
  }
  for (const m of months) {
    m.tasks = [...m.tasks.filter((x) => x.status === 'in_progress'), ...m.tasks.filter((x) => x.status !== 'in_progress')];
  }
  return months;
}

export function Home() {
  const [lang] = useLang();
  const { user } = useSession();
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [err, setErr] = useState<TextKey | null>(null);

  const load = () => {
    setErr(null);
    api<TaskDto[]>('GET', '/api/my/tasks').then(setTasks).catch((e) => {
      if (e instanceof ApiError && e.status === 401) return; // the app goes to /login
      setErr('homeLoadError');
    });
  };
  useEffect(load, []);

  return (
    <section class="home" data-testid="home">
      <h1>{t('homeTitle')}</h1>
      <p class="muted">{t('homeWelcome')}, {user?.name}.</p>
      {err && (
        <div class="alert" role="alert">
          {t(err)} <button type="button" class="btn" onClick={load}>{t('dsRetry')}</button>
        </div>
      )}
      {!err && !tasks && <p class="muted">{t('loading')}</p>}
      {tasks && tasks.length === 0 && (
        user?.role === 'admin'
          ? <p class="card muted" data-testid="admin-hint">{t('homeAdminHint')} <a href="/admin/cycle">{tc('navCycle')}</a></p>
          : <p class="card muted" data-testid="no-tasks">{t('homeEmpty')}</p>
      )}
      {tasks && groupByMonth(tasks).map((m) => (
        <div class="card month" data-testid="month-group" key={m.monthId}>
          <h2>{fmtPeriod(m.period, lang)}</h2>
          <ul class="tasks">
            {m.tasks.map((task) => (
              <li class="task" data-testid="task" key={task.nodeId}>
                <div class="who">
                  <b>{task.nodeName}</b>
                  <span class="muted"><bdi>{task.deptCode}</bdi></span>
                </div>
                <StatusPill status={task.status} testId="task-status" />
                <span class="muted">
                  {t('dsDeadline')}: <span data-testid="task-deadline">{fmtDeadline(task.deadline, lang)}</span>
                </span>
                <span class="spacer" />
                <a class="btn" href={`/m/${task.monthId}/n/${task.nodeId}/branch`}>{t('viewBranch')}</a>
                <a class="btn primary" href={`/m/${task.monthId}/n/${task.nodeId}`}>{t('open')}</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** `/m/:mid` (the link in the department-complete email): admins go to the month page, managers home. */
export function MonthRedirect({ mid = '' }: { mid?: string }) {
  const { route } = useLocation();
  const { user } = useSession();
  useEffect(() => {
    route(user?.role === 'admin' ? `/admin/months/${encodeURIComponent(mid)}` : '/', true);
  }, [mid, user?.role]);
  return null;
}
