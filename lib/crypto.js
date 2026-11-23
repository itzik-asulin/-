// חתימת עוגיות סשן והצפנת טוקן ה-Gmail לפני שמירה במסד הנתונים.
import crypto from 'node:crypto';
import { cfg } from './config.js';

const b64url = buf => Buffer.from(buf).toString('base64url');
const hmac = data => crypto.createHmac('sha256', cfg.sessionSecret + ':sig').update(data).digest('base64url');

export function sign(obj){
  const body = b64url(JSON.stringify(obj));
  return body + '.' + hmac(body);
}

export function verify(token){
  if (!token || typeof token !== 'string' || !cfg.sessionSecret) return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const expect = hmac(body);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
}

const encKey = () => crypto.createHash('sha256').update(cfg.sessionSecret + ':enc').digest();

export function encrypt(text){
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b64url).join('.');
}

export function decrypt(blob){
  try {
    const [iv, tag, ct] = String(blob).split('.').map(s => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

export const randomId = (n = 24) => crypto.randomBytes(n).toString('base64url');
