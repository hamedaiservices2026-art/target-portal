// In-app notifications: a bell with the unread count and the last 50 items.
import { useEffect, useState } from 'preact/hooks';
import type { NotificationDto } from '../../worker/services/notify';
import { api } from '../api';
import { tc } from '../cycle/i18n';
import { fmtDateTime } from '../format';
import { useLang } from '../i18n';

export function Bell() {
  const [lang] = useLang();
  const [data, setData] = useState<{ items: NotificationDto[]; unread: number } | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => api<{ items: NotificationDto[]; unread: number }>('GET', '/api/my/notifications').then(setData).catch(() => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => clearInterval(id);
  }, []);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && data && data.unread > 0) {
      await api('POST', '/api/my/notifications/read', {}).catch(() => undefined);
      setData({ items: data.items, unread: 0 });
    }
  }
  const unread = data?.unread ?? 0;
  return (
    <div class="bell">
      <button type="button" class="btn" aria-expanded={open} aria-label={tc('notifications')} data-testid="bell" onClick={() => void toggle()}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span class="count" data-testid="bell-count">{unread}</span>}
      </button>
      {open && (
        <div class="bell-list" role="dialog" aria-label={tc('notifications')}>
          {!data?.items.length && <p class="muted small">{tc('noNotifications')}</p>}
          <ul>
            {data?.items.map((n) => (
              <li key={n.id} class={n.read ? '' : 'unread'}>
                {n.link ? <a href={n.link} onClick={() => setOpen(false)}>{n.text[lang] ?? n.text.en}</a> : <span>{n.text[lang] ?? n.text.en}</span>}
                <div class="muted small">{fmtDateTime(n.at, lang)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
