// שמירת החשבוניות והקבלות המקוריות ב-Google Drive של המשתמש:
// תיקייה "Ka-Ching", ובתוכה תיקייה לכל חודש (למשל "2026-10"). שם הקובץ: תאריך, ספק וסכום.
// ההרשאה היא drive.file, כך שהאתר רואה רק את הקבצים והתיקיות שהוא עצמו יצר.
import crypto from 'node:crypto';
import * as store from './store.js';
import * as google from './google.js';
import { HttpError } from './google.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Ka-Ching';
const KEY = 'drive'; // ב-app_kv: { rootId, months: { 'YYYY-MM': id }, files: { sha256: { id, url } } }

export const folderUrl = id => `https://drive.google.com/drive/folders/${id}`;
const fileUrl = id => `https://drive.google.com/file/d/${id}/view`;

// כל הפעולות של אותו משתמש רצות אחת אחרי השנייה, כדי שלא ייווצרו תיקיות כפולות
const chains = new Map();
function serial(email, fn){
  const prev = chains.get(email) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(email, next);
  return next;
}

const verified = new Set(); // תיקיות שכבר בדקנו שקיימות, בתהליך הנוכחי
async function folderOk(email, id){
  if (!id) return false;
  if (verified.has(id)) return true;
  try {
    const f = await google.gfetch(email, `${API}/${encodeURIComponent(id)}?fields=id,trashed`, {}, { scopeCode: 'no_drive_scope' });
    if (f.trashed) return false;
    verified.add(id); return true;
  } catch (e){ if (e.code === 'not_found') return false; throw e; }
}
async function createFolder(email, name, parent){
  const f = await google.gfetch(email, `${API}?fields=id`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }) }, { scopeCode: 'no_drive_scope' });
  verified.add(f.id);
  return f.id;
}
async function loadState(email){
  const st = await store.getKey(email, KEY);
  return st && typeof st === 'object' ? { rootId: st.rootId || null, months: st.months || {}, files: st.files || {} } : { rootId: null, months: {}, files: {} };
}
async function rootFolder(email, st){
  if (!(await folderOk(email, st.rootId))){ st.rootId = await createFolder(email, ROOT_NAME); st.months = {}; }
  return st.rootId;
}
async function monthFolder(email, st, ym){
  const root = await rootFolder(email, st);
  if (!(await folderOk(email, st.months[ym]))) st.months[ym] = await createFolder(email, ym, root);
  return st.months[ym];
}

const clean = s => String(s ?? '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic' };
export function fileName(doc, original){
  const ext = (String(original || '').match(/\.[a-z0-9]{2,5}$/i)?.[0] || EXT[doc.mime] || '').toLowerCase();
  const amount = Number.isFinite(Number(doc.amount)) && doc.amount !== null && doc.amount !== '' ? Number(doc.amount).toFixed(2) : '';
  const parts = [doc.date || 'ללא תאריך', doc.dir === 'income' ? 'הכנסה' : '', clean(doc.vendor).slice(0, 60) || 'ספק לא ידוע', amount].filter(Boolean);
  return parts.join(' ') + ext;
}
const monthOf = date => /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date).slice(0, 7) : new Date().toISOString().slice(0, 7);

// שמירת קובץ אחד. doc: { date, vendor, amount, dir }. אותו קובץ בדיוק לא נשמר פעמיים.
export function saveFile(email, { buf, mime, original, doc }){
  return serial(email, async () => {
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const st = await loadState(email);
    const known = st.files[hash];
    if (known){
      try {
        const f = await google.gfetch(email, `${API}/${encodeURIComponent(known.id)}?fields=id,trashed`, {}, { scopeCode: 'no_drive_scope' });
        if (!f.trashed) return { ...known, existed: true };
      } catch (e){ if (e.code !== 'not_found') throw e; }
    }
    const parent = await monthFolder(email, st, monthOf(doc?.date));
    const name = fileName({ ...doc, mime }, original);
    const init = await google.gfetch(email, `${UPLOAD}?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime || 'application/octet-stream', 'x-upload-content-length': String(buf.length) },
      body: JSON.stringify({ name, parents: [parent], mimeType: mime || undefined })
    }, { scopeCode: 'no_drive_scope', raw: true });
    const location = init.headers.get('location');
    if (!location) throw new HttpError(502, 'google_error', 'Drive did not return an upload URL');
    const put = await fetch(location, { method: 'PUT', headers: { 'content-type': mime || 'application/octet-stream' }, body: buf });
    if (!put.ok) throw new HttpError(502, 'google_error', `Drive upload ${put.status}: ${(await put.text().catch(() => '')).slice(0, 200)}`);
    const f = await put.json();
    st.files[hash] = { id: f.id, url: fileUrl(f.id) };
    await store.put(email, KEY, st);
    return { ...st.files[hash], name };
  });
}

// העברה לפח (נשאר בפח של Drive 30 יום). רק קבצים שהאתר עצמו שמר.
export function trashFile(email, fileId){
  return serial(email, async () => {
    const st = await loadState(email);
    const hash = Object.keys(st.files).find(h => st.files[h].id === fileId);
    if (!hash) throw new HttpError(404, 'not_found', 'unknown file');
    try { await google.gfetch(email, `${API}/${encodeURIComponent(fileId)}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) }, { scopeCode: 'no_drive_scope' }); }
    catch (e){ if (e.code !== 'not_found') throw e; }
    delete st.files[hash];
    await store.put(email, KEY, st);
    return { ok: true };
  });
}

export async function info(email){
  const canWrite = await google.canDrive(email);
  const st = await loadState(email);
  return { canWrite, folderUrl: st.rootId ? folderUrl(st.rootId) : null, files: Object.keys(st.files).length };
}
