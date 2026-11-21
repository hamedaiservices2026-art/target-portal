// Every email carries both languages; the recipient's language comes first.

export type Lang = 'en' | 'ar';
export type Mail = { subject: string; text: string; html: string };

export function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

type Part = { subject: string; lines: string[]; linkLabel: string };

function compose(lang: Lang, en: Part, ar: Part, link: string | null): Mail {
  const parts: [Lang, Part][] = lang === 'ar' ? [['ar', ar], ['en', en]] : [['en', en], ['ar', ar]];
  const subject = parts.map(([, p]) => p.subject).join(' | ');
  const text = parts.map(([, p]) => [...p.lines, ...(link ? [`${p.linkLabel}: ${link}`] : [])].join('\n')).join('\n\n---\n\n');
  const html = parts.map(([l, p]) => {
    const body = p.lines.map((x) => `<p>${esc(x)}</p>`).join('')
      + (link ? `<p><a href="${esc(link)}">${esc(p.linkLabel)}</a></p>` : '');
    return l === 'ar' ? `<div dir="rtl" lang="ar">${body}</div>` : `<div lang="en">${body}</div>`;
  }).join('<hr>');
  return { subject, text, html };
}

export type TurnInfo = { name: string; period: string; nodeName: string; deadline: string | null; link: string | null; lang?: Lang };

export function turnOpened(i: TurnInfo): Mail {
  return compose(i.lang ?? 'en',
    {
      subject: `Your turn: ${i.nodeName} (${i.period})`,
      lines: [`Hello ${i.name},`, `Your turn is open: ${i.nodeName}, period ${i.period}.`, ...(i.deadline ? [`Deadline: ${i.deadline}`] : [])],
      linkLabel: 'Open',
    },
    {
      subject: `دورك الآن: ${i.nodeName} (${i.period})`,
      lines: [`مرحباً ${i.name}،`, `دورك مفتوح: ${i.nodeName}، الفترة ${i.period}.`, ...(i.deadline ? [`الموعد النهائي: ${i.deadline}`] : [])],
      linkLabel: 'فتح',
    }, i.link);
}

export function deadlineReminder(i: TurnInfo): Mail {
  return compose(i.lang ?? 'en',
    {
      subject: `Reminder: ${i.nodeName} due tomorrow (${i.period})`,
      lines: [`Hello ${i.name},`, `${i.nodeName}, period ${i.period}, is still in progress.`, ...(i.deadline ? [`Deadline: ${i.deadline} (tomorrow)`] : [])],
      linkLabel: 'Open',
    },
    {
      subject: `تذكير: ${i.nodeName} تنتهي غداً (${i.period})`,
      lines: [`مرحباً ${i.name}،`, `${i.nodeName}، الفترة ${i.period}، لم تكتمل بعد.`, ...(i.deadline ? [`الموعد النهائي: ${i.deadline} (غداً)`] : [])],
      linkLabel: 'فتح',
    }, i.link);
}

export type DeptInfo = { period: string; deptName: string; link: string | null; lang?: Lang };

export function departmentComplete(i: DeptInfo): Mail {
  return compose(i.lang ?? 'en',
    {
      subject: `Department complete: ${i.deptName} (${i.period})`,
      lines: [`All turns in ${i.deptName} are submitted for period ${i.period}.`],
      linkLabel: 'Open',
    },
    {
      subject: `اكتمل القسم: ${i.deptName} (${i.period})`,
      lines: [`تم تسليم جميع الأدوار في ${i.deptName} للفترة ${i.period}.`],
      linkLabel: 'فتح',
    }, i.link);
}
