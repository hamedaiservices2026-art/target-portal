// The company name and logo printed at the top of the approval template.
// Kept in the settings table (not in the code): the admin sets them once.
import { batch, one } from '../db';
import { auditStatement } from './audit';
import { bad, type Obj } from './masters';

const KEY = 'approval_brand_json';
const MAX_LOGO = 400_000; // characters of the data URL (about 300 KB of image)

export type Brand = { company: string; logo: string | null; logoW: number; logoH: number };

export async function getBrand(db: D1Database): Promise<Brand> {
  const r = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, KEY);
  try {
    const v = r ? (JSON.parse(r.value) as Partial<Brand>) : {};
    return {
      company: typeof v.company === 'string' ? v.company : '',
      logo: typeof v.logo === 'string' ? v.logo : null,
      logoW: typeof v.logoW === 'number' ? v.logoW : 0,
      logoH: typeof v.logoH === 'number' ? v.logoH : 0,
    };
  } catch {
    return { company: '', logo: null, logoW: 0, logoH: 0 };
  }
}

export async function setBrand(db: D1Database, actorId: number, body: Obj): Promise<Brand> {
  const company = typeof body.company === 'string' ? body.company.trim() : '';
  if (company.length > 120) throw bad('the company name must be at most 120 characters');
  let logo: string | null = null;
  if (body.logo !== null && body.logo !== undefined && body.logo !== '') {
    if (typeof body.logo !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(body.logo)) throw bad('the logo must be a PNG or JPEG image');
    if (body.logo.length > MAX_LOGO) throw bad('the logo is too large (at most about 300 KB)');
    logo = body.logo;
  }
  const dim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10000 ? Math.round(v) : 0);
  const brand: Brand = { company, logo, logoW: logo ? dim(body.logoW) : 0, logoH: logo ? dim(body.logoH) : 0 };
  await batch(db, [
    db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(KEY, JSON.stringify(brand)),
    auditStatement(db, actorId, 'brand.set', {}, { company, logo: logo ? 'set' : 'none' }),
  ]);
  return brand;
}

// The admin's own approval template (an Excel file): the download fills it with the month's numbers.
const TEMPLATE_KEY = 'approval_template_json';
const MAX_TEMPLATE = 1_900_000; // characters of base64 (about 1.4 MB of file)

export type ApprovalTemplate = { name: string; data: string | null; uploadedAt: string | null };

export async function getApprovalTemplate(db: D1Database): Promise<ApprovalTemplate> {
  const r = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, TEMPLATE_KEY);
  try {
    const v = r ? (JSON.parse(r.value) as Partial<ApprovalTemplate>) : {};
    return { name: typeof v.name === 'string' ? v.name : '', data: typeof v.data === 'string' ? v.data : null, uploadedAt: typeof v.uploadedAt === 'string' ? v.uploadedAt : null };
  } catch {
    return { name: '', data: null, uploadedAt: null };
  }
}

/** body: {name, data (base64 of the .xlsx / .xlsm)}; data null removes the template. */
export async function setApprovalTemplate(db: D1Database, actorId: number, body: Obj): Promise<ApprovalTemplate> {
  const remove = body.data === null || body.data === undefined || body.data === '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!remove) {
    if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.data)) throw bad('the template must be an Excel file');
    if (body.data.length > MAX_TEMPLATE) throw bad('the template is too large (at most about 1.4 MB)');
    if (!/\.(xlsx|xlsm)$/i.test(name)) throw bad('the template must be an .xlsx or .xlsm file');
  }
  const t: ApprovalTemplate = remove ? { name: '', data: null, uploadedAt: null } : { name, data: body.data as string, uploadedAt: new Date().toISOString() };
  await batch(db, [
    db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(TEMPLATE_KEY, JSON.stringify(t)),
    auditStatement(db, actorId, 'approval.template', {}, { name: remove ? null : name }),
  ]);
  return t;
}
