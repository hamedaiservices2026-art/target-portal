// Head of Department approval (handover section 4): the target Admin sent,
// by category; approve (distribution starts) or return with a comment.
import { useState } from 'preact/hooks';
import type { Workspace } from '../../../worker/auth';
import type { HeadStatus } from '../../../worker/services/cycle';
import { api } from '../../api';
import { errText, PageHead } from '../../components/AdminBits';
import { fmtDateTime } from '../../format';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { useAsync } from '../../cycle/load';
import { fmtCases, WS_LABEL } from '../../cycle/ui';

type Approval = {
  ws: Workspace; period: string; deptId: number; deptName: string; status: HeadStatus; sentTotal: number | null;
  sentByCategory: Record<string, number> | null; sentAt: string | null; deadline: string | null; comment: string | null;
};

function Item({ a, onDone }: { a: Approval; onDone: () => void }) {
  const [lang] = useLang();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/cycle/${a.ws}/${a.period}/heads/${a.deptId}`;
  async function act(kind: 'approve' | 'return') {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `${base}/${kind}`, kind === 'return' ? { comment } : {});
      onDone();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="card cy-section" data-testid="approval">
      <div class="cy-section-head">
        <h2>{a.deptName} · {a.period} <span class="muted small">{WS_LABEL(a.ws)}</span></h2>
        <span class={`pill ${a.status}`}>{tc(`hs_${a.status}` as 'hs_draft')}</span>
      </div>
      <p class="small muted">{tc('sentAt')}: {fmtDateTime(a.sentAt, lang)}{a.deadline && <> · {tc('deadline')}: {a.deadline}</>}</p>
      <div class="cy-cards">
        <div class="card cy-card"><h3>{tc('total')}</h3><p class="big">{fmtCases(a.sentTotal)}</p></div>
        {Object.entries(a.sentByCategory ?? {}).map(([c, n]) => <div key={c} class="card cy-card"><h3>{c}</h3><p class="big">{fmtNum(n)}</p></div>)}
      </div>
      {a.status === 'pending' && (
        <>
          <div class="actions">
            <button type="button" class="btn primary" disabled={busy} onClick={() => void act('approve')}>{tc('approve')}</button>
          </div>
          <textarea rows={2} value={comment} placeholder={tc('returnHeadHelp')} aria-label={tc('comment')} onInput={(e) => setComment(e.currentTarget.value)} />
          <div class="actions">
            <button type="button" class="btn danger" disabled={busy || !comment.trim()} onClick={() => void act('return')}>{tc('returnToAdmin')}</button>
          </div>
        </>
      )}
      {a.status === 'returned' && a.comment && <p class="small">{tc('yourComment')}: <q>{a.comment}</q></p>}
      {err && <div class="alert" role="alert">{err}</div>}
    </section>
  );
}

export function Approve() {
  useLang();
  const list = useAsync(() => api<{ approvals: Approval[] }>('GET', '/api/my/approvals'), []);
  const items = list.data?.approvals ?? [];
  return (
    <section class="cycle" data-testid="approve-page">
      <PageHead title={tc('approveTitle')} intro={tc('approveIntro')} />
      {list.error && <div class="alert" role="alert">{list.error}</div>}
      {list.data && items.length === 0 && <p class="card muted">{tc('noApprovals')}</p>}
      {items.map((a) => <Item key={`${a.ws}${a.period}${a.deptId}`} a={a} onDone={list.reload} />)}
    </section>
  );
}
