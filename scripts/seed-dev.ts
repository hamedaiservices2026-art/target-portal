// Ready-to-click local state, created THROUGH the HTTP API of a running local
// worker (so it exercises the real code paths). Usage:
//   npm run dev      (in another terminal, with BOOTSTRAP_ADMIN_PASSWORD in .dev.vars)
//   npm run seed
// Env: SEED_URL (default http://localhost:8787), BOOTSTRAP_ADMIN_PASSWORD
// (default admin-pass-123, the password the first-run admin is created with).
import { MOCKUP_PACKS, MOCKUP_ROUTES } from './seed-data.ts';

export const SEED_ADMIN = { username: 'admin', password: 'admin-pass-123' };
export const SEED_MANAGER_PASSWORD = 'manager-pass-123';
export const DELIVERY_SYSTEM = 'Presell – TT';
export const PERIOD = '2026-10';
export const DEADLINE = '2026-10-27';

type Json = Record<string, any>;

/** Group rule: AquafinA* is Water; CSD_*, PMIX, STING_250, STING_240 are CSD; the rest LRB-Others. */
export function groupOf(code: string): 'CSD' | 'Water' | 'LRB-Others' {
  if (code.startsWith('AquafinA')) return 'Water';
  if (code.startsWith('CSD_') || code === 'PMIX' || code === 'STING_250' || code === 'STING_240') return 'CSD';
  return 'LRB-Others';
}

class Session {
  private cookie = '';
  private base: string;
  constructor(base: string) {
    this.base = base;
  }

  async call(method: string, path: string, body?: unknown, expect: number[] = [200, 201]): Promise<Json> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    if (!expect.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    const set = res.headers.get('set-cookie');
    const sid = set && /(?:^|,\s*)sid=([^;]+)/.exec(set)?.[1];
    if (sid) this.cookie = `sid=${sid}`;
    return text ? (JSON.parse(text) as Json) : {};
  }

  async login(username: string, password: string): Promise<Json> {
    const res = await this.call('POST', '/auth/login', { username, password });
    // New accounts must choose their password on first sign-in: the seed keeps the one it set.
    if ((res as { user?: { mustChangePw?: boolean } }).user?.mustChangePw) return this.call('POST', '/me/password', { password });
    return res;
  }
}

export async function seed(
  base = process.env.SEED_URL ?? 'http://localhost:8787',
  adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? SEED_ADMIN.password,
  log: (line: string) => void = console.log,
): Promise<void> {
  const admin = new Session(base);
  await admin.login(SEED_ADMIN.username, adminPassword);

  const { users } = await admin.call('GET', '/admin/users');
  if ((users as Json[]).some((u) => u.username === 'head1')) {
    log('seed: already seeded, nothing to do');
    return;
  }

  const mk = (username: string, name: string) =>
    admin.call('POST', '/admin/users', { username, name, role: 'manager', password: SEED_MANAGER_PASSWORD });
  const head1 = await mk('head1', 'Head TT');
  const sup1 = await mk('sup1', 'Supervisor S-01');
  // Both sign in once so the seeded accounts keep the seed password (no first-sign-in change left).
  for (const u of ['head1', 'sup1']) await new Session(base).login(u, SEED_MANAGER_PASSWORD);
  const headUser = (head1.user ?? head1) as Json;
  const supUser = (sup1.user ?? sup1) as Json;

  for (const [i, code] of MOCKUP_PACKS.entries()) {
    await admin.call('POST', '/admin/packs', { code, grp: groupOf(code), sort: i });
  }

  const dept = await admin.call('POST', '/admin/departments', { code: 'TT', name: 'TT' });
  const deptId = ((dept.department ?? dept) as Json).id as number;
  const headNode = (await admin.call('POST', '/admin/nodes', { deptId, name: 'Head', parentId: null, managerUserId: headUser.id }));
  const headId = ((headNode.node ?? headNode) as Json).id as number;
  const supNode = (await admin.call('POST', '/admin/nodes', { deptId, name: 'Sup S-01', parentId: headId, managerUserId: supUser.id }));
  const supId = ((supNode.node ?? supNode) as Json).id as number;

  const leafIds: number[] = [];
  for (const r of MOCKUP_ROUTES) {
    const leaf = await admin.call('POST', '/admin/leaves', {
      deptId, nodeId: supId, deliverySystem: DELIVERY_SYSTEM, routeCode: r.route, label: r.route,
    });
    leafIds.push(((leaf.leaf ?? leaf) as Json).id as number);
  }

  const month = await admin.call('POST', '/admin/months', { period: PERIOD, deadline: DEADLINE });
  const monthId = ((month.month ?? month) as Json).id as number;
  const file = await admin.call('POST', `/admin/months/${monthId}/files`, { deptId, name: 'forecast-2026-10.xlsx' });
  await admin.call('POST', `/admin/months/${monthId}/files/${file.fileId}/batch`, {
    grids: MOCKUP_ROUTES.map((r, i) => ({ leafId: leafIds[i], salesmanId: r.salesman, values: r.values })),
  });
  await admin.call('POST', `/admin/months/${monthId}/depts/${deptId}/start`);

  // The Head node submits unchanged, which opens the turn of Sup S-01.
  const head = new Session(base);
  await head.login('head1', SEED_MANAGER_PASSWORD);
  const ws = await head.call('GET', `/months/${monthId}/nodes/${headId}`);
  await head.call('POST', `/months/${monthId}/nodes/${headId}/submit`, { version: ws.version });
  log(`seed: done (month ${monthId}, dept ${deptId}, Head node ${headId}, Sup S-01 node ${supId})`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  seed().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
