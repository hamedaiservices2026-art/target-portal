// Cloudflare deploy for CI (GitHub Actions). Run: node scripts/deploy-ci.mjs
// Creates the D1 database on first run, patches the database_id into the
// CI checkout's wrangler.jsonc (never committed), applies migrations, builds,
// deploys, and sets optional secrets (values piped via stdin, never logged).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DB_NAME = 'target-portal';
const CONFIG_PATH = 'wrangler.jsonc';
const OPTIONAL_SECRETS = ['BOOTSTRAP_ADMIN_PASSWORD', 'BREVO_API_KEY', 'MAIL_FROM', 'APP_URL'];

/** Strip // and /* *\/ comments and trailing commas from JSONC, respecting strings. */
function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Replace the database_id of the D1 binding whose database_name is "target-portal".
 * Comments and formatting are normalized; the result is plain (valid) JSONC.
 * @param {string} wranglerJsoncText
 * @param {string} databaseId
 * @returns {string}
 */
export function patchDatabaseId(wranglerJsoncText, databaseId) {
  const config = JSON.parse(stripJsonc(wranglerJsoncText));
  const binding = Array.isArray(config.d1_databases)
    ? config.d1_databases.find((d) => d && d.database_name === DB_NAME)
    : undefined;
  if (!binding) throw new Error(`No D1 binding with database_name "${DB_NAME}" found in wrangler config`);
  binding.database_id = databaseId;
  return JSON.stringify(config, null, 2) + '\n';
}

/** Parse `wrangler d1 list --json` stdout defensively (banner lines may precede the JSON). */
export function parseDatabaseList(stdout) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(stdout.trim());
  if (parsed === undefined) {
    const last = stdout.lastIndexOf(']');
    for (let start = stdout.indexOf('['); start !== -1 && last > start; start = stdout.indexOf('[', start + 1)) {
      parsed = tryParse(stdout.slice(start, last + 1));
      if (parsed !== undefined) break;
    }
  }
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.result)) parsed = parsed.result;
  return Array.isArray(parsed) ? parsed : [];
}

export function findDatabaseId(list) {
  const db = list.find((d) => d && d.name === DB_NAME);
  return db ? db.uuid ?? db.id : undefined;
}

function wrangler(args, { input, echo = true } = {}) {
  const r = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (echo) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function must(result, what) {
  if (result.status !== 0) {
    console.error(`FAILED: ${what} (exit ${result.status})`);
    process.exit(1);
  }
  return result;
}

function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.log(
      'Cloudflare deploy skipped: add repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID ' +
        '(Settings > Secrets and variables > Actions) to enable deploy.',
    );
    return;
  }

  const listDatabases = () => parseDatabaseList(must(wrangler(['d1', 'list', '--json'], { echo: false }), 'wrangler d1 list').stdout);
  let id = findDatabaseId(listDatabases());
  if (!id) {
    console.log(`D1 database "${DB_NAME}" not found; creating it.`);
    must(wrangler(['d1', 'create', DB_NAME]), 'wrangler d1 create');
    id = findDatabaseId(listDatabases());
  }
  if (!id) {
    console.error(`FAILED: could not determine the uuid of D1 database "${DB_NAME}"`);
    process.exit(1);
  }
  console.log(`Using D1 database "${DB_NAME}" (${id}).`);

  writeFileSync(CONFIG_PATH, patchDatabaseId(readFileSync(CONFIG_PATH, 'utf8'), id));

  must(wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']), 'wrangler d1 migrations apply');
  runDataResets();

  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('FAILED: npm run build');
    process.exit(1);
  }
  const deploy = must(wrangler(['deploy']), 'wrangler deploy');

  for (const name of OPTIONAL_SECRETS) {
    const value = process.env[name];
    if (!value) continue;
    // Value goes via stdin only; output is not echoed so nothing secret can reach the logs.
    const r = wrangler(['secret', 'put', name], { input: value, echo: false });
    if (r.status !== 0) {
      console.error(`FAILED: wrangler secret put ${name} (exit ${r.status})`);
      process.exit(1);
    }
    console.log(`Secret ${name} set.`);
  }

  const url = (deploy.stdout + deploy.stderr).match(/https:\/\/\S+\.workers\.dev\S*/);
  console.log(url ? `Deployed URL: ${url[0]}` : 'Deployed (URL line not found in wrangler output).');
}

/** Rows of one SQL query on the remote database (wrangler --json output). */
function query(sql) {
  const r = must(wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', '--command', sql], { echo: false }), `query: ${sql}`);
  const parsed = parseDatabaseList(r.stdout); // the same tolerant parse: banner lines may come first
  return parsed[0] && Array.isArray(parsed[0].results) ? parsed[0].results : [];
}

const RESET_TABLES = ['data_routes', 'data_months', 'cycles', 'head_approvals', 'notifications', 'months'];

/**
 * One-time data clean-ups (scripts/data-reset/<date>.sql), each run once: the
 * file writes the marker settings row data_reset_<yyyymmdd> at its end.
 * Only row counts are printed.
 */
export function runDataResets(dir = 'scripts/data-reset') {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const key = `data_reset_${f.replace(/\D/g, '')}`;
    if (query(`SELECT value FROM settings WHERE key = '${key}'`).length) {
      console.log(`Data reset ${f}: already done.`);
      continue;
    }
    const counts = () => RESET_TABLES.map((t) => `${t}=${query(`SELECT COUNT(*) AS n FROM ${t}`)[0]?.n ?? '?'}`).join(' ');
    console.log(`Data reset ${f}: before ${counts()}`);
    must(wrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--file', `${dir}/${f}`], { echo: false }), `data reset ${f}`);
    console.log(`Data reset ${f}: after  ${counts()}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
