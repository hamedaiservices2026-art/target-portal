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
