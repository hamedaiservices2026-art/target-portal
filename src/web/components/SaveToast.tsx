// One message after every save, anywhere in the app: "Saved." when the server
// took the change, or the error when it did not (see API_WRITE in api.ts).
import { useEffect, useRef, useState } from 'preact/hooks';
import { API_WRITE, type ApiWriteDetail } from '../api';
import { t, useLang } from '../i18n';
import { errText } from './AdminBits';

export function SaveToast() {
  useLang();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; n: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<ApiWriteDetail>).detail;
      setMsg((m) => ({ ok: d.ok, text: d.ok ? t('adSaved') : errText(d.error), n: (m?.n ?? 0) + 1 }));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), d.ok ? 3500 : 8000);
    };
    window.addEventListener(API_WRITE, on);
    return () => window.removeEventListener(API_WRITE, on);
  }, []);
  if (!msg) return null;
  return (
    <div class={`save-toast ${msg.ok ? 'ok' : 'bad'}`} aria-live={msg.ok ? "polite" : "assertive"} data-testid="save-toast" key={msg.n}>
      <span aria-hidden="true">{msg.ok ? '✓' : '!'}</span> {msg.text}
      <button type="button" class="btn link" aria-label={t('toastClose')} onClick={() => setMsg(null)}>×</button>
    </div>
  );
}
