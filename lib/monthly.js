// שליחת דוח החוסרים החודשי: ב-10 לכל חודש (שעון ישראל), על החודש הקודם, רק למי שהפעיל את זה בהגדרות.
// נקרא מכתובת התזמון (/cron/monthly-report) וגם כשנכנסים לאתר, כך שהדוח יישלח גם אם התזמון החיצוני פספס.
// כל חודש נשלח פעם אחת בלבד: הרישום נשמר ב-app_kv תחת המפתח reportLog.
import crypto from 'node:crypto';
import { cfg } from './config.js';
import * as store from './store.js';
import * as google from './google.js';
import { computeReport, buildEmail, buildMime, israelToday, prevMonth, monthOf, isMonth } from './report.js';

export const SEND_DAY = 10;
const RETRY_AFTER_MS = 60 * 60 * 1000; // אחרי כישלון, לא מנסים שוב לפני שעה

// מפתח לכתובת התזמון, נגזר מ-SESSION_SECRET (אין צורך במשתנה סביבה נוסף)
export const cronKey = () => crypto.createHmac('sha256', cfg.sessionSecret + ':cron').update('ka-ching-monthly-v1').digest('base64url').slice(0, 32);
export function cronKeyOk(k){
  if (!cfg.sessionSecret || typeof k !== 'string') return false;
  const a = Buffer.from(k), b = Buffer.from(cronKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const cronUrl = () => `${cfg.baseUrl}/cron/monthly-report?key=${cronKey()}`;

export async function sendReport(email, ym, state){
  state = state || await store.getAll(email);
  const r = computeReport(state, ym);
  const mail = buildEmail(r, { to: email, baseUrl: cfg.baseUrl });
  await google.sendRawEmail(email, buildMime({ from: email, to: email, ...mail }));
  return { month: ym, tx: r.tx.length, missing: r.missOut.length + r.missIn.length, noInv: r.noInv.length, check: r.check.length };
}

const locks = new Set();

// מחזיר מה קרה: sent / already_sent / not_due / disabled / no_send_scope / failed / busy
export async function maybeSendMonthly(email, now = new Date()){
  if (locks.has(email)) return { status: 'busy' };
  locks.add(email);
  try {
    const state = await store.getAll(email);
    const s = state.settings || {};
    if (s.monthlyReport !== true) return { status: 'disabled' };
    const today = israelToday(now);
    if (Number(today.slice(8, 10)) < SEND_DAY) return { status: 'not_due' };
    const ym = prevMonth(today);
    // מי שהפעיל את הדוח באמצע חודש מקבל את הדוח הראשון על החודש שבו הפעיל
    if (isMonth(s.monthlyReportSince) && ym < s.monthlyReportSince) return { status: 'not_due' };
    const log = state.reportLog && typeof state.reportLog === 'object' ? state.reportLog : {};
    const prev = log[ym];
    if (prev?.ok) return { status: 'already_sent', month: ym };
    if (prev && !prev.ok && Date.now() - (prev.at || 0) < RETRY_AFTER_MS) return { status: 'failed', month: ym, error: prev.error };
    if (!(await google.canSend(email))) return { status: 'no_send_scope' };
    try {
      const res = await sendReport(email, ym, state);
      log[ym] = { ok: true, at: Date.now(), ...res };
      await store.put(email, 'reportLog', log);
      console.log(`[report] נשלח דוח ${ym} ל-${email}`);
      return { status: 'sent', ...res };
    } catch (e){
      log[ym] = { ok: false, at: Date.now(), error: e.code || 'failed' };
      await store.put(email, 'reportLog', log).catch(() => {});
      console.error(`[report] שליחת דוח ${ym} ל-${email} נכשלה:`, e.message);
      return { status: 'failed', month: ym, error: e.code || 'failed' };
    }
  } finally {
    locks.delete(email);
  }
}

export async function runMonthlyForAll(now = new Date()){
  const out = {};
  for (const email of cfg.allowedEmails) out[email] = (await maybeSendMonthly(email, now).catch(e => ({ status: 'failed', error: e.code || e.message }))).status;
  return out;
}

export async function reportInfo(email, state){
  state = state || await store.getAll(email);
  const log = state.reportLog && typeof state.reportLog === 'object' ? state.reportLog : {};
  const months = Object.keys(log).filter(isMonth).sort();
  const lastOk = [...months].reverse().find(m => log[m]?.ok);
  const last = months.length ? months[months.length - 1] : null;
  const today = israelToday();
  return {
    canSend: await google.canSend(email),
    enabled: state.settings?.monthlyReport === true,
    today, thisMonth: monthOf(today), sendDay: SEND_DAY,
    lastSent: lastOk ? { month: lastOk, at: log[lastOk].at } : null,
    lastError: last && !log[last].ok ? { month: last, error: log[last].error, at: log[last].at } : null,
    cronUrl: cronUrl()
  };
}
