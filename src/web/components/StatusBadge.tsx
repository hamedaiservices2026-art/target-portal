import type { PackCheck } from '../../shared/rules';
import { fmtNum, t, tf } from '../i18n';

/** The words for a pack's status (never colour alone): OK / Over by N / Short by N / Moved too much / Invalid number. */
export function statusText(c: Pick<PackCheck, 'status' | 'diff'>): string {
  switch (c.status) {
    case 'ok': return t('dsStOk');
    case 'over': return tf('dsStOver', { n: fmtNum(Math.abs(c.diff)) });
    case 'short': return tf('dsStShort', { n: fmtNum(Math.abs(c.diff)) });
    case 'moved_too_much': return t('dsStMoved');
    default: return t('dsStInvalid');
  }
}

export function StatusBadge({ check, testId }: { check: Pick<PackCheck, 'status' | 'diff'>; testId?: string }) {
  return (
    <span class={`status ${check.status === 'ok' ? 'ok' : 'bad'}`} data-testid={testId}>
      {statusText(check)}
    </span>
  );
}
