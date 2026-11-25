// שמירת נתונים: Postgres כשמוגדר DATABASE_URL (ב-Render חובה, כי הדיסק שם נמחק),
// ואחרת קבצי JSON בתיקייה מקומית (להרצה על המחשב שלך).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';

let pool = null;

export async function initStore(){
  if (!cfg.databaseUrl){
    await fs.mkdir(cfg.dataDir, { recursive: true });
    console.log(`[store] שמירה לקבצים בתיקייה ${path.resolve(cfg.dataDir)}`);
    return;
  }
  const { default: pg } = await import('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(cfg.databaseUrl);
  const hasSslMode = /[?&]sslmode=/.test(cfg.databaseUrl);
  pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5, ...(local || hasSslMode ? {} : { ssl: { rejectUnauthorized: true } }) });
  await pool.query(`
    create table if not exists app_kv (
      user_email text not null,
      k text not null,
      v jsonb not null,
      updated_at timestamptz not null default now(),
      primary key (user_email, k)
    );
    create table if not exists app_tokens (
      user_email text primary key,
      refresh_enc text not null,
      scope text,
      updated_at timestamptz not null default now()
    );`);
  console.log('[store] מחובר ל-Postgres');
}

const userDir = email => path.join(cfg.dataDir, crypto.createHash('sha256').update(email).digest('hex').slice(0, 24));
async function readJson(file, fallback){ try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function writeJson(file, value){
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

export async function getAll(email){
  if (pool){
    const r = await pool.query('select k, v from app_kv where user_email = $1', [email]);
    return Object.fromEntries(r.rows.map(row => [row.k, row.v]));
  }
  return readJson(path.join(userDir(email), 'state.json'), {});
}

// קריאת מפתח אחד בלבד (בלי לטעון את כל הנתונים)
export async function getKey(email, key){
  if (pool){
    const r = await pool.query('select v from app_kv where user_email = $1 and k = $2', [email, key]);
    return r.rows[0]?.v ?? null;
  }
  const all = await readJson(path.join(userDir(email), 'state.json'), {});
  return all[key] ?? null;
}

// כתיבות לאותו משתמש נעשות אחת אחרי השנייה, כדי שלא ידרסו זו את זו בשמירה לקבצים
const chains = new Map();
export function put(email, key, value){
  const prev = chains.get(email) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    if (pool){
      await pool.query(`insert into app_kv (user_email, k, v, updated_at) values ($1, $2, $3::jsonb, now())
        on conflict (user_email, k) do update set v = excluded.v, updated_at = now()`, [email, key, JSON.stringify(value)]);
      return;
    }
    const file = path.join(userDir(email), 'state.json');
    const all = await readJson(file, {});
    all[key] = value;
    await writeJson(file, all);
  });
  chains.set(email, next);
  return next;
}

export async function getToken(email){
  if (pool){
    const r = await pool.query('select refresh_enc, scope from app_tokens where user_email = $1', [email]);
    return r.rows[0] || null;
  }
  return readJson(path.join(userDir(email), 'token.json'), null);
}

export async function putToken(email, refresh_enc, scope){
  if (pool){
    await pool.query(`insert into app_tokens (user_email, refresh_enc, scope, updated_at) values ($1, $2, $3, now())
      on conflict (user_email) do update set refresh_enc = excluded.refresh_enc, scope = excluded.scope, updated_at = now()`, [email, refresh_enc, scope]);
    return;
  }
  await writeJson(path.join(userDir(email), 'token.json'), { refresh_enc, scope });
}

export async function deleteToken(email){
  if (pool){ await pool.query('delete from app_tokens where user_email = $1', [email]); return; }
  await fs.rm(path.join(userDir(email), 'token.json'), { force: true });
}
