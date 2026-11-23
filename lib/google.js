// כניסה עם Google וקריאה מ-Gmail (הרשאת קריאה בלבד).
import { cfg } from './config.js';
import * as store from './store.js';
import { encrypt, decrypt } from './crypto.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPES = ['openid', 'email', 'profile', GMAIL_SCOPE].join(' ');
export const redirectUri = () => `${cfg.baseUrl}/auth/callback`;

export class HttpError extends Error {
  constructor(status, code, message){ super(message || code); this.status = status; this.code = code; }
}

export function authUrl(state, { consent = false, loginHint = '' } = {}){
  const p = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
    prompt: consent ? 'consent select_account' : 'select_account'
  });
  if (loginHint) p.set('login_hint', loginHint);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

export async function exchangeCode(code){
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(400, 'oauth_failed', j.error_description || j.error || 'token exchange failed');
  // ה-id_token הגיע ישירות מ-Google בחיבור מוצפן, ולכן אפשר לקרוא אותו בלי לאמת חתימה
  const claims = JSON.parse(Buffer.from(String(j.id_token).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  if (claims.aud !== cfg.googleClientId) throw new HttpError(400, 'oauth_failed', 'audience mismatch');
  return { email: String(claims.email || '').toLowerCase(), emailVerified: !!claims.email_verified, name: claims.name || '', refreshToken: j.refresh_token || null, accessToken: j.access_token, expiresIn: j.expires_in || 3600, scope: j.scope || '' };
}

const cache = new Map(); // email -> { token, exp }

export function rememberAccess(email, token, expiresIn){ cache.set(email, { token, exp: Date.now() + (expiresIn - 60) * 1000 }); }

async function accessToken(email){
  const c = cache.get(email);
  if (c && c.exp > Date.now()) return c.token;
  const row = await store.getToken(email);
  const refresh = row && decrypt(row.refresh_enc);
  if (!refresh) throw new HttpError(409, 'needs_reauth', 'no refresh token');
  if (row.scope && !row.scope.includes(GMAIL_SCOPE)) throw new HttpError(409, 'no_gmail_scope', 'gmail scope not granted');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok){
    if (j.error === 'invalid_grant'){ await store.deleteToken(email); throw new HttpError(409, 'needs_reauth', 'refresh token expired or revoked'); }
    throw new HttpError(502, 'google_error', j.error_description || j.error || 'token refresh failed');
  }
  rememberAccess(email, j.access_token, j.expires_in || 3600);
  return j.access_token;
}

export async function saveLogin(info){
  if (info.refreshToken) await store.putToken(info.email, encrypt(info.refreshToken), info.scope);
  if (info.accessToken) rememberAccess(info.email, info.accessToken, info.expiresIn);
}

export async function gmailStatus(email){
  const row = await store.getToken(email);
  if (!row || !decrypt(row.refresh_enc)) return 'needs_reauth';
  if (row.scope && !row.scope.includes(GMAIL_SCOPE)) return 'no_gmail_scope';
  return 'ok';
}

async function gapi(email, pathPart, params = {}){
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/${pathPart}?` + new URLSearchParams(Object.entries(params).flatMap(([k, v]) => Array.isArray(v) ? v.map(x => [k, x]) : (v == null || v === '' ? [] : [[k, String(v)]])));
  for (let attempt = 0; attempt < 3; attempt++){
    const token = await accessToken(email);
    const r = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
    if (r.ok) return r.json();
    if (r.status === 401 && attempt === 0){ cache.delete(email); continue; }
    if ((r.status === 429 || r.status >= 500) && attempt < 2){ await new Promise(res => setTimeout(res, 800 * (attempt + 1) + Math.random() * 600)); continue; }
    const t = await r.text().catch(() => '');
    if (r.status === 403 && /insufficient|scope/i.test(t)) throw new HttpError(409, 'no_gmail_scope', t.slice(0, 200));
    throw new HttpError(502, 'gmail_error', `Gmail ${r.status}: ${t.slice(0, 200)}`);
  }
  throw new HttpError(502, 'gmail_error', 'Gmail did not respond');
}

const header = (msg, name) => (msg.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function parseFrom(v){
  const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim() || m[2], email: m[2].trim() } : { name: String(v).trim(), email: String(v).trim() };
}
const decodeB64 = d => Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function htmlToText(html){
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
export function parseMessage(msg, accountEmail){
  const out = { plain: '', html: '', attachments: [] };
  const walk = part => {
    if (!part) return;
    const disp = (part.headers || []).find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
    if (part.filename && (part.body?.attachmentId || part.body?.data)){
      out.attachments.push({ id: part.body.attachmentId || null, data: part.body.data || null, filename: part.filename, mimeType: part.mimeType || '', size: part.body.size || 0, inline: /inline/i.test(disp) });
    } else if (part.mimeType === 'text/plain' && part.body?.data && !out.plain) out.plain = decodeB64(part.body.data);
    else if (part.mimeType === 'text/html' && part.body?.data && !out.html) out.html = decodeB64(part.body.data);
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  const from = parseFrom(header(msg, 'From'));
  return {
    id: msg.id,
    threadId: msg.threadId,
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : '',
    from: from.name, fromEmail: from.email,
    subject: header(msg, 'Subject'),
    snippet: msg.snippet || '',
    body: (out.plain || htmlToText(out.html)).slice(0, 20000),
    attachments: out.attachments,
    viewUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(accountEmail)}#all/${msg.threadId}`
  };
}

export async function searchThreads(email, query, pageToken){
  const j = await gapi(email, 'threads', { q: query, maxResults: 50, pageToken });
  return { threads: (j.threads || []).map(t => ({ id: t.id, historyId: t.historyId })), nextPageToken: j.nextPageToken || null };
}

export async function getThreadMeta(email, threadId){
  const j = await gapi(email, `threads/${encodeURIComponent(threadId)}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
  return (j.messages || []).map(m => { const p = parseMessage(m, email); delete p.body; delete p.attachments; return p; });
}

export async function getMessage(email, messageId){
  const m = await gapi(email, `messages/${encodeURIComponent(messageId)}`, { format: 'full' });
  return parseMessage(m, email);
}

export async function getAttachment(email, messageId, attachmentId){
  const j = await gapi(email, `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  return Buffer.from(String(j.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
