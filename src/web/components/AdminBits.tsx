// Small pieces shared by the admin setup screens: error text, data loading,
// inline confirm, and the "applies from next month" banner.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { fmtPeriod } from '../format';
import { t, tf, useLang } from '../i18n';

export type TreeChange = { appliedMonths: number[]; skippedMonths: number[]; error?: string };

/** What the person reads when a call fails: a plain sentence in their language, plus the server's reason (English) when it gave one. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const detail = typeof e.body.detail === 'string' ? ` (${e.body.detail})` : '';
    if (e.status === 400) return `${t('adErrInvalid')}${detail}`;
    if (e.status === 404) return t('adErrGone');
    if (e.status === 409) return `${t('adErrConflict')}${detail}`;
    if (e.status === 401) return t('errGeneric');
    return t('errGeneric');
  }
  if (e instanceof TypeError) return t('errNetwork');
  return t('errGeneric');
}

/** GET a JSON resource; `reload()` fetches again (keeping the old data on screen meanwhile). */
export function useResource<T>(path: string | null): {
  data: T | null; error: string | null; reload: () => void; setData: (v: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) {
      setData(null);
      return;
    }
    let live = true;
    setError(null);
    api<T>('GET', path).then((d) => live && setData(d)).catch((e) => {
      if (live && !(e instanceof ApiError && e.status === 401)) setError(errText(e));
    });
    return () => void (live = false);
  }, [path, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, reload, setData };
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  useLang();
  return (
    <div class="alert" role="alert">
      {message} <button type="button" class="btn" onClick={onRetry}>{t('dsRetry')}</button>
    </div>
  );
}

/** Two-step button: first click asks, second click does it. Not window.confirm, so it works in every browser and test. */
export function ConfirmButton({
  label, question, yesLabel, onConfirm, disabled, title, danger = true, testId,
}: {
  label: string; question: string; yesLabel: string; onConfirm: () => void | Promise<void>;
  disabled?: boolean; title?: string; danger?: boolean; testId?: string;
}) {
  useLang();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <button type="button" class="btn" disabled={disabled} title={title} data-testid={testId} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span class="confirm" role="group" aria-label={question}>
      <span class="confirm-q">{question}</span>
      <button
        type="button"
        class={`btn ${danger ? 'danger' : 'primary'}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {yesLabel}
      </button>
      <button type="button" class="btn" disabled={busy} onClick={() => setAsking(false)}>{t('dsCancel')}</button>
    </span>
  );
}

/** A tree change that could not reach a running month (skipped) or failed (error). */
export function TreeChangeBanner({ change }: { change: TreeChange | null }) {
  const [lang] = useLang();
  const skipped = change?.skippedMonths ?? [];
  const needMonths = skipped.length > 0;
  const months = useResource<{ months: { id: number; period: string }[] }>(needMonths ? '/api/admin/months' : null);
  if (!change) return null;
  const periods = skipped.map((id) => {
    const m = months.data?.months.find((x) => x.id === id);
    return m ? fmtPeriod(m.period, lang) : `#${id}`;
  });
  return (
    <>
      {needMonths && (
        <div class="banner warn" role="status" data-testid="tree-skipped">
          {tf('adNextMonth', { periods: periods.join(', ') })}
        </div>
      )}
      {change.error && (
        <div class="banner bad" role="alert" data-testid="tree-error">
          {t('adTreeError')} <span class="muted-in-banner">{change.error}</span>
        </div>
      )}
    </>
  );
}

export function PageHead({ title, intro, children }: { title: string; intro?: string; children?: ComponentChildren }) {
  return (
    <div class="ad-head">
      <div>
        <h1>{title}</h1>
        {intro && <p class="muted ad-intro">{intro}</p>}
      </div>
      {children}
    </div>
  );
}

/** A labelled field; the label is tied to the control through `id`. */
export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children}
      {hint && <small class="muted">{hint}</small>}
    </div>
  );
}
