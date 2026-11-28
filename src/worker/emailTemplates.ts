// Every email carries both languages; the recipient's language comes first.

export type Lang = 'en' | 'ar';
export type Mail = { subject: string; text: string; html: string };

export function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

type Part = { subject: string; lines: string[]; linkLabel: string; summary?: { title: string; rows: [string, string][] } };

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

function compose(lang: Lang, en: Part, ar: Part, link: string | null): Mail {
  const parts: [Lang, Part][] = lang === 'ar' ? [['ar', ar], ['en', en]] : [['en', en], ['ar', ar]];
  const subject = parts.map(([, p]) => p.subject).join(' | ');
  const text = parts.map(([, p]) => [
    ...p.lines,
    ...(p.summary ? [p.summary.title, ...p.summary.rows.map(([a, b]) => `  ${a}: ${b}`)] : []),
    ...(link ? [`${p.linkLabel}: ${link}`] : []),
  ].join('\n')).join('\n\n---\n\n');
  const html = parts.map(([l, p]) => {
    const table = p.summary
      ? `<p><b>${esc(p.summary.title)}</b></p><table style="border-collapse:collapse;margin:0 0 12px">${p.summary.rows.map(([a, b], i) => {
        const last = i === p.summary!.rows.length - 1;
        const st = `border:1px solid #ccc;padding:4px 10px;${last ? 'font-weight:bold;background:#f2f4f8;' : ''}`;
        return `<tr><td style="${st}">${esc(a)}</td><td style="${st}text-align:right">${esc(b)}</td></tr>`;
      }).join('')}</table>`
      : '';
    const body = p.lines.map((x) => `<p>${esc(x)}</p>`).join('') + table
      + (link ? `<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#0b4ea2;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">${esc(p.linkLabel)}</a></p>` : '');
    return l === 'ar' ? `<div dir="rtl" lang="ar">${body}</div>` : `<div lang="en">${body}</div>`;
  }).join('<hr>');
  return { subject, text, html };
}

export type TurnInfo = { name: string; period: string; nodeName: string; deadline: string | null; link: string | null; lang?: Lang; summary?: { label: string; cases: number }[] };

const AR_CAT: Record<string, string> = { Total: 'الإجمالي' };
const sum = (i: TurnInfo, title: string, ar: boolean) => (i.summary?.length
  ? { title, rows: i.summary.map((r): [string, string] => [ar ? AR_CAT[r.label] ?? r.label : r.label, `${fmt(r.cases)}${ar ? ' كرتون' : ' cases'}`]) }
  : undefined);

export function turnOpened(i: TurnInfo): Mail {
  return compose(i.lang ?? 'en',
    {
      subject: `Your turn: ${i.nodeName} (${i.period})`,
      lines: [`Hello ${i.name},`, `Your ${i.period} target is ready: ${i.nodeName}. Please review it, distribute it and submit it before the deadline.`, ...(i.deadline ? [`Deadline to finalize: ${i.deadline}`] : [])],
      linkLabel: 'Open my target',
      summary: sum(i, `Your target for ${i.period}`, false),
    },
    {
      subject: `دورك الآن: ${i.nodeName} (${i.period})`,
      lines: [`مرحباً ${i.name}،`, `هدف ${i.period} جاهز: ${i.nodeName}. يرجى مراجعته وتوزيعه وإرساله قبل الموعد النهائي.`, ...(i.deadline ? [`الموعد النهائي للاعتماد: ${i.deadline}`] : [])],
      linkLabel: 'فتح هدفي',
      summary: sum(i, `هدفك لشهر ${i.period}`, true),
    }, i.link);
}

export function deadlineReminder(i: TurnInfo): Mail {
  return compose(i.lang ?? 'en',
    {
      subject: `Reminder: ${i.nodeName} due tomorrow (${i.period})`,
      lines: [`Hello ${i.name},`, `${i.nodeName}, period ${i.period}, is still in progress.`, ...(i.deadline ? [`Deadline: ${i.deadline} (tomorrow)`] : [])],
      linkLabel: 'Open my target',
      summary: sum(i, `Your target for ${i.period}`, false),
    },
    {
      subject: `تذكير: ${i.nodeName} تنتهي غداً (${i.period})`,
      lines: [`مرحباً ${i.name}،`, `${i.nodeName}، الفترة ${i.period}، لم تكتمل بعد.`, ...(i.deadline ? [`الموعد النهائي: ${i.deadline} (غداً)`] : [])],
      linkLabel: 'فتح هدفي',
      summary: sum(i, `هدفك لشهر ${i.period}`, true),
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
