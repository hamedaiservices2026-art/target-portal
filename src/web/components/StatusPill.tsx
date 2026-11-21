import type { NodeStatus } from '../../shared/types';
import { STATUS_LABEL } from '../format';
import { t, useLang } from '../i18n';

/** A node's status in words (waiting / in progress / submitted), never colour alone. */
export function StatusPill({ status, testId }: { status: NodeStatus; testId?: string }) {
  useLang();
  return <span class={`pill ${status}`} data-testid={testId}>{t(STATUS_LABEL[status])}</span>;
}
