// התאמת בנק וחשבוניות — שרת.
// מגיש את האתר (תיקיית public), מטפל בכניסה עם Google, קורא מ-Gmail, פונה ל-Claude ושומר את הנתונים.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, missingConfig } from './lib/config.js';
import { sign, verify, randomId } from './lib/crypto.js';
import * as store from './lib/store.js';
import * as google from './lib/google.js';
import { claude, parseJson, modelFor } from './lib/claude.js';
import { extractFromEmail, extractFromFile } from './lib/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const SESSION_DAYS = 30;
const STATE_KEYS = new Set(['settings', 'sources', 'tx', 'emails', 'docs', 'links', 'rejects', 'overrides', 'threads']);

/* ---------- אבטחה בסיסית ---------- */
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.sheetjs.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (cfg.production) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

function cookies(req){
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')){
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec){
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (cfg.production) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
const sessionOf = req => verify(cookies(req).sid);

/* ---------- כניסה עם Google ---------- */
app.get('/auth/login', (req, res) => {
  const miss = missingConfig().filter(k => k.startsWith('GOOGLE') || k === 'SESSION_SECRET' || k === 'ALLOWED_EMAILS');
  if (miss.length) return res.redirect('/?setup=1');
  const state = randomId(18), consent = req.query.consent === '1';
  setCookie(res, 'ost', sign({ state, consent, exp: Date.now() + 10 * 60 * 1000 }), 600);
  res.redirect(google.authUrl(state, { consent, loginHint: String(req.query.hint || '').slice(0, 200) }));
});

app.get('/auth/callback', async (req, res) => {
  const fail = code => res.redirect('/?login_error=' + encodeURIComponent(code));
  try {
    if (req.query.error) return fail(String(req.query.error));
    const st = verify(cookies(req).ost);
    setCookie(res, 'ost', '', 0);
    if (!st || st.state !== req.query.state) return fail('state');
    const info = await google.exchangeCode(String(req.query.code || ''));
    if (!info.email || !info.emailVerified) return fail('unverified');
    if (!cfg.allowedEmails.includes(info.email)) return fail('not_allowed');
    await google.saveLogin(info);
    // Google שולח טוקן קבוע (לגישה ל-Gmail גם כשאתה לא באתר) רק כשמבקשים אישור מפורש.
    // אם אין לנו טוקן כזה, חוזרים פעם אחת למסך האישור.
    if (!info.refreshToken && !st.consent && (await google.gmailStatus(info.email)) === 'needs_reauth'){
      return res.redirect('/auth/login?consent=1&hint=' + encodeURIComponent(info.email));
    }
    setCookie(res, 'sid', sign({ email: info.email, name: info.name, exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
    res.redirect('/');
  } catch (e){
    console.error('[auth]', e.message);
    fail(e.code || 'oauth_failed');
  }
});

app.post('/auth/logout', (req, res) => { setCookie(res, 'sid', '', 0); res.json({ ok: true }); });

app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- API ---------- */
const api = express.Router();
api.use(express.json({ limit: '45mb' }));
api.use((req, res, next) => {
  const s = sessionOf(req);
  if (!s || !cfg.allowedEmails.includes(s.email)) return res.status(401).json({ error: 'not_logged_in', missing: missingConfig() });
  // הגנה מבקשות שמגיעות מאתרים אחרים: כל בקשה ששמה משהו חייבת לבוא מהדף שלנו
  if (req.method !== 'GET' && req.get('x-app') !== 'reconcile') return res.status(403).json({ error: 'forbidden' });
  req.user = s;
  next();
});
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e){
    const status = e.status || 500;
    if (status >= 500) console.error(`[api ${req.path}]`, e.message);
    res.status(status).json({ error: e.code || 'server_error', message: String(e.message || '').slice(0, 300) });
  }
};

api.get('/me', wrap(async (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, gmail: await google.gmailStatus(req.user.email), ai: !!cfg.anthropicKey, storage: cfg.databaseUrl ? 'postgres' : 'files', missing: missingConfig() });
}));

api.get('/state', wrap(async (req, res) => { res.json(await store.getAll(req.user.email)); }));

api.put('/state/:key', wrap(async (req, res) => {
  const k = req.params.key;
  if (!STATE_KEYS.has(k)) return res.status(400).json({ error: 'bad_key' });
  if (!req.body || !('value' in req.body)) return res.status(400).json({ error: 'no_value' });
  await store.put(req.user.email, k, req.body.value);
  res.json({ ok: true });
}));

const MAX_TOKENS = { extract: 4000, classify: 12000, map: 16000, statement: 32000, match: 8000, ask: 4000 };
api.post('/ai', wrap(async (req, res) => {
  const { prompt, kind = 'ask', tier = 'main', json = true, docs = [], images = [] } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'no_prompt' });
  if (prompt.length > 400000) return res.status(400).json({ error: 'prompt_too_large' });
  const r = await claude({
    prompt, model: modelFor(tier), maxTokens: MAX_TOKENS[kind] || 8000,
    docs: (Array.isArray(docs) ? docs : []).slice(0, 3).filter(d => typeof d?.data === 'string'),
    images: (Array.isArray(images) ? images : []).slice(0, 5).filter(i => typeof i?.data === 'string' && /^image\/(jpeg|png|gif|webp)$/.test(i.mime))
  });
  if (!json) return res.json({ text: r.text, truncated: r.truncated });
  const parsed = parseJson(r.text);
  if (parsed === undefined) return res.status(502).json({ error: r.truncated ? 'truncated' : 'invalid_json', text: r.text.slice(0, 2000) });
  res.json({ json: parsed, truncated: r.truncated });
}));

api.post('/gmail/search', wrap(async (req, res) => {
  const { query, pageToken } = req.body || {};
  res.json(await google.searchThreads(req.user.email, String(query || ''), pageToken || ''));
}));

api.post('/gmail/thread', wrap(async (req, res) => {
  res.json({ messages: await google.getThreadMeta(req.user.email, String(req.body?.threadId || '')) });
}));

api.post('/gmail/extract', wrap(async (req, res) => {
  const { messageId, bizNames, precise } = req.body || {};
  res.json(await extractFromEmail(req.user.email, String(messageId || ''), { bizNames: String(bizNames || ''), precise: !!precise }));
}));

api.post('/extract-file', wrap(async (req, res) => {
  const { name, mime, data, bizNames, precise } = req.body || {};
  if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'no_file' });
  res.json({ result: await extractFromFile({ name: String(name || 'file'), mime: String(mime || ''), data, bizNames: String(bizNames || ''), precise: !!precise }) });
}));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

/* ---------- האתר עצמו ---------- */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '10m' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------- הפעלה ---------- */
await store.initStore();
const miss = missingConfig();
if (miss.length) console.warn('[config] חסרים משתני סביבה:', miss.join(', '));
app.listen(cfg.port, () => console.log(`[server] האתר פועל בכתובת ${cfg.baseUrl} (פורט ${cfg.port})`));
