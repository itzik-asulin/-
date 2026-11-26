'use strict';
/* Ka-Ching · התאמת בנק וחשבוניות — הממשק בדפדפן.
   הדף מדבר רק עם השרת שלך (/api). השרת הוא שפונה ל-Gmail ול-Claude. */

/* ============================== כלים ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
function hash(str){ let h = 0x811c9dc5; for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
function todayISO(){ const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function addDays(iso, n){ const [y,m,d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m-1, d + n)); return t.toISOString().slice(0,10); }
function dayDiff(a, b){ return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function mkDate(y, m, d){ if (!(y > 1990 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null; const t = new Date(Date.UTC(y, m-1, d)); if (t.getUTCMonth() !== m-1) return null; return `${y}-${pad(m)}-${pad(d)}`; }
function parseDate(v){
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)){ const t = new Date(v.getTime() + 12*3600*1000); return mkDate(t.getFullYear(), t.getMonth()+1, t.getDate()); }
  if (typeof v === 'number'){ if (v > 20000 && v < 80000){ const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return t.toISOString().slice(0,10); } return null; }
  const s = String(v).replace(BIDI, '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return mkDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?!\d)/))){ let y = +m[3]; if (y < 100) y += 2000; return mkDate(y, +m[2], +m[1]); }
  if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/))) return mkDate(+m[1], +m[2], +m[3]);
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s));
  return null;
}
function parseAmount(v){
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(BIDI, '').replace(/ש"ח|ש״ח|NIS|ILS|USD|EUR|GBP/gi, '').replace(/[\s₪$€£ ]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)){ neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')){ neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')){ neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return neg ? -n : n;
}
const num = v => { const n = typeof v === 'number' ? v : parseAmount(v); return n == null || !isFinite(n) ? null : n; };
const str = v => (v == null ? '' : String(v)).replace(BIDI, '').trim();
const arr = v => Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, 6) : [];
const fmtDate = iso => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(2,4)}` : '—';
const fmtDateLong = iso => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : '';
function fmtMoney(n, cur = 'ILS'){
  if (n == null) return '—';
  try { return new Intl.NumberFormat('he-IL', { style:'currency', currency: cur || 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n); }
  catch { return n.toFixed(2) + ' ' + (cur || ''); }
}
function toast(msg, ms = 3800){ const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; $('#toasts').append(el); setTimeout(() => el.remove(), ms); }
function fileToB64(file){
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
}

/* ============================== מצב ============================== */
const DOC_TYPES = {
  tax_invoice_receipt: 'חשבונית מס/קבלה',
  tax_invoice: 'חשבונית מס',
  receipt: 'קבלה',
  deal_invoice: 'חשבון עסקה',
  payment_confirmation: 'אישור תשלום',
  credit_note: 'חשבונית זיכוי',
  other: 'מסמך אחר'
};
const isApproved = d => !d.review || d.review === 'approved'; // מסמך חדש ממתין לאישור, ורק מסמך מאושר נכנס להתאמה ולדוח
const ST = {
  missing:    { label: 'חסר מסמך', cls: 'bad', order: 0 },
  no_invoice: { label: 'חסרה חשבונית מס', cls: 'warn', order: 1 },
  check:      { label: 'לבדיקה', cls: 'check', order: 2 },
  no_receipt: { label: 'חסרה קבלה', cls: 'warnl', order: 3 },
  pending:    { label: 'טרם סווג', cls: 'pending', order: 4 },
  complete:   { label: 'מלא', cls: 'ok', order: 5 },
  recurring:  { label: 'הוראת קבע', cls: 'rec', order: 6 },
  donation:   { label: 'תרומה', cls: 'don', order: 7 },
  not_needed: { label: 'לא נדרש', cls: 'muted', order: 8 }
};
const DEFAULT_QUERY = '(חשבונית OR קבלה OR "חשבון עסקה" OR "אישור תשלום" OR "אישור עסקה" OR "דרישת תשלום" OR invoice OR receipt OR "payment confirmation") -category:social';
const KEYS = ['settings','sources','tx','emails','docs','links','rejects','overrides','threads'];
const S = {
  settings: { bizNames: '', aiMode: 'fast', gmailQuery: DEFAULT_QUERY, maxThreads: 300, from: '', to: '' },
  sources: [], tx: [], emails: [], docs: [], links: [], rejects: [], overrides: {}, threads: {},
  demo: false
};
const UI = { txf: 'all', mf: 'all', df: 'all', txLimit: 150, mailLimit: 150, docLimit: 150, flowLimit: 200, tab: 'board', notes: { bank: null, mail: null, doc: null }, rvDraft: {} };
const jobs = {};
const CAP = { ready: false, me: null, ai: false, gmail: 'unknown', saveOk: null, report: null, drive: null };
// שמירת העותק המקורי ב-Google Drive: רק כשהופעל בהגדרות וניתנה הרשאה
const driveOn = () => !!(S.settings.driveSave && CAP.drive?.canWrite && !S.demo);
const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const monthName = ym => `${HE_MONTHS[+ym.slice(5,7) - 1]} ${ym.slice(0,4)}`;
const prevYm = ym => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y-1}-12` : `${y}-${pad(m-1)}`; };
const nextYm = ym => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y+1}-01` : `${y}-${pad(m+1)}`; };
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };

function period(){
  const to = S.settings.to || todayISO();
  let from = S.settings.from;
  if (!from){ const d = new Date(); d.setMonth(d.getMonth() - 2, 1); from = `${d.getFullYear()}-${pad(d.getMonth()+1)}-01`; }
  return from <= to ? { from, to } : { from: to, to: from };
}
const inPeriod = (iso, p = period()) => iso && iso >= p.from && iso <= p.to;

/* ============================== שרת ============================== */
async function api(path, { method = 'GET', body, signal } = {}){
  let r;
  try {
    r = await fetch('/api' + path, { method, signal, credentials: 'same-origin', headers: { 'x-app': 'reconcile', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e){
    if (e?.name === 'AbortError') throw { code: 'cancelled', src: 'server' };
    throw { code: 'offline', src: 'server' };
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401){ showLogin(j.missing || []); throw { code: 'not_logged_in', src: 'server', status: 401 }; }
  if (!r.ok) throw { code: j.error || 'server_error', message: j.message, text: j.text, status: r.status, src: 'server' };
  return j;
}
const FATAL = new Set(['not_logged_in','offline','no_ai','ai_key','ai_credit','rate_limited','needs_reauth','no_gmail_scope','cancelled']);
const isFatal = e => FATAL.has(e?.code);
function errText(e){
  switch (e?.code){
    case 'not_logged_in': return 'צריך להתחבר מחדש.';
    case 'offline': return 'אין חיבור לשרת. בדוק את החיבור לאינטרנט, או שהשרת מתעורר (עד דקה) ונסה שוב.';
    case 'no_ai': return 'קריאת החשבוניות עם AI לא זמינה כרגע. (למנהל: חסר בשרת ANTHROPIC_API_KEY)';
    case 'ai_key': return 'קריאת החשבוניות עם AI לא זמינה כרגע. (למנהל: המפתח ב-console.anthropic.com לא תקין)';
    case 'ai_credit': return 'קריאת החשבוניות עם AI נעצרה כי נגמרה היתרה. (למנהל: להוסיף קרדיט ב-console.anthropic.com)';
    case 'rate_limited': return 'יותר מדי בקשות ל-Claude בבת אחת. המתן דקה ונסה שוב. המשך יתחיל מאותה נקודה.';
    case 'needs_reauth': return 'צריך לחבר מחדש את Gmail. לחץ "הגדרות" ואז "התחבר מחדש ל-Google".';
    case 'no_gmail_scope': return 'לא ניתנה לאתר הרשאה לקרוא מ-Gmail. לחץ "הגדרות", "התחבר מחדש ל-Google", וסמן את התיבה של Gmail.';
    case 'gmail_error': return 'Gmail החזיר שגיאה. נסה שוב בעוד רגע.';
    case 'google_error': return 'תקלה בחיבור ל-Google. נסה שוב בעוד רגע.';
    case 'invalid_json': return 'Claude החזיר תשובה לא תקינה.';
    case 'truncated': return 'הקובץ ארוך מדי לקריאה אחת. פצל אותו לכמה קבצים קטנים יותר.';
    case 'prompt_too_large': return 'הבקשה גדולה מדי.';
    case 'ai_bad_request': return 'Claude לא הצליח לקרוא את הקובץ הזה.';
    case 'cancelled': return 'הפעולה הופסקה.';
    case 'no_xlsx': return 'רכיב קריאת האקסל לא נטען. רענן את הדף.';
    case 'no_send_scope': return 'עוד לא אישרת ל-Google שהאתר ישלח לך מייל. סמן בהגדרות את "דוח חוסרים במייל" ולחץ "שמור".';
    case 'bad_month': return 'החודש שנבחר לא תקין.';
    case 'no_drive_scope': return 'עוד לא אישרת ל-Google שהאתר ישמור קבצים ב-Drive. סמן בהגדרות את "שמירה ב-Google Drive" ולחץ "שמור".';
    case 'no_attachment': return 'הקובץ כבר לא נמצא במייל.';
    case 'drive_api_disabled': return 'השמירה ב-Drive עוד לא הופעלה ב-Google Cloud. (למנהל: בפרויקט ב-console.cloud.google.com צריך להפעיל את Google Drive API)';
    case 'read_failed': return 'הדפדפן לא הצליח לקרוא את הקובץ מהמחשב. אם גררת אותו מתוך קובץ ZIP פתוח, גרור את קובץ ה-ZIP עצמו, או חלץ אותו קודם (קליק ימני ← "חלץ הכל").';
    case 'ai_error': return `ה-AI החזיר שגיאה. נסה שוב בעוד רגע.${e.message ? ` (פרטים: ${String(e.message).slice(0, 140)})` : ''}`;
    default: return `תקלה זמנית. נסה שוב.${e?.code || e?.status ? ` (קוד: ${[e.code, e.status].filter(Boolean).join(' ')}${e.message ? ', ' + String(e.message).slice(0, 120) : ''})` : ''}`;
  }
}

/* ============================== שמירה ============================== */
const dirty = new Set();
let saveTimer = null, saveChain = Promise.resolve();
const strip = (k, v) => (k && k[0] === '_') ? undefined : v;
function markDirty(...keys){
  keys = S.demo ? keys.filter(k => k === 'settings') : keys;
  if (!keys.length) return;
  keys.forEach(k => dirty.add(k)); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 1000);
}
function flush(){
  if (!CAP.me) return;
  const keys = [...dirty]; dirty.clear();
  for (const k of keys) saveChain = saveChain.then(() => saveKey(k)).catch(e => { CAP.saveOk = false; dirty.add(k); renderCaps(); if (e?.code !== 'not_logged_in') toast('השמירה נכשלה. אנסה שוב בשינוי הבא.'); });
}
async function saveKey(k){
  let val = S[k];
  if (S.demo && k !== 'settings') return;
  if (k === 'settings' && S.demo) val = { ...val, from: '', to: '' };
  await api('/state/' + k, { method: 'PUT', body: { value: JSON.parse(JSON.stringify(val, strip)) } });
  CAP.saveOk = true; renderCaps();
}
window.addEventListener('beforeunload', e => { if (dirty.size){ flush(); e.preventDefault(); e.returnValue = ''; } });
function applyLoaded(L){
  if (L.settings) S.settings = { ...S.settings, ...L.settings };
  const hasData = ['tx','docs','emails'].some(k => Array.isArray(L[k]) && L[k].length);
  if (!hasData) return false;
  S.sources = L.sources || []; S.tx = L.tx || []; S.emails = L.emails || []; S.docs = L.docs || [];
  S.links = L.links || []; S.rejects = L.rejects || []; S.overrides = L.overrides || {}; S.threads = L.threads || {};
  S.demo = false;
  return true;
}

/* ============================== כניסה ============================== */
function showLogin(missing = []){
  CAP.me = null;
  const qs = new URLSearchParams(location.search);
  const err = qs.get('login_error');
  const errMsg = { not_allowed: 'החשבון הזה לא ברשימת המורשים. הוסף אותו למשתנה ALLOWED_EMAILS בשרת.', unverified: 'כתובת המייל בחשבון Google לא מאומתת.', access_denied: 'הכניסה בוטלה.', state: 'הכניסה פגה. נסה שוב.' }[err] || (err ? 'הכניסה נכשלה. נסה שוב.' : '');
  const setup = missing.filter(k => k !== 'ANTHROPIC_API_KEY' && k !== 'DATABASE_URL');
  $('#loginRoot').innerHTML = `<div class="login" role="dialog" aria-modal="true" aria-label="כניסה"><div class="login-card">
    <span class="logo" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h9M4 17h6"/><path d="m14 17 2.5 2.5L21 15"/></svg></span>
    <h1>Ka-Ching</h1>
    <p style="font-weight:500;color:var(--ink-2)">התאמת בנק וחשבוניות</p>
    <p>כניסה עם חשבון Google שלך. אותה כניסה נותנת לאתר הרשאת קריאה בלבד ל-Gmail, כדי למצוא חשבוניות וקבלות.</p>
    ${errMsg ? `<div class="note err" style="margin:0">${esc(errMsg)}</div>` : ''}
    ${setup.length ? `<div class="note err" style="margin:0">ההקמה לא הושלמה. חסרים בשרת משתני הסביבה:<ul>${setup.map(k => `<li><code>${esc(k)}</code></li>`).join('')}</ul></div>` : `<a class="btn primary" href="/auth/login">התחבר עם Google</a>`}
    <p style="font-size:12.5px">רק חשבונות שהוגדרו מראש בשרת יכולים להיכנס. הנתונים נשמרים בשרת שלך ולא משותפים עם אף אחד.</p>
  </div></div>`;
}
function hideLogin(){ $('#loginRoot').innerHTML = ''; if (location.search) history.replaceState(null, '', location.pathname + location.hash); }

async function init(){
  let me;
  const qs = new URLSearchParams(location.search);
  try { me = await api('/me'); }
  catch (e){ CAP.ready = true; renderCaps(); if (e.code !== 'not_logged_in') toast(errText(e), 6000); return; }
  CAP.me = me; CAP.ai = !!me.ai; CAP.gmail = me.gmail; CAP.report = me.report || null; CAP.drive = me.drive || null; CAP.ready = true;
  hideLogin();
  try {
    const L = await api('/state');
    if (S.demo){ const demoRange = { from: S.settings.from, to: S.settings.to }; if (!applyLoaded(L) && L.settings){ S.settings.from = demoRange.from; S.settings.to = demoRange.to; } }
    CAP.saveOk = true;
  } catch (e){ CAP.saveOk = false; toast('לא הצלחתי לטעון את הנתונים השמורים. רענן את הדף.', 6000); }
  if (me.missing?.includes('ANTHROPIC_API_KEY')) setNote('bank', 'err', errText({ code: 'no_ai' }));
  if (UI.hashMonth) setMonthPeriod(UI.hashMonth);
  // חזרה ממסך האישור של Google (הרשאות לדוח במייל ול-Drive)
  const back = qs.get('scopes') === '1';
  if (back){
    const msgs = [];
    if (S.settings.monthlyReport) msgs.push(CAP.report?.canSend ? 'דוח החוסרים יישלח אליך במייל ב-10 לכל חודש' : 'לא ניתנה הרשאה לשליחת הדוח במייל');
    if (S.settings.driveSave) msgs.push(CAP.drive?.canWrite ? 'חשבוניות חדשות יישמרו מעכשיו ב-Google Drive' : 'לא ניתנה הרשאה לשמירה ב-Drive');
    toast((msgs.length ? msgs.join('. ') : 'ההרשאות עודכנו') + '.', 7000);
  } else if (qs.get('login_error')){
    toast('האישור ב-Google לא הושלם. אפשר לנסות שוב מההגדרות.', 6000);
  }
  if (dirty.size) flush();
  syncInputs(); rederive(); renderAll();
  if (back) openSettings();
}
// מאיזה חודש מתחילים לשלוח: עד ה-10 בחודש כולל, כבר הדוח על החודש הקודם. אחרי ה-10, הדוח על החודש הנוכחי (יישלח בחודש הבא)
function reportSince(){
  const r = CAP.report; const today = r?.today || todayISO();
  return +today.slice(8, 10) <= (r?.sendDay || 10) ? prevYm(today.slice(0, 7)) : today.slice(0, 7);
}
function setMonthPeriod(ym){
  S.settings.from = ym + '-01'; S.settings.to = monthEnd(ym);
  markDirty('settings'); syncInputs(); rederive(); renderAll();
}
async function logout(){ await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); location.href = '/'; }

/* ============================== נתוני דוגמה ============================== */
function loadDemo(){
  const tx = (id, src, date, desc, amount, dir, merchant, needsDoc, reason, extra = {}) => ({ id, sourceId: src, date, chargeDate: null, desc, amount, dir, currency: 'ILS', merchant, aliases: [], category: '', needsDoc, needReason: reason, ...extra });
  S.sources = [
    { id: 'S1', label: 'בנק לאומי — עו"ש 800-12345/67', kind: 'bank', fileName: 'לאומי_תנועות.xlsx', count: 9, importedAt: Date.now() },
    { id: 'S2', label: 'ויזה כאל •••• 4417', kind: 'credit', fileName: 'cal_10-11.xlsx', count: 12, importedAt: Date.now() }
  ];
  S.tx = [
    tx('t1','S1','2026-10-02','הוראת קבע חברת החשמל',412.30,'out','חברת החשמל','yes','תשלום לספק'),
    tx('t2','S1','2026-10-05','העברה 12-655-99887 משה כהן',3500,'out','משה כהן','maybe','העברה לאדם פרטי, לא ברור עבור מה'),
    tx('t3','S1','2026-10-10','כאל-חיוב כרטיס',6120.40,'out','כאל','no','חיוב מרוכז של כרטיס האשראי. הפירוט בדף הכרטיס'),
    tx('t4','S1','2026-10-12','משיכה מבנקט',1000,'out','משיכת מזומן','no','משיכת מזומן'),
    tx('t5','S1','2026-10-15','ביטוח לאומי-תשלום',1240,'out','ביטוח לאומי','no','תשלום לרשות. אישור התשלום הוא המסמך'),
    tx('t6','S1','2026-10-20','זיכוי מ- יעל לוי',4680,'in','יעל לוי','yes','הכנסה מלקוח, צריך קבלה שהוצאת'),
    tx('t7','S1','2026-11-03','העברה-רו"ח אבי מזרחי',1755,'out','רו"ח אבי מזרחי','yes','שכר טרחה לספק'),
    tx('t8','S1','2026-11-08','עמלת ניהול חשבון',29.90,'out','עמלת בנק','no','עמלת בנק. דף הבנק הוא המסמך'),
    tx('t9','S1','2026-10-01','הו"ק יד שרה',180,'out','יד שרה','no','תרומה לעמותה'),
    tx('c1','S2','2026-10-03','פז יילו בית שמש',320.50,'out','פז','yes','דלק'),
    tx('c2','S2','2026-10-07','GOOGLE*WORKSPACE',92.40,'out','Google Workspace','yes','מנוי תוכנה',{ origAmount: 24, origCurrency: 'USD' }),
    tx('c3','S2','2026-10-09','בזק בינלאומי',119.90,'out','בזק בינלאומי','yes','תקשורת'),
    tx('c4','S2','2026-10-14','שופרסל דיל ירושלים',287.15,'out','שופרסל','yes','קנייה בחנות'),
    tx('c5','S2','2026-10-18','PAYPAL *ADOBE',199.00,'out','Adobe','yes','מנוי תוכנה'),
    tx('c6','S2','2026-10-22','סלקום תקשורת',89.90,'out','סלקום','yes','תקשורת'),
    tx('c7','S2','2026-10-27','אופיס דיפו בני ברק',642.00,'out','אופיס דיפו','yes','ציוד משרדי'),
    tx('c8','S2','2026-11-02','פז יילו בית שמש',298.70,'out','פז','yes','דלק'),
    tx('c9','S2','2026-11-05','ZOOM.US 888-799-9666',58.30,'out','Zoom','yes','מנוי תוכנה',{ origAmount: 15.99, origCurrency: 'USD' }),
    tx('c10','S2','2026-11-11','יוחננוף מודיעין',410.25,'out','יוחננוף','maybe','קנייה בסופר. ייתכן שפרטית'),
    tx('c11','S2','2026-11-14','סופר-פארם הדר',64.90,'out','סופר-פארם','maybe','ייתכן שפרטית'),
    tx('c12','S2','2026-10-16','נדרים פלוס*קופת העיר',360,'out','קופת העיר','no','תרומה')
  ];
  const CAT = { 'חברת החשמל': 'חשמל ומים', 'משה כהן': 'העברות', 'משיכת מזומן': 'מזומן', 'ביטוח לאומי': 'מיסים ואגרות', 'רו"ח אבי מזרחי': 'שירותים מקצועיים', 'עמלת בנק': 'עמלות בנק', 'פז': 'דלק', 'Google Workspace': 'תוכנה ומנויים', 'בזק בינלאומי': 'תקשורת', 'שופרסל': 'כיבוד', 'Adobe': 'תוכנה ומנויים', 'סלקום': 'תקשורת', 'אופיס דיפו': 'ציוד משרדי', 'Zoom': 'תוכנה ומנויים', 'יוחננוף': 'כיבוד', 'סופר-פארם': 'אחר', 'כאל': 'כרטיס אשראי', 'יעל לוי': 'הכנסה מלקוח', 'יד שרה': 'תרומות', 'קופת העיר': 'תרומות' };
  for (const t of S.tx) t.category = CAT[t.merchant] || '';
  const doc = (id, date, vendor, docType, amount, extra = {}) => ({ id, origin: 'gmail', emailId: 'e' + id, viewUrl: null, fileName: 'invoice.pdf', docType, vendor, customer: '', aliases: [], taxId: '', date, amount, currency: 'ILS', vat: +(amount - amount/1.18).toFixed(2), number: String(1000 + parseInt(id.slice(1)) * 37), dir: 'expense', exempt: false, foreign: false, linkOnly: false, desc: '', ...extra });
  S.docs = [
    doc('d1','2026-09-28','חברת החשמל לישראל בע"מ','tax_invoice_receipt',412.30),
    doc('d2','2026-10-20','שטיינברג שמאות מקרקעין','tax_invoice_receipt',4680,{ dir: 'income', customer: 'יעל לוי', desc: 'שומת דירה — לקוחה יעל לוי' }),
    doc('d3','2026-10-30','אבי מזרחי, רואה חשבון','tax_invoice',1755),
    doc('d4','2026-10-03','פז חברת נפט בע"מ','tax_invoice_receipt',320.50),
    doc('d5','2026-10-07','Google Ireland Ltd','receipt',24,{ currency: 'USD', foreign: true, vat: null, aliases: ['Google Workspace'] }),
    doc('d6','2026-10-18','PayPal','payment_confirmation',199,{ aliases: ['Adobe'], desc: 'אישור תשלום, לא חשבונית' }),
    doc('d7','2026-10-22','סלקום ישראל בע"מ','tax_invoice_receipt',89.90),
    doc('d8','2026-11-05','Zoom Video Communications','receipt',15.99,{ currency: 'USD', foreign: true, vat: null }),
    doc('d9','2026-10-25','מגה ספורט','tax_invoice_receipt',349,{ review: 'pending', taxId: '513456789', desc: 'נעלי ספורט' }),
    doc('d10','2026-11-01','הוט מובייל','tax_invoice',75,{ linkOnly: true, desc: 'החשבונית בקישור בלבד', review: 'pending', number: '' }),
    doc('d11','2026-10-01','יד שרה','receipt',180,{ vat: null, desc: 'קבלה על תרומה, סעיף 46' }),
    doc('d12','2026-11-12','דפוס הצפון בע"מ','tax_invoice',7080,{ taxId: '514223344', desc: 'הדפסת חוברות שמאות' })
  ];
  const em = (id, date, from, subject, status, docIds = [], note = '') => ({ id, threadId: id, date, from, subject, viewUrl: null, status, docIds, note });
  S.emails = [
    em('ed1','2026-09-28','חברת החשמל','החשבון שלך לתקופה 08-09/2026','doc',['d1']),
    em('ed2','2026-10-20','חשבונית ירוקה','חשבונית מס/קבלה 2231 — יעל לוי','doc',['d2']),
    em('ed3','2026-10-30','אבי מזרחי','חשבונית עבור ייעוץ אוקטובר','doc',['d3']),
    em('ed4','2026-10-03','פז','הקבלה שלך מתדלוק','doc',['d4']),
    em('ed5','2026-10-07','Google Payments','Your Google Workspace receipt','doc',['d5']),
    em('ed6','2026-10-18','PayPal','קבלה על התשלום ל-Adobe','doc',['d6']),
    em('ed7','2026-10-22','סלקום','החשבונית החודשית שלך','doc',['d7']),
    em('ed8','2026-11-05','Zoom','Zoom payment receipt','doc',['d8']),
    em('ed9','2026-10-25','מגה ספורט','חשבונית מס/קבלה על הזמנתך','doc',['d9']),
    em('ed10','2026-11-01','HOT mobile','החשבונית שלך מוכנה לצפייה','link',['d10'],'החשבונית בקישור. יש להוריד אותה ידנית'),
    em('ed11','2026-10-11','אופיס דיפו','מבצעי סוף חודש — עד 40% הנחה','irrelevant',[],'פרסומת'),
    em('ed12','2026-11-09','Wolt','הצעת מחיר לאירוע','irrelevant',[],'הצעת מחיר, לא חשבונית')
  ];
  S.links = [
    { t:'t1', d:'d1', by:'auto', conf:.95, reason:'סכום זהה, אותו ספק' },
    { t:'t6', d:'d2', by:'ai', conf:.93, reason:'סכום ותאריך זהים, הלקוחה יעל לוי' },
    { t:'t7', d:'d3', by:'auto', conf:.9, reason:'סכום זהה, אבי מזרחי' },
    { t:'c1', d:'d4', by:'auto', conf:.97, reason:'סכום ותאריך זהים, פז' },
    { t:'c2', d:'d5', by:'ai', conf:.88, reason:'‏24$ הומרו ל-92.40 ₪, Google Workspace' },
    { t:'c5', d:'d6', by:'ai', conf:.86, reason:'PAYPAL *ADOBE = תשלום ל-Adobe דרך PayPal' },
    { t:'c6', d:'d7', by:'auto', conf:.96, reason:'סכום זהה, סלקום' },
    { t:'c9', d:'d8', by:'ai', conf:.9, reason:'‏15.99$ = 58.30 ₪, Zoom' },
    { t:'t9', d:'d11', by:'auto', conf:.95, reason:'סכום ותאריך זהים, יד שרה' }
  ];
  S.rejects = []; S.overrides = {}; S.threads = {};
  S.settings.from = '2026-09-01'; S.settings.to = '2026-11-30';
  S.demo = true;
}
function clearDemo(){
  if (!S.demo) return;
  S.sources = []; S.tx = []; S.emails = []; S.docs = []; S.links = []; S.rejects = []; S.overrides = {}; S.threads = {};
  S.settings.from = ''; S.settings.to = '';
  S.demo = false; syncInputs();
  markDirty(...KEYS);
}

/* ============================== AI ============================== */
function aiTier(kind){
  const precise = S.settings.aiMode === 'precise';
  if (kind === 'match') return precise ? 'best' : 'main';
  if (kind === 'map' || kind === 'statement' || kind === 'ask') return 'main';
  return precise ? 'main' : 'fast';
}
async function ai(prompt, { kind = 'classify', signal, json = true, docs } = {}){
  if (!CAP.ai) throw { code: 'no_ai', src: 'server' };
  const r = await api('/ai', { method: 'POST', signal, body: { prompt, kind, tier: aiTier(kind), json, docs } });
  return json ? r.json : r.text;
}
function bizLine(){ const b = S.settings.bizNames.trim(); return b ? `The user's own business / owner names: ${b}.` : 'The user did not specify business names.'; }
function ruleNeed(t){
  const d = t.desc;
  if (/משיכ|כספומט|בנקט|עמל|ריבית|הלוואה|ביטוח לאומי|מס הכנסה|מע"מ|מע״מ|ישראכרט|כאל|מקס איט|לאומי קארד|אמריקן אקספרס|דיינרס|חיוב כרטיס|משכורת|הפקדת|פקדון|פיקדון/.test(d)) return ['no', 'לפי מילות מפתח: תנועה בנקאית שלא דורשת חשבונית'];
  if (/העברה|העב'|ביט|bit|paybox|פייבוקס|שיק|צ'ק|צק/i.test(d)) return ['maybe', 'לפי מילות מפתח: העברה או צ׳ק. בדוק עבור מה'];
  return ['yes', t.dir === 'in' ? 'לפי מילות מפתח: הכנסה, צריך קבלה שהוצאת' : 'לפי מילות מפתח: תשלום לבית עסק'];
}

/* ============================== מסמכים שחולצו ============================== */
function addDocs(res, ctx){
  const out = [];
  if (!res || typeof res !== 'object' || res.relevant === false || !Array.isArray(res.documents)) return out;
  for (const x of res.documents){
    if (!x || typeof x !== 'object') continue;
    const amount = num(x.amount);
    const vendor = str(x.vendor);
    if (amount == null && !vendor) continue;
    let currency = str(x.currency).toUpperCase();
    currency = /₪|ש"ח|ש״ח|NIS|שקל/.test(currency) || !currency ? 'ILS' : /\$|דולר/.test(currency) ? 'USD' : /€|אירו|יורו/.test(currency) ? 'EUR' : currency;
    if (!/^[A-Z]{3}$/.test(currency)) currency = 'ILS';
    const d = {
      id: 'D' + hash([ctx.key, str(x.source), str(x.number), amount, vendor].join('|')),
      origin: ctx.origin, emailId: ctx.emailId || null, viewUrl: ctx.viewUrl || null,
      fileName: str(x.source) && str(x.source) !== 'body' ? str(x.source) : (ctx.fileName || null),
      docType: DOC_TYPES[x.docType] ? x.docType : 'other',
      vendor: vendor || 'לא ידוע', customer: str(x.customer), aliases: arr(x.aliases), taxId: /\d/.test(str(x.taxId)) ? str(x.taxId).replace(/[^\d-]/g, '') : '', category: '',
      date: parseDate(str(x.date)) || ctx.fallbackDate || null, amount: amount == null ? null : Math.abs(amount), currency,
      vat: num(x.vat), number: str(x.number), dir: x.direction === 'income' ? 'income' : 'expense',
      exempt: !!x.exempt, foreign: !!x.foreign || currency !== 'ILS', linkOnly: !!x.linkOnly,
      cardLast4: str(x.cardLast4), desc: str(x.description), allocNum: str(x.allocationNumber).replace(/\D/g, ''), review: 'pending'
    };
    const f = ctx.file || ctx.files?.[str(x.source)];
    if (f?.id){ d.fileId = f.id; d.fileUrl = f.url; }
    const dup = S.docs.find(o => o.id === d.id || (d.number && o.number === d.number && o.amount != null && d.amount != null && Math.abs(o.amount - d.amount) < 0.02 && nameSim(o.vendor, d.vendor) > 0.45));
    if (dup){ if (f?.id && !dup.fileId){ dup.fileId = f.id; dup.fileUrl = f.url; } out.push(dup); continue; }
    S.docs.push(d); out.push(d);
  }
  return out;
}

/* ============================== סריקת Gmail ============================== */
async function scanGmail(force = false){
  if (jobs.mail) return;
  setNote('mail', null);
  if (!CAP.me){ setNote('mail', 'info', 'הדף עדיין נטען. נסה שוב בעוד רגע.'); return; }
  if (CAP.gmail !== 'ok'){ setNote('mail', 'err', errText({ code: CAP.gmail === 'no_gmail_scope' ? 'no_gmail_scope' : 'needs_reauth' })); return; }
  if (!CAP.ai){ setNote('mail', 'err', errText({ code: 'no_ai' })); return; }
  clearDemo();
  const ctl = new AbortController();
  jobs.mail = { label: 'מחפש מיילים עם חשבוניות…', done: 0, total: 0, ctl };
  renderJobs();
  const p = period();
  // חשבוניות מגיעות לפעמים לפני החיוב או עד חודש אחריו, לכן מרחיבים את חלון החיפוש
  const after = addDays(p.from, -10), beforeRaw = addDays(p.to, 32), cap = addDays(todayISO(), 1);
  const q = `${S.settings.gmailQuery.trim() || DEFAULT_QUERY} after:${after.replace(/-/g, '/')} before:${(beforeRaw < cap ? beforeRaw : cap).replace(/-/g, '/')}`;
  const seen = new Set(force ? [] : S.emails.filter(e => e.status !== 'error').map(e => e.id));
  let threads = [], token = null, fatal = null, newDocs = 0, errors = 0;
  try {
    do {
      const r = await api('/gmail/search', { method: 'POST', signal: ctl.signal, body: { query: q, pageToken: token } });
      threads.push(...(r.threads || []));
      token = r.nextPageToken || null;
      jobs.mail.label = `נמצאו ${threads.length} שרשורים…`; renderJobs();
    } while (token && threads.length < (S.settings.maxThreads || 300) && !ctl.signal.aborted);
  } catch (e){ fatal = e; }
  // שרשור שלא השתנה מאז הסריקה הקודמת לא נקרא שוב
  const work = fatal ? [] : threads.slice(0, S.settings.maxThreads || 300).filter(th => force || S.threads[th.id] !== th.historyId);
  jobs.mail.total = work.length; jobs.mail.label = work.length ? 'קורא מיילים ומחלץ חשבוניות' : 'אין מיילים חדשים לקריאה'; renderJobs();
  if (force){ const ids = new Set(work.map(t => t.id)); S.emails = S.emails.filter(e => !ids.has(e.threadId)); }
  let lastRender = 0;
  await pool(work, 2, ctl, async th => {
    const { messages } = await api('/gmail/thread', { method: 'POST', signal: ctl.signal, body: { threadId: th.id } });
    let ok = true;
    for (const m of messages || []){
      if (ctl.signal.aborted) return;
      if (seen.has(m.id)) continue;
      try {
        const r = await api('/gmail/extract', { method: 'POST', signal: ctl.signal, body: { messageId: m.id, bizNames: S.settings.bizNames, precise: S.settings.aiMode === 'precise', drive: driveOn() } });
        S.emails = S.emails.filter(e => e.id !== m.id);
        newDocs += recordEmail(r.meta, r.result, r.files);
        if (r.driveError) UI.driveErr = r.driveError;
        seen.add(m.id);
      } catch (e){
        if (isFatal(e)) throw e;
        ok = false; errors++;
        S.emails = S.emails.filter(x => x.id !== m.id);
        S.emails.push(emailRecord(m, 'error', [], 'לא הצלחתי לקרוא את המייל הזה. "סרוק" ינסה שוב'));
      }
    }
    if (ok) S.threads[th.id] = th.historyId;
    if (jobs.mail) jobs.mail.done++;
    if (Date.now() - lastRender > 700){ lastRender = Date.now(); rederive(); renderJobs(); renderMail(); renderDocs(); renderSummary(); markDirty('emails', 'docs', 'threads'); }
  }).catch(e => { fatal = e; });
  const done = jobs.mail ? jobs.mail.done : 0;
  delete jobs.mail;
  markDirty('emails', 'docs', 'threads');
  localMatch();
  rederive(); renderAll();
  const summary = `${done} שרשורים נקראו, ${newDocs} מסמכים חדשים${newDocs ? ' (ממתינים לאישור)' : ''}${errors ? `, ${errors} מיילים לא נקראו` : ''}.`;
  if (fatal?.code === 'cancelled') setNote('mail', 'info', `הסריקה הופסקה. ${summary} לחיצה על "סרוק" תמשיך מאותה נקודה.`);
  else if (fatal) setNote('mail', 'err', `${errText(fatal)} ${done ? summary : ''}`);
  else setNote('mail', 'okn', work.length ? `הסריקה הסתיימה: ${summary}` : 'אין מיילים חדשים בתקופה הזו. אפשר להרחיב את התקופה או לשנות את מילות החיפוש.');
  driveWarn();
}
// אם השמירה ב-Drive נכשלה באמצע עבודה, מודיעים פעם אחת בסוף
function driveWarn(){
  const e = UI.driveErr; UI.driveErr = null;
  if (!e) return;
  if (e === 'no_drive_scope' || e === 'needs_reauth'){ if (CAP.drive) CAP.drive.canWrite = false; renderCaps(); }
  toast(e === 'no_drive_scope' || e === 'drive_api_disabled' ? errText({ code: e }) : 'חלק מהקבצים לא נשמרו ב-Google Drive. החשבוניות עצמן נקראו ונשמרו באתר.', 7000);
}
function emailRecord(m, status, docIds, note){
  return { id: m.id, threadId: m.threadId, date: (m.date || '').slice(0, 10) || null, from: m.from || m.fromEmail || '', fromEmail: m.fromEmail || '', subject: m.subject || '(ללא נושא)', viewUrl: m.viewUrl || null, status, docIds, note: note || '' };
}
function recordEmail(meta, res, files){
  const docs = addDocs(res, { origin: 'gmail', emailId: meta.id, viewUrl: meta.viewUrl, key: meta.id, fallbackDate: (meta.date || '').slice(0, 10), files });
  const linkOnly = docs.length && docs.every(d => d.linkOnly);
  const status = !docs.length ? 'irrelevant' : linkOnly ? 'link' : 'doc';
  S.emails.push(emailRecord(meta, status, docs.map(d => d.id), status === 'link' ? 'המסמך נמצא בקישור. פתח את המייל והורד אותו' : (res?.reason ? str(res.reason).slice(0, 120) : '')));
  return docs.length;
}
async function pool(items, n, ctl, fn){
  let i = 0, err = null;
  const worker = async () => {
    while (i < items.length && !err && !ctl.signal.aborted){
      const it = items[i++];
      try { await fn(it); } catch (e){ err = e; ctl.abort(); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (err) throw err;
  if (ctl.signal.aborted) throw { code: 'cancelled' };
}

/* ============================== העלאת מסמכים ידנית ============================== */
// קובץ ZIP (למשל גיבוי ממורנינג) נפתח כאן בדפדפן, ורק קבצי ה-PDF והתמונות שבתוכו נקראים
const DOC_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
async function unzipDocs(file){
  if (typeof DecompressionStream === 'undefined') throw { code: 'zip_unsupported' };
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  if (eocd < 0) throw { code: 'bad_zip' };
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++){
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw { code: 'bad_zip' };
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const base = name.split(/[\\/]/).pop(), type = DOC_EXT[(base.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()];
    if (!base || !type || base.startsWith('._') || (flags & 1) || csize === 0xFFFFFFFF) continue; // תיקייה, סוג אחר, קובץ מוצפן או ZIP64
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = buf.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    out.push(new File([bytes], base, { type, lastModified: file.lastModified }));
  }
  return out;
}
const isZip = f => /\.zip$/i.test(f.name) || /zip/i.test(f.type);
async function importDocFiles(files){
  if (jobs.doc) return;
  setNote('doc', null);
  if (!CAP.ai){ setNote('doc', 'err', errText({ code: 'no_ai' })); return; }
  // פותחים קבצי ZIP
  const list = [], zipErr = [];
  for (const f of files){
    if (!isZip(f)){ list.push(f); continue; }
    try { const inner = await unzipDocs(f); list.push(...inner); if (!inner.length) zipErr.push(`${f.name}: אין בו קבצי PDF או תמונות`); }
    catch (e){ zipErr.push(`${f.name}: ${e.code === 'zip_unsupported' ? 'הדפדפן לא יודע לפתוח ZIP. חלץ אותו (קליק ימני ← "חלץ הכל") וגרור את הקבצים' : 'לא הצלחתי לפתוח את קובץ ה-ZIP'}`); }
  }
  if (!list.length){ setNote('doc', 'err', zipErr.join(' · ') || 'לא נמצאו קבצים לקריאה.'); return; }
  clearDemo();
  const ctl = new AbortController();
  jobs.doc = { label: 'Claude קורא את המסמכים', done: 0, total: list.length, ctl }; renderJobs();
  let added = 0, fatal = null;
  const fails = [], notDoc = [];
  for (const f of list){
    if (ctl.signal.aborted) break;
    try {
      if (f.size > 25 * 1024 * 1024) throw { code: 'too_big' };
      if (!f.size) throw { code: 'read_failed' };
      let data;
      try { data = await fileToB64(f); } catch { throw { code: 'read_failed' }; }
      if (!data) throw { code: 'read_failed' };
      const body = { name: f.name, mime: f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : ''), data, bizNames: S.settings.bizNames, precise: S.settings.aiMode === 'precise', drive: driveOn() };
      let r;
      try { r = await api('/extract-file', { method: 'POST', signal: ctl.signal, body }); }
      catch (e){
        // תקלה זמנית בשרת (למשל כשהוא מתעורר): מנסים שוב פעם אחת
        if (e?.code === 'offline' || e?.code === 'server_error' || e?.status >= 500){ await new Promise(res => setTimeout(res, 4000)); r = await api('/extract-file', { method: 'POST', signal: ctl.signal, body }); }
        else throw e;
      }
      const docs = addDocs(r.result, { origin: 'upload', fileName: f.name, key: f.name + f.size + f.lastModified, file: r.file });
      if (r.driveError) UI.driveErr = r.driveError;
      added += docs.length;
      if (!docs.length) notDoc.push(f.name);
    } catch (e){
      if (isFatal(e)){ fatal = e; break; }
      fails.push({ name: f.name, msg: e?.code === 'too_big' ? 'הקובץ גדול מ-25MB' : e?.code === 'bad_file' ? 'אפשר להעלות רק PDF או תמונה' : errText(e) });
    }
    jobs.doc.done++; renderJobs();
    if (added && jobs.doc.done % 5 === 0){ markDirty('docs'); renderReview(); }
  }
  delete jobs.doc;
  markDirty('docs'); localMatch(); rederive(); renderAll();
  // סיכום אחד במקום הודעה על כל קובץ
  const parts = [];
  if (fatal) parts.push(errText(fatal));
  if (added) parts.push(`נוספו ${added} מסמכים. הם ממתינים לאישור שלך.`);
  if (fails.length){
    const byMsg = new Map(); for (const x of fails) byMsg.set(x.msg, (byMsg.get(x.msg) || 0) + 1);
    parts.push(`${fails.length === 1 ? `הקובץ ${fails[0].name} לא נקרא` : `${fails.length} קבצים לא נקראו`}: ${[...byMsg.entries()].map(([m, n]) => fails.length > 1 && byMsg.size > 1 ? `${m} (${n})` : m).join(' · ')}`);
  }
  if (notDoc.length) parts.push(`${notDoc.length === 1 ? `ב-${notDoc[0]}` : `ב-${notDoc.length} קבצים`} לא זוהתה חשבונית או קבלה.`);
  if (zipErr.length) parts.push(zipErr.join(' · '));
  setNote('doc', fatal || (fails.length && !added) ? 'err' : 'okn', parts.join(' ') || 'לא נוספו מסמכים.');
  if (added && !fatal) switchTab('review');
  driveWarn();
}

/* ============================== ייבוא דפי בנק ואשראי ============================== */
const cellStr = c => c == null ? '' : (c instanceof Date ? (parseDate(c) || '') : String(c)).replace(BIDI, '').replace(/\s+/g, ' ').trim();
function decodeText(buf){
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { try { return new TextDecoder('windows-1255').decode(buf); } catch { return new TextDecoder().decode(buf); } }
}
function readWorkbook(buf, name){
  if (!window.XLSX) throw { code: 'no_xlsx' };
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'csv' || ext === 'txt') return XLSX.read(decodeText(buf).replace(/^﻿/, ''), { type: 'string', raw: true });
  try {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true, codepage: 1255 });
    if (wb.SheetNames.length) return wb;
  } catch {}
  return XLSX.read(decodeText(buf), { type: 'string', raw: true });
}
function isHeaderish(row){
  const cells = row.map(cellStr).filter(Boolean);
  if (cells.length < 3) return false;
  if (cells.some(c => parseDate(c))) return false;
  return cells.some(c => /תאריך|סכום|חובה|זכות|date|amount/i.test(c));
}
function rowsPreview(rows){
  const pick = [];
  for (let i = 0; i < rows.length && pick.length < 40; i++){ if (i < 24 || isHeaderish(rows[i])) pick.push(i); }
  return pick.map(i => `${i}: ` + rows[i].slice(0, 26).map((c, j) => { const s = cellStr(c).slice(0, 42); return s ? `[${j}] ${s}` : ''; }).filter(Boolean).join(' | ')).join('\n');
}
function mapPrompt(preview, sheet, file){
  return `You are reading an export from an Israeli bank account or credit card ("${file}", sheet "${sheet}"). Each line is "rowIndex: [cellIndex] value | ...". Identify the account and every transaction table section in it.

${preview}

Reply with ONLY JSON:
{"accountType":"bank|credit","accountLabel":"short Hebrew label, e.g. \\"בנק לאומי 12-345/67\\" or \\"ויזה כאל 4417\\"","cardLast4":"1234 or null","sections":[{"headerRow":0,"columns":{"date":0,"chargeDate":null,"description":1,"amount":null,"debit":null,"credit":null,"currency":null,"originalAmount":null,"originalCurrency":null,"reference":null},"amountMeaning":"expense_positive|expense_negative|debit_credit_columns"}]}

Column numbers are the [cellIndex] numbers. headerRow is the rowIndex of the column titles; data rows follow it until the next section.
Credit cards: date = תאריך עסקה/רכישה, chargeDate = תאריך חיוב, description = שם בית העסק, amount = סכום חיוב (ILS), originalAmount/originalCurrency = סכום העסקה המקורי ומטבע when shown. Card charges are usually positive (expense_positive).
Banks: debit = חובה/בחובה, credit = זכות/בזכות → amountMeaning "debit_credit_columns". If there is one signed amount column, use "amount" and say whether expenses are negative. Ignore balance (יתרה) columns.
If there is no transaction table, return "sections":[].`;
}
function heuristicMap(rows){
  for (let i = 0; i < Math.min(rows.length, 60); i++){
    const r = rows[i].map(cellStr);
    if (!isHeaderish(rows[i])) continue;
    const find = re => { const j = r.findIndex(c => re.test(c)); return j < 0 ? null : j; };
    const cols = {
      date: find(/תאריך\s*(העסקה|עסקה|רכישה)/) ?? find(/^תאריך$|תאריך\s*(ערך|פעולה)?$|date/i),
      chargeDate: find(/תאריך\s*חיוב/),
      description: find(/בית\s*ה?עסק|תיאור|פרטים|הפעולה|תנועה|description/i),
      debit: find(/חובה/), credit: find(/זכות/),
      amount: find(/סכום\s*(ה)?חיוב/) ?? find(/סכום|amount/i),
      originalAmount: find(/סכום\s*(ה)?עסקה|סכום\s*מקורי/),
      currency: null, originalCurrency: find(/מטבע/), reference: find(/אסמכתא/)
    };
    if (cols.date == null || cols.description == null) continue;
    const credit = /בית\s*ה?עסק|חיוב/.test(r.join(' '));
    if (cols.originalAmount === cols.amount) cols.originalAmount = null;
    return { accountType: credit ? 'credit' : 'bank', accountLabel: '', cardLast4: null, sections: [{ headerRow: i, columns: cols, amountMeaning: cols.debit != null && cols.credit != null ? 'debit_credit_columns' : credit ? 'expense_positive' : 'expense_negative' }] };
  }
  return null;
}
function normMap(m){
  if (!m || typeof m !== 'object') return null;
  const toIdx = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const sections = (Array.isArray(m.sections) ? m.sections : []).map(s => {
    const c = s?.columns || {}, cols = {};
    for (const k of ['date','chargeDate','description','amount','debit','credit','currency','originalAmount','originalCurrency','reference']) cols[k] = toIdx(c[k]);
    return { headerRow: toIdx(s?.headerRow), columns: cols, amountMeaning: ['expense_positive','expense_negative','debit_credit_columns'].includes(s?.amountMeaning) ? s.amountMeaning : (cols.debit != null && cols.credit != null ? 'debit_credit_columns' : 'expense_positive') };
  }).filter(s => s.headerRow != null && s.columns.date != null && (s.columns.amount != null || s.columns.debit != null || s.columns.credit != null));
  return { accountType: m.accountType === 'credit' ? 'credit' : 'bank', accountLabel: str(m.accountLabel), cardLast4: str(m.cardLast4), sections };
}
function curCode(s){ s = String(s || ''); return /\$|USD|דולר/i.test(s) ? 'USD' : /€|EUR|אירו|יורו/i.test(s) ? 'EUR' : /£|GBP|ליש/i.test(s) ? 'GBP' : ''; }
function applyMapping(rows, map, srcId){
  const out = [];
  const secs = (map.sections || []).filter(s => Number.isInteger(s.headerRow)).sort((a, b) => a.headerRow - b.headerRow);
  secs.forEach((sec, si) => {
    const c = sec.columns || {};
    const end = si + 1 < secs.length ? secs[si + 1].headerRow : rows.length;
    const get = (row, k) => (c[k] == null || c[k] === '' ? undefined : row[c[k]]);
    for (let r = sec.headerRow + 1; r < end; r++){
      const row = rows[r] || [];
      const date = parseDate(get(row, 'date'));
      if (!date) continue;
      const desc = cellStr(get(row, 'description'));
      if (/^סה"?כ|סך הכל|total/i.test(desc)) continue;
      let amount = null, dir = null;
      if (sec.amountMeaning === 'debit_credit_columns' || (c.debit != null && c.credit != null && c.amount == null)){
        const db = parseAmount(get(row, 'debit')), cr = parseAmount(get(row, 'credit'));
        if (db) { amount = Math.abs(db); dir = db > 0 ? 'out' : 'in'; }
        else if (cr) { amount = Math.abs(cr); dir = cr > 0 ? 'in' : 'out'; }
      } else {
        let a = parseAmount(get(row, 'amount'));
        if ((a == null || a === 0) && c.originalAmount != null){ const cur = cellStr(get(row, 'originalCurrency')); if (!cur || /₪|ש"ח|ILS|NIS|שקל/.test(cur)) a = parseAmount(get(row, 'originalAmount')); }
        if (a != null && a !== 0){ amount = Math.abs(a); dir = sec.amountMeaning === 'expense_negative' ? (a < 0 ? 'out' : 'in') : (a > 0 ? 'out' : 'in'); }
      }
      if (!amount) continue;
      const origAmount = c.originalAmount != null ? parseAmount(get(row, 'originalAmount')) : null;
      const origCurrency = c.originalCurrency != null ? curCode(cellStr(get(row, 'originalCurrency'))) : '';
      out.push({ sourceId: srcId, date, chargeDate: parseDate(get(row, 'chargeDate')), desc: desc || '(ללא תיאור)', amount: +amount.toFixed(2), dir, currency: 'ILS',
        origAmount: origCurrency && origAmount ? Math.abs(origAmount) : null, origCurrency: origCurrency && origAmount ? origCurrency : null,
        ref: cellStr(get(row, 'reference')) });
    }
  });
  return out;
}
function addTx(list, source){
  const have = new Set(S.tx.map(t => t.id));
  const occ = {}; let added = 0;
  for (const t of list){
    const base = hash([source.label || source.fileName, t.date, t.amount, t.dir, t.desc].join('|'));
    occ[base] = (occ[base] || 0) + 1;
    t.id = 'T' + base + '-' + occ[base];
    if (have.has(t.id)) continue;
    t.merchant = ''; t.aliases = []; t.category = ''; t.needsDoc = null; t.needReason = '';
    if (!CAP.ai){ const [n, r] = ruleNeed(t); t.needsDoc = n; t.needReason = r; t.ruleBased = true; }
    S.tx.push(t); have.add(t.id); added++;
  }
  return added;
}
function newSource(map, fileName, sheet){
  const label = str(map.accountLabel) || (fileName + (sheet ? ` · ${sheet}` : ''));
  const existing = S.sources.find(s => s.label === label);
  if (existing) return existing;
  const s = { id: 'S' + hash(label + Date.now() + Math.random()), label, kind: map.accountType === 'credit' ? 'credit' : 'bank', cardLast4: str(map.cardLast4), fileName, count: 0, importedAt: Date.now() };
  S.sources.push(s);
  return s;
}
async function importSheet(f, signal){
  const buf = await f.arrayBuffer();
  const wb = readWorkbook(buf, f.name);
  let total = 0, found = 0;
  for (const sn of wb.SheetNames){
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
    if (rows.length < 2) continue;
    let map = null, fromAI = false;
    if (CAP.ai){
      try { map = normMap(await ai(mapPrompt(rowsPreview(rows), sn, f.name), { kind: 'map', signal })); fromAI = !!map?.sections.length; }
      catch (e){
        if (['cancelled', 'not_logged_in', 'offline'].includes(e?.code)) throw e;
        if (isFatal(e)) UI.aiWarn = e;   // ממשיכים לקרוא את הקובץ בלי AI, ומדווחים בסוף
      }
    }
    if (!fromAI) map = heuristicMap(rows) || map;
    if (!map || !map.sections?.length) continue;
    const src = newSource(map, f.name, wb.SheetNames.length > 1 ? sn : '');
    let list = applyMapping(rows, map, src.id);
    if (!list.length && fromAI){ const h = heuristicMap(rows); if (h) list = applyMapping(rows, h, src.id); }
    found += list.length;
    total += addTx(list, src);
    src.count = S.tx.filter(t => t.sourceId === src.id).length;
    if (!src.count) S.sources = S.sources.filter(s => s !== src);
  }
  return { added: total, found };
}
function statementPrompt(file){
  return `The attached PDF is an Israeli bank or credit-card statement ("${file}"). Extract every transaction.

Reply with ONLY JSON, compact:
{"accountType":"bank|credit","accountLabel":"short Hebrew label like \\"בנק הפועלים 12-345-678\\" or \\"ישראכרט 1234\\"","cardLast4":null,"tx":[["YYYY-MM-DD", "charge date YYYY-MM-DD or null", "description as written", 123.45, "o", null, null]]}
Each tx row is [date, chargeDate, description, amount, direction, originalAmount, originalCurrency]. amount is positive; direction "o" for charges/debits (חובה) and "i" for credits/refunds (זכות). Skip balances, totals and headers. Dates in the statement are day/month/year.`;
}
async function importPdfStatement(f, signal){
  if (!CAP.ai) throw { code: 'no_ai' };
  if (f.size > 25 * 1024 * 1024) throw { code: 'too_big' };
  const data = await fileToB64(f);
  const res = await ai(statementPrompt(f.name), { kind: 'statement', signal, docs: [{ data }] });
  if (!res || !Array.isArray(res.tx)) return { added: 0, found: 0 };
  const src = newSource(res, f.name, '');
  const all = [];
  for (const row of res.tx){
    if (!Array.isArray(row)) continue;
    const [d, cd, desc, amt, dir, oa, oc] = row;
    const date = parseDate(str(d)), amount = num(amt);
    if (!date || !amount) continue;
    all.push({ sourceId: src.id, date, chargeDate: parseDate(str(cd)), desc: str(desc) || '(ללא תיאור)', amount: Math.abs(amount), dir: dir === 'i' ? 'in' : 'out', currency: 'ILS', origAmount: num(oa), origCurrency: curCode(oc) || null, ref: '' });
  }
  const n = addTx(all, src);
  src.count = S.tx.filter(t => t.sourceId === src.id).length;
  if (!src.count) S.sources = S.sources.filter(s => s !== src);
  return { added: n, found: all.length };
}
async function importBankFiles(files){
  if (jobs.bank) return;
  setNote('bank', null);
  if (!window.XLSX && [...files].some(f => !/\.pdf$/i.test(f.name))){ setNote('bank', 'err', errText({ code: 'no_xlsx' })); return; }
  clearDemo();
  const ctl = new AbortController();
  jobs.bank = { label: 'קורא קבצים מהבנק', done: 0, total: files.length, ctl }; renderJobs();
  const msgs = []; let fatal = null;
  const before = new Set(S.tx.map(t => t.id));
  for (const f of files){
    if (ctl.signal.aborted) break;
    try {
      const r = /\.pdf$/i.test(f.name) ? await importPdfStatement(f, ctl.signal) : await importSheet(f, ctl.signal);
      msgs.push(r.found ? `${f.name}: ${r.added} תנועות חדשות${r.found > r.added ? ` (${r.found - r.added} כבר היו)` : ''}` : `${f.name}: לא מצאתי טבלת תנועות`);
    } catch (e){
      if (isFatal(e) && e.code !== 'no_ai'){ fatal = e; break; }
      msgs.push(`${f.name}: ${e?.code === 'no_ai' ? 'קריאת PDF דורשת Claude. הורד מהבנק קובץ אקסל.' : e?.code === 'too_big' ? 'הקובץ גדול מ-25MB' : e?.code === 'truncated' ? errText(e) : e?.code === 'no_xlsx' ? errText(e) : 'לא הצלחתי לקרוא את הקובץ'}`);
    }
    jobs.bank.done++; renderJobs();
  }
  delete jobs.bank;
  const fresh = S.tx.filter(t => !before.has(t.id)).map(t => t.date).sort();
  if (fresh.length){
    const p = period();
    S.settings.from = fresh[0] < p.from || !S.settings.from ? fresh[0] : p.from;
    S.settings.to = fresh[fresh.length - 1] > p.to || !S.settings.to ? fresh[fresh.length - 1] : p.to;
    syncInputs(); markDirty('settings');
  }
  markDirty('sources', 'tx');
  localMatch(); rederive(); renderAll();
  const warn = UI.aiWarn; UI.aiWarn = null;
  setNote('bank', fatal || warn ? 'err' : 'info', (fatal ? errText(fatal) + ' ' : warn ? errText(warn) + ' הקבצים נקראו בלי AI. ' : '') + msgs.join(' · '));
  if (CAP.ai && !warn && S.tx.some(t => !t.needsDoc || t.ruleBased)) classifyAll();
  else if (warn){ for (const t of S.tx) if (!t.needsDoc){ const [n, r] = ruleNeed(t); t.needsDoc = n; t.needReason = r; t.ruleBased = true; } markDirty('tx'); rederive(); renderAll(); }
}

/* ============================== סיווג תנועות ושם בית העסק ============================== */
const normDesc = s => str(s).toLowerCase().replace(/\d{3,}/g, '#').replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();
function classifyPrompt(lines){
  return `These are transaction lines from Israeli bank and credit-card statements of a business owner. ${bizLine()}
For each line, identify the real merchant or counterparty behind the (often truncated, transliterated or English) descriptor, and decide whether an invoice or receipt (חשבונית / קבלה) should exist for bookkeeping.

Lines (i | direction | amount ILS | account type | description):
${lines}

Reply with ONLY a JSON array: [{"i":0,"merchant":"recognizable name, Hebrew when the business is Israeli","aliases":["other names: English brand, legal name, Hebrew transliteration"],"category":"short Hebrew category","needsDoc":"yes|no|maybe","reason":"short Hebrew reason","recurring":false,"donation":false}]
donation = true for donations to charities and public institutions (עמותה, ע"ר, חל"צ, ישיבה, בית כנסת, גמ"ח, נדרים פלוס, JGive and similar). A donation is not recurring even when paid by standing order.
recurring = true for fixed periodic charges: standing orders (הוראת קבע), insurance, pension and provident funds, loan and mortgage repayments, electricity, water, gas, municipality (ארנונה), phone, internet and TV, leasing, building committee, and fixed monthly subscriptions. Otherwise false.
needsDoc "no": transfers between the user's own accounts; credit-card bill totals charged in the bank account (ישראכרט, כאל, מקס, לאומי קארד, אמריקן אקספרס, דיינרס — the detail is in the card statement); ATM cash; bank fees, interest and loan repayments (the bank statement is the document); tax and national-insurance payments (מס הכנסה, מע"מ, ביטוח לאומי — the payment confirmation is the document); salary received; deposits of checks; refunds.
needsDoc "maybe": transfers to private people, Bit/PayBox, checks written, supermarket or pharmacy purchases that may be private.
needsDoc "yes": purchases and payments to businesses, subscriptions, suppliers, professionals. For incoming payments from customers, "yes" means the user should have issued a receipt — say so in the reason.`;
}
let classifyPromise = null;
function classifyAll(){
  if (classifyPromise) return classifyPromise;
  if (!CAP.ai) return Promise.resolve();
  classifyPromise = classifyRun().finally(() => { classifyPromise = null; });
  return classifyPromise;
}
async function classifyRun(){
  const pending = S.tx.filter(t => !t.needsDoc || t.ruleBased);
  if (!pending.length) return;
  const groups = new Map();
  for (const t of pending){ const k = t.dir + '|' + normDesc(t.desc); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const keys = [...groups.keys()];
  const batches = [];
  for (let i = 0; i < keys.length; i += 50) batches.push(keys.slice(i, i + 50));
  const ctl = new AbortController();
  jobs.cls = { label: 'Claude מזהה בתי עסק ומסווג תנועות', done: 0, total: batches.length, ctl }; renderJobs();
  let fatal = null;
  await pool(batches, 2, ctl, async batch => {
    const lines = batch.map((k, i) => { const t = groups.get(k)[0]; const src = S.sources.find(s => s.id === t.sourceId); return `${i} | ${t.dir === 'out' ? 'charge' : 'credit'} | ${t.amount} | ${src?.kind === 'credit' ? 'credit card' : 'bank'} | ${t.desc}`; }).join('\n');
    let res;
    try { res = await ai(classifyPrompt(lines), { kind: 'classify', signal: ctl.signal }); }
    catch (e){ if (isFatal(e)) throw e; res = null; }
    if (Array.isArray(res)){
      for (const r of res){
        const k = batch[Number(r?.i)]; if (!k) continue;
        const nd = ['yes','no','maybe'].includes(r.needsDoc) ? r.needsDoc : 'yes';
        for (const t of groups.get(k)){ t.merchant = str(r.merchant); t.aliases = arr(r.aliases); t.category = str(r.category); t.needsDoc = nd; t.needReason = str(r.reason); t.recurring = r.recurring === true; t.donation = r.donation === true; delete t.ruleBased; }
      }
    }
    for (const k of batch) for (const t of groups.get(k)) if (!t.needsDoc){ const [n, r] = ruleNeed(t); t.needsDoc = n; t.needReason = r; t.ruleBased = true; }
    if (jobs.cls) jobs.cls.done++;
    renderJobs();
    if (Date.now() - (UI.lastCls || 0) > 1500){ UI.lastCls = Date.now(); rederive(); renderBank(); renderSummary(); }
  }).catch(e => { fatal = e; });
  delete jobs.cls;
  // תנועות שלא סווגו (למשל כי Claude לא זמין) מקבלות סיווג גיבוי לפי מילות מפתח
  for (const t of S.tx) if (!t.needsDoc){ const [n, r] = ruleNeed(t); t.needsDoc = n; t.needReason = r; t.ruleBased = true; }
  markDirty('tx'); localMatch(); rederive(); renderAll();
  if (fatal && fatal.code !== 'cancelled') setNote('bank', 'err', errText(fatal) + ' סיווגתי לפי מילות מפתח בינתיים.');
}

/* ============================== התאמה ============================== */
const STOP = new Set(['בעמ','בע','מ','ltd','inc','llc','gmbh','co','com','www','il','חברת','חברה','סניף','ושות','the','limited']);
const nameCache = new Map();
function nameTokens(s){
  if (nameCache.has(s)) return nameCache.get(s);
  const n = str(s).toLowerCase().replace(/["'״׳`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const toks = n.split(' ').filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
  const joined = toks.join('');
  const grams = new Set(); for (let i = 0; i < joined.length - 1; i++) grams.add(joined.slice(i, i + 2));
  const v = { toks, grams };
  if (nameCache.size > 5000) nameCache.clear();
  nameCache.set(s, v);
  return v;
}
function nameSim(a, b){
  if (!a || !b) return 0;
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.toks.length || !B.toks.length) return 0;
  let common = 0;
  for (const t of A.toks){ if (B.toks.some(u => u === t || (t.length >= 3 && u.length >= 3 && (u.startsWith(t) || t.startsWith(u))))) common++; }
  const overlap = common / Math.min(A.toks.length, B.toks.length);
  let inter = 0; for (const g of A.grams) if (B.grams.has(g)) inter++;
  const dice = A.grams.size + B.grams.size ? (2 * inter) / (A.grams.size + B.grams.size) : 0;
  return Math.max(overlap * 0.95, dice);
}
function nameScore(t, d){
  const tn = [t.merchant, t.desc, ...(t.aliases || [])].filter(Boolean);
  const dn = (d.dir === 'income' ? [d.customer] : [d.vendor, ...(d.aliases || [])]).filter(Boolean);
  let best = 0;
  for (const a of tn) for (const b of dn){ const s = nameSim(a, b); if (s > best) best = s; }
  return best;
}
function amountScore(t, d){
  if (d.amount == null) return 0;
  const vals = [];
  if (!d.currency || d.currency === 'ILS') vals.push(t.amount);
  if (t.origAmount && t.origCurrency && d.currency === t.origCurrency) vals.push(t.origAmount);
  let best = 0;
  for (const x of vals){
    const diff = Math.abs(x - d.amount), rel = diff / Math.max(1, d.amount);
    const s = diff <= 0.015 ? 1 : rel <= 0.01 ? 0.85 : rel <= 0.03 ? 0.6 : 0;
    if (s > best) best = s;
  }
  return best;
}
function dateScore(t, d){
  if (!d.date || !t.date) return 0;
  const ds = [t.date, t.chargeDate].filter(Boolean).map(x => Math.abs(dayDiff(x, d.date)));
  const days = Math.min(...ds);
  if (days <= 5) return 1;
  if (days > 45) return 0;
  return 1 - (days - 5) / 50;
}
const docSide = d => d.dir === 'income' ? 'in' : d.docType === 'credit_note' ? 'in' : 'out';
const needOf = t => S.overrides[t.id]?.needsDoc || t.needsDoc || null;
function localMatch(){
  S.links = S.links.filter(l => l.by !== 'auto');
  const rej = new Set(S.rejects);
  const used = new Set(S.links.map(l => l.d));
  const txDocs = new Map();
  const docById = new Map(S.docs.map(d => [d.id, d]));
  for (const l of S.links){ if (!txDocs.has(l.t)) txDocs.set(l.t, []); txDocs.get(l.t).push(docById.get(l.d)); }
  const docs = S.docs.filter(d => isApproved(d) && !used.has(d.id) && d.amount != null && d.date);
  const byAmt = new Map();
  for (const d of docs){ const k = Math.round(d.amount); for (const kk of [k - 1, k, k + 1]){ if (!byAmt.has(kk)) byAmt.set(kk, []); byAmt.get(kk).push(d); } }
  const cands = [];
  for (const t of S.tx){
    if (needOf(t) === 'no') continue;
    const near = new Set([...(byAmt.get(Math.round(t.amount)) || []), ...(t.origAmount ? (byAmt.get(Math.round(t.origAmount)) || []) : [])]);
    for (const d of near){
      if (docSide(d) !== t.dir || rej.has(t.id + '|' + d.id)) continue;
      const a = amountScore(t, d); if (a < 0.6) continue;
      const ds = dateScore(t, d); if (ds <= 0) continue;
      const n = nameScore(t, d);
      if (!((a >= 0.99 && n >= 0.34) || (a >= 0.85 && n >= 0.6))) continue;
      cands.push({ t, d, score: 0.5 * a + 0.2 * ds + 0.3 * n });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  for (const c of cands){
    if (used.has(c.d.id)) continue;
    const have = (txDocs.get(c.t.id) || []).filter(Boolean);
    if (have.length && (have.some(h => h.docType === c.d.docType || h.docType === 'tax_invoice_receipt') || c.d.docType === 'tax_invoice_receipt')) continue;
    S.links.push({ t: c.t.id, d: c.d.id, by: 'auto', conf: +c.score.toFixed(2), reason: 'סכום, תאריך ושם תואמים' });
    used.add(c.d.id);
    if (!txDocs.has(c.t.id)) txDocs.set(c.t.id, []);
    txDocs.get(c.t.id).push(c.d);
  }
  markDirty('links');
}
function matchPrompt(txLines, docLines){
  return `Match Israeli bank / credit-card transactions to accounting documents (invoices, receipts). ${bizLine()}
Things to allow for: card descriptors are truncated, English or transliterated ("PAYPAL *ADOBE" = Adobe, "פז יילו" = פז, "GOOGLE*GSUITE" = Google); foreign-currency documents vs. ILS charges (use a plausible exchange rate); installments (תשלומים: one document, several equal charges); one charge paying several documents; an invoice and a separate receipt for the same payment. The document date can be up to ~45 days before or after the charge. "in" transactions match income documents (by customer name) or credit notes; "out" transactions match expense documents.

TRANSACTIONS (id | date | amount | original amount | direction | merchant | description):
${txLines}

DOCUMENTS (id | date | amount currency | type | vendor | aliases | number):
${docLines}

Reply with ONLY a JSON array of matches you are confident about (confidence ≥ 0.6): [{"t":"T3","d":"D7","confidence":0.8,"reason":"short Hebrew reason"}]. Return [] if none.`;
}
async function aiMatchPass(ctl){
  rederive();
  const usedDocs = new Set(S.links.map(l => l.d));
  const rej = new Set(S.rejects);
  const openTx = S.tx.filter(t => !t._docs.length && ['yes','maybe'].includes(needOf(t)));
  const openDocs = S.docs.filter(d => isApproved(d) && !usedDocs.has(d.id) && d.date);
  if (!openTx.length || !openDocs.length) return 0;
  const months = new Map();
  for (const t of openTx){ const m = t.date.slice(0, 7); if (!months.has(m)) months.set(m, []); months.get(m).push(t); }
  const tasks = [];
  for (const [m, txs] of months){
    const start = addDays(m + '-01', -45), end = addDays(m + '-28', 48);
    let ds = openDocs.filter(d => d.date >= start && d.date <= end);
    if (!ds.length) continue;
    if (ds.length > 90){ ds.sort((a, b) => Math.abs(dayDiff(m + '-15', a.date)) - Math.abs(dayDiff(m + '-15', b.date))); ds = ds.slice(0, 90); }
    for (let i = 0; i < txs.length; i += 90) tasks.push({ txs: txs.slice(i, i + 90), ds });
  }
  if (!tasks.length) return 0;
  jobs.match.total += tasks.length; renderJobs();
  let added = 0;
  await pool(tasks, 2, ctl, async task => {
    const tMap = {}, dMap = {};
    const tl = task.txs.map((t, i) => { tMap['T' + i] = t; return `T${i} | ${t.date} | ${t.amount} | ${t.origAmount ? t.origAmount + ' ' + t.origCurrency : '-'} | ${t.dir} | ${t.merchant || '-'} | ${t.desc}`; }).join('\n');
    const dl = task.ds.map((d, i) => { dMap['D' + i] = d; return `D${i} | ${d.date} | ${d.amount ?? '?'} ${d.currency} | ${DOC_TYPES[d.docType]} (${d.dir}${d.dir === 'income' && d.customer ? ', customer: ' + d.customer : ''}) | ${d.vendor} | ${(d.aliases || []).join(', ') || '-'} | ${d.number || '-'}`; }).join('\n');
    let res;
    try { res = await ai(matchPrompt(tl, dl), { kind: 'match', signal: ctl.signal }); }
    catch (e){ if (isFatal(e)) throw e; res = null; }
    for (const m of (Array.isArray(res) ? res : [])){
      const t = tMap[str(m?.t)], d = dMap[str(m?.d)];
      const conf = Number(m?.confidence) || 0;
      if (!t || !d || conf < 0.6 || rej.has(t.id + '|' + d.id)) continue;
      if (S.links.some(l => l.t === t.id && l.d === d.id)) continue;
      S.links.push({ t: t.id, d: d.id, by: 'ai', conf: +conf.toFixed(2), reason: str(m.reason).slice(0, 140) });
      added++;
    }
    jobs.match.done++; renderJobs();
  });
  return added;
}
async function runMatch(){
  if (jobs.match) return;
  if (S.demo){ toast('אלה נתוני דוגמה. העלה קובץ מהבנק או סרוק את המייל כדי להתאים נתונים אמיתיים.'); switchTab('report'); return; }
  if (!S.tx.length){ toast('קודם העלה קובץ תנועות מהבנק או מחברת האשראי.'); return; }
  const ctl = new AbortController();
  jobs.match = { label: 'מתאים תנועות למסמכים', done: 0, total: 1, ctl }; renderJobs();
  let msg = '';
  try {
    if (CAP.ai && (classifyPromise || S.tx.some(t => !t.needsDoc))){ jobs.match.label = 'ממתין לסיווג התנועות'; renderJobs(); await classifyAll(); }
    if (ctl.signal.aborted) throw { code: 'cancelled' };
    const before = S.links.length;
    localMatch(); jobs.match.done = 1; jobs.match.label = 'Claude מתאים את מה שנשאר פתוח'; renderJobs();
    if (CAP.ai){ const n = await aiMatchPass(ctl); msg = n ? `Ka-Ching! נמצאו עוד ${n} התאמות.` : 'לא נמצאו התאמות נוספות.'; }
    else msg = `התאמה בסיסית בוצעה (${Math.max(0, S.links.length - before)} חדשות). Claude לא מוגדר בשרת, לכן התאמות מורכבות לא נבדקו.`;
  } catch (e){ msg = errText(e); }
  delete jobs.match;
  markDirty('links'); rederive(); renderAll();
  toast(msg, 5000);
  switchTab('report');
}

/* ============================== הוראות קבע ============================== */
// תשלום קבוע: הוראת קבע, ביטוח, פנסיה, הלוואה, חשמל, ארנונה, טלפון וכו'. מזוהה לפי:
// סימון ידני לפי ספק, סימון של Claude, מילות מפתח, או אותו סכום (עד 3% הבדל) בכמה חודשים.
// חייב להתאים ל-recurringKeys שב-lib/report.js בשרת.
const RECUR_RX = /הוראת?\s*קבע|(?<![א-ת])הו["״׳'.]?\s?ק(?![א-ת])|ה\.\s?קבע|הרשאה\s*לחיוב|חיוב\s*קבוע|standing\s*order|direct\s*debit|ביטוח|insurance|הפניקס|מגדל\s*(מקפת|חברה|לביטוח)|מנורה\s*מבטחים|איילון\s*(חברה|לביטוח)|שירביט|ליברה|פספורטכארד|פנסי|קופת\s*גמל|קרן\s*השתלמות|מיטב|אלטשולר|ילין\s*לפידות|הלוואה|משכנתא|mortgage|חברת\s*החשמל|ארנונה|עיריי|עירית|תאגיד\s*ה?מים|גיחון|מי\s*אביבים|אמישראגז|פזגז|סופרגז|בזק|סלקום|cellcom|פרטנר|partner|פלאפון|pelephone|גולן\s*טלקום|(?<![א-ת])הוט(?![א-ת])|\bhot\b|\byes\b|ליסינג|leasing|ועד\s*בית/i;
const recKey = t => normDesc(t.merchant || t.desc);
// תרומה (סעיף 46): עמותות, ישיבות, בתי כנסת, נדרים פלוס וכו'. תרומה בהוראת קבע נחשבת תרומה ולא הוראת קבע.
// חייב להתאים ל-DONATION_RX ול-donationKeys שב-lib/report.js בשרת.
const DONATION_RX = /תרומ|עמות|(?<![א-ת])ע["״']ר(?![א-ת])|(?<![א-ת])חל["״']צ(?![א-ת])|צדקה|גמ["״']ח|(?<![א-ת])ישיב|תלמוד\s*תורה|בית\s*כנסת|בית\s*חב["״']?ד|נדרים|קופת\s*(העיר|רבי|ר["״']מ)|jgive|ג['׳]יגיב|israeltoremet|ישראל\s*תורמת|charity|donat|יד\s*שרה|איחוד\s*הצלה|זק["״']א|עזר\s*מציון|יד\s*לאחים/i;
function donationKeys(){
  const rules = S.settings.donationRules || {};
  const groups = new Map();
  for (const t of S.tx){
    if (t.dir !== 'out' || isCardBill(t)) continue;
    const k = recKey(t); if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = new Set();
  for (const [k, list] of groups){
    if (rules[k] === 'no') continue;
    if (rules[k] === 'yes' || list.some(t => t.donation === true) || DONATION_RX.test(list.map(t => `${t.desc} ${t.merchant || ''} ${t.category || ''}`).join(' | '))) out.add(k);
  }
  return out;
}
function recurringKeys(skip = new Set()){
  const rules = S.settings.recurringRules || {};
  const groups = new Map();
  for (const t of S.tx){
    if (t.dir !== 'out' || isCardBill(t)) continue;
    const k = recKey(t); if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = new Set();
  for (const [k, list] of groups){
    if (rules[k] === 'no' || skip.has(k)) continue;
    if (rules[k] === 'yes' || list.some(t => t.recurring === true) || RECUR_RX.test(list.map(t => `${t.desc} ${t.merchant || ''} ${t.category || ''}`).join(' | '))){ out.add(k); continue; }
    const months = new Set(list.map(t => String(t.date).slice(0, 7)));
    const a = list.map(t => t.amount);
    if (months.size >= 2 && list.length <= months.size + 1 && Math.max(...a) <= Math.min(...a) * 1.03 + 0.01) out.add(k);
  }
  return out;
}

/* ============================== נגזרות ============================== */
function rederive(){
  const docById = new Map(S.docs.filter(isApproved).map(d => [d.id, d]));
  const txById = new Map(S.tx.map(t => [t.id, t]));
  S.links = S.links.filter(l => docById.has(l.d) && txById.has(l.t));
  for (const t of S.tx) t._docs = [];
  for (const d of S.docs) d._tx = [];
  const don = donationKeys(), rec = recurringKeys(don);
  for (const t of S.tx){ const k = recKey(t), ok = t.dir === 'out' && !isCardBill(t); t._don = ok && don.has(k); t._rec = ok && !t._don && rec.has(k); }
  for (const l of S.links){ const t = txById.get(l.t), d = docById.get(l.d); t._docs.push(d); d._tx.push(t); }
  for (const t of S.tx) t._status = txStatus(t);
}
const MIN_AMOUNT = 50; // הוצאה קטנה מהסכום הזה (בשקלים) לא נספרת ולא דורשת מסמך, אלא אם סימנת אחרת ידנית
const isSmall = t => t.dir === 'out' && t.amount < MIN_AMOUNT;
const reasonOf = t => isSmall(t) && !S.overrides[t.id] ? `הוצאה מתחת ל-${MIN_AMOUNT} ₪, לא נספרת` : (t.needReason || '');
function docsStatus(t){
  const docs = t._docs || [];
  if (!docs.length) return null;
  if (docs.some(d => d.docType === 'credit_note')) return 'complete';
  const inv = docs.some(d => d.docType === 'tax_invoice_receipt' || d.docType === 'tax_invoice');
  const rec = docs.some(d => d.docType === 'tax_invoice_receipt' || d.docType === 'receipt');
  if ((docs.some(d => d.exempt || d.foreign) || t.dir === 'in') && (inv || rec)) return 'complete';
  if (inv && rec) return 'complete';
  if (inv) return 'no_receipt';
  return 'no_invoice';
}
function txStatus(t){
  if (isSmall(t) && !S.overrides[t.id]) return 'not_needed';
  const ds = docsStatus(t);
  // תרומה והוראת קבע לא נכנסות לדוח החוסרים, אלא אם סימנת ידנית שהתנועה הזו צריכה מסמך
  if (t._don && S.overrides[t.id]?.needsDoc !== 'yes') return 'donation';
  if (t._rec && S.overrides[t.id]?.needsDoc !== 'yes') return ds === 'complete' ? 'complete' : 'recurring';
  if (ds) return ds;
  const need = needOf(t);
  if (need === 'no') return 'not_needed';
  if (need === 'maybe') return 'check';
  if (need === 'yes') return 'missing';
  return 'pending';
}
function srcOf(t){ return S.sources.find(s => s.id === t.sourceId); }
function stats(){
  const p = period();
  const tx = S.tx.filter(t => inPeriod(t.date, p));
  const by = k => tx.filter(t => t._status === k);
  const sum = list => list.reduce((a, t) => a + t.amount, 0);
  const need = tx.filter(t => !['not_needed', 'recurring', 'donation'].includes(t._status));
  const covered = tx.filter(t => ['complete','no_receipt'].includes(t._status));
  const orphans = S.docs.filter(d => isApproved(d) && !d._tx.length && inPeriod(d.date, p));
  return { tx, p, missing: by('missing'), noInv: by('no_invoice'), noRec: by('no_receipt'), check: by('check'), pending: by('pending'), complete: by('complete'), notNeeded: by('not_needed'), recurring: by('recurring'), donations: by('donation'), need, covered, orphans, sum };
}

/* ============================== תצוגה ============================== */
function chip(st){ const m = ST[st]; return `<span class="chip ${m.cls}">${m.label}</span>`; }
function money(t){ return `${t.dir === 'in' ? '+' : ''}${fmtMoney(t.amount)}`; }
function renderAll(){ renderBanner(); renderSummary(); renderJobs(); renderNotes(); renderBank(); renderMail(); renderDocs(); renderReview(); renderReport(); renderFlows(); renderRecurring(); renderDonations(); renderVat(); renderCaps(); }
function renderBanner(){
  const el = $('#demoBanner');
  if (!S.demo){ el.innerHTML = ''; return; }
  el.innerHTML = `<div class="banner"><div class="grow"><strong>אלה נתוני דוגמה.</strong> כך ייראו הנתונים שלך. כשתעלה קובץ מהבנק או תסרוק את המייל, הדוגמה תימחק לבד.</div><button class="btn small" data-act="clear-demo" type="button">התחל עם לוח ריק</button></div>`;
}
function renderSummary(){
  const s = stats();
  const pct = s.need.length ? Math.round(100 * s.covered.length / s.need.length) : 0;
  const tiles = [
    { cls: 'bad', k: 'חסר מסמך', v: s.missing.length, sub: fmtMoney(s.sum(s.missing)) + ' ללא חשבונית או קבלה', go: 'missing' },
    { cls: 'warn', k: 'חסרה חשבונית מס', v: s.noInv.length, sub: 'יש רק אישור תשלום או חשבון עסקה', go: 'noinv' },
    { cls: 'check', k: 'לבדיקה שלך', v: s.check.length + s.pending.length, sub: 'העברות ותנועות שאולי פרטיות', go: 'check' },
    { cls: 'info', k: 'מסמכים ללא תנועה', v: s.orphans.length, sub: 'חשבוניות שלא מצאתי להן חיוב', go: 'orphans' },
    { cls: 'ok', k: 'מגובות במסמך', v: `${pct}%`, sub: `${s.covered.length} מתוך ${s.need.length} תנועות שדורשות מסמך`, meter: pct, go: 'complete' }
  ];
  $('#summary').innerHTML = tiles.map(t => `<button class="tile ${t.cls}${t.v === 0 ? ' zero' : ''}" data-act="goto" data-go="${t.go}" type="button"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${esc(t.sub)}</div>${t.meter != null ? `<div class="meter"><i style="width:${t.meter}%"></i></div>` : ''}</button>`).join('');
  const cnt = s.missing.length + s.noInv.length;
  $('#reportCnt').textContent = cnt ? cnt : '';
  $('#reportCnt').classList.toggle('hidden', !cnt);
}
function renderJobs(){
  const list = Object.entries(jobs);
  $('#jobs').innerHTML = list.map(([k, j]) => {
    const pct = j.total ? Math.round(100 * j.done / j.total) : 8;
    return `<div class="job"><div class="lbl">${esc(j.label)}${j.total > 1 ? ` · <span class="num">${j.done}/${j.total}</span>` : ''}</div><div class="bar"><i style="width:${Math.max(4, pct)}%"></i></div><button class="btn small" data-act="stop" data-job="${k}" type="button">עצור</button></div>`;
  }).join('');
  $('#btnScan').disabled = !!jobs.mail; $('#btnRescan').disabled = !!jobs.mail; $('#btnMatch').disabled = !!jobs.match;
}
function setNote(where, kind, text){ UI.notes[where] = kind ? { kind, text } : null; renderNotes(); }
function renderNotes(){
  for (const [w, id] of [['bank','#bankNotes'],['mail','#mailNotes'],['doc','#docNotes']]){
    const n = UI.notes[w];
    $(id).innerHTML = n ? `<div class="note ${n.kind}">${esc(n.text)}</div>` : '';
  }
}
function renderBank(){
  $('#sources').innerHTML = S.sources.map(s => `<span class="src" title="${esc(s.fileName)}">${esc(s.label)} · <span class="num">${s.count}</span><button data-act="del-src" data-id="${s.id}" aria-label="הסר את ${esc(s.label)}" type="button">×</button></span>`).join('');
  const p = period();
  const q = $('#txSearch').value.trim().toLowerCase();
  let list = S.tx.filter(t => inPeriod(t.date, p));
  if (UI.txf === 'missing') list = list.filter(t => ['missing','no_invoice','check','pending'].includes(t._status));
  else if (UI.txf === 'complete') list = list.filter(t => ['complete','no_receipt'].includes(t._status));
  else if (UI.txf === 'not_needed') list = list.filter(t => ['not_needed', 'recurring', 'donation'].includes(t._status));
  if (q) list = list.filter(t => (t.desc + ' ' + t.merchant + ' ' + t.amount).toLowerCase().includes(q));
  list.sort((a, b) => b.date.localeCompare(a.date));
  $('#bankMeta').textContent = `${list.length} תנועות`;
  if (!list.length){ $('#txList').innerHTML = `<li class="empty">${S.tx.length ? 'אין תנועות בסינון או בתקופה הזו.' : 'עוד אין תנועות. העלה קובץ מהבנק או מחברת האשראי.'}</li>`; return; }
  const shown = list.slice(0, UI.txLimit);
  $('#txList').innerHTML = shown.map(t => {
    const src = srcOf(t);
    const docs = t._docs.map(d => DOC_TYPES[d.docType]).join(' + ');
    const sub = [t.merchant && t.merchant !== t.desc ? esc(t.desc) : '', src ? esc(src.label) : '', t.origAmount ? `<span class="num">${esc(fmtMoney(t.origAmount, t.origCurrency))}</span>` : '', docs ? `מסמך: ${esc(docs)}` : (reasonOf(t) && t._status !== 'missing' ? esc(reasonOf(t)) : '')].filter(Boolean).join(' · ');
    return `<li class="row st-${t._status}"><span class="d">${fmtDate(t.date)}</span><span class="n">${esc(t.merchant || t.desc)}</span><span class="a num ${t.dir === 'in' ? 'in' : ''}">${esc(money(t))}</span><span class="sub">${sub}</span><span class="x">${chip(t._status)}<button class="iconbtn" data-act="tx" data-id="${t.id}" aria-label="פעולות על התנועה" type="button">⋯</button></span></li>`;
  }).join('') + (list.length > shown.length ? `<li><button class="more" data-act="more" data-what="tx" type="button">הצג עוד ${Math.min(150, list.length - shown.length)} מתוך ${list.length - shown.length} שנותרו</button></li>` : '');
}
const MAIL_ST = { doc: ['נמצא מסמך','ok'], link: ['קישור בלבד','warn'], irrelevant: ['לא רלוונטי','muted'], error: ['שגיאה','bad'] };
function renderMail(){
  const p = period();
  let list = S.emails.filter(e => !e.date || inPeriod(e.date, { from: addDays(p.from, -45), to: addDays(p.to, 45) }));
  const all = list.length;
  if (UI.mf !== 'all') list = list.filter(e => e.status === UI.mf);
  list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const docsN = list.filter(e => e.status === 'doc').length;
  $('#mailMeta').textContent = all ? `${all} מיילים · ${docsN} עם מסמך` : '';
  if (!list.length){ $('#mailList').innerHTML = `<li class="empty">${all ? 'אין מיילים בסינון הזה.' : 'המייל עוד לא נסרק.'}</li>`; return; }
  const shown = list.slice(0, UI.mailLimit);
  $('#mailList').innerHTML = shown.map(e => {
    const [lbl, cls] = MAIL_ST[e.status] || ['', 'muted'];
    const sub = [esc(e.from), e.note ? esc(e.note) : '', e.viewUrl ? `<a href="${esc(e.viewUrl)}" target="_blank" rel="noopener">פתח ב-Gmail</a>` : ''].filter(Boolean).join(' · ');
    return `<li class="row"><span class="d">${fmtDate(e.date)}</span><span class="n">${esc(e.subject)}</span><span class="a"><span class="chip ${cls}">${lbl}</span></span><span class="sub" style="grid-column:2/4">${sub}</span></li>`;
  }).join('') + (list.length > shown.length ? `<li><button class="more" data-act="more" data-what="mail" type="button">הצג עוד</button></li>` : '');
}
function renderDocs(){
  const p = period();
  const wide = { from: addDays(p.from, -45), to: addDays(p.to, 45) };
  const q = $('#docSearch').value.trim().toLowerCase();
  const pend = S.docs.filter(d => d.review === 'pending').length;
  const pendLi = pend ? `<li><button class="pend-link" data-act="goto-review" type="button">${pend} מסמכים ממתינים לאישור שלך ←</button></li>` : '';
  let list = S.docs.filter(d => isApproved(d) && (!d.date || inPeriod(d.date, wide)));
  if (UI.df === 'matched') list = list.filter(d => d._tx.length);
  if (UI.df === 'orphan') list = list.filter(d => !d._tx.length);
  if (q) list = list.filter(d => [d.vendor, d.number, d.amount, ...(d.aliases || [])].join(' ').toLowerCase().includes(q));
  list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('#docsMeta').textContent = `${list.length} מסמכים`;
  if (!list.length){ $('#docList').innerHTML = pendLi + `<li class="empty">${S.docs.some(isApproved) ? 'אין מסמכים בסינון הזה.' : 'עוד אין מסמכים מאושרים.'}</li>`; return; }
  const shown = list.slice(0, UI.docLimit);
  $('#docList').innerHTML = pendLi + shown.map(d => {
    const matched = d._tx.length;
    const sub = [`<span class="chip type">${DOC_TYPES[d.docType]}</span>`, d.number ? `מס׳ ${esc(d.number)}` : '', d.dir === 'income' ? 'הכנסה (הוצאת אתה)' : '', d.exempt ? 'עוסק פטור' : '', d.linkOnly ? 'קישור בלבד' : '', d.origin === 'upload' ? 'הועלה ידנית' : (d.viewUrl ? `<a href="${esc(d.viewUrl)}" target="_blank" rel="noopener">מייל</a>` : 'מהמייל'), d.fileUrl ? `<a href="${esc(d.fileUrl)}" target="_blank" rel="noopener">הקובץ</a>` : ''].filter(Boolean).join(' · ');
    return `<li class="row ${matched ? 'st-complete' : ''}"><span class="d">${fmtDate(d.date)}</span><span class="n">${esc(d.vendor)}</span><span class="a num">${esc(fmtMoney(d.amount, d.currency))}</span><span class="sub">${sub}</span><span class="x">${matched ? '<span class="chip ok">מותאם</span>' : '<span class="chip muted">ללא תנועה</span>'}<button class="iconbtn" data-act="doc" data-id="${d.id}" aria-label="עריכת המסמך" type="button">⋯</button></span></li>`;
  }).join('') + (list.length > shown.length ? `<li><button class="more" data-act="more" data-what="doc" type="button">הצג עוד</button></li>` : '');
}
/* ============================== ממתינות לאישור ============================== */
// כל מסמך חדש (מהמייל או מהעלאה) מחכה כאן. רק אחרי אישור הוא נכנס להתאמה ולדוח.
const DEFAULT_CATS = ['דלק', 'רכב', 'תקשורת', 'תוכנה ומנויים', 'ציוד משרדי', 'שירותים מקצועיים', 'חשמל ומים', 'שכירות', 'כיבוד', 'פרסום', 'נסיעות', 'אחר'];
function categoryList(){
  const set = new Set(DEFAULT_CATS);
  for (const x of [...S.tx, ...S.docs]) if (x.category) set.add(x.category);
  return [...set];
}
function findDup(d){
  return S.docs.find(o => o !== d && isApproved(o) && o.amount != null && d.amount != null && Math.abs(o.amount - d.amount) < 0.02 && o.date === d.date && nameSim(o.vendor, d.vendor) > 0.5);
}
const driveLink = d => d.fileUrl ? ` · <a href="${esc(d.fileUrl)}" target="_blank" rel="noopener">פתח את הקובץ ב-Drive</a>` : '';
// כשמסמך נמחק או סומן "לא חשבונית", הקובץ שלו עובר לפח ב-Drive, אלא אם מסמך אחר שמור באותו קובץ
function trashIfOrphan(d){
  if (!d?.fileId || S.docs.some(o => o !== d && o.fileId === d.fileId && o.review !== 'rejected')) return;
  const id = d.fileId; delete d.fileId; delete d.fileUrl;
  api('/drive/trash', { method: 'POST', body: { fileId: id } }).catch(() => {});
}
function reviewCard(d){
  const dr = UI.rvDraft[d.id] || {};
  const val = f => esc(dr[f] ?? (d[f] ?? ''));
  const need = f => String(dr[f] ?? (d[f] ?? '')).trim() === '' ? ' need' : '';
  const sel = (f, opts) => opts.map(([k, l]) => `<option value="${esc(k)}" ${String(dr[f] ?? d[f]) === k ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const cur = String(dr.currency ?? d.currency ?? 'ILS');
  const curs = [...new Set(['ILS', 'USD', 'EUR', 'GBP', cur])].map(c => [c, c === 'ILS' ? '₪ שקל' : c]);
  const m = d.emailId ? S.emails.find(e => e.id === d.emailId) : null;
  const src = (d.origin === 'upload' ? `הועלה ידנית${d.fileName ? ` · ${esc(d.fileName)}` : ''}`
    : `מהמייל${m ? ` · ${esc(m.from)}` : ''}${d.viewUrl ? ` · <a href="${esc(d.viewUrl)}" target="_blank" rel="noopener">פתח את המייל</a>` : ''}`) + driveLink(d);
  const dup = findDup(d);
  const exempt = dr.exempt ?? d.exempt;
  return `<article class="rv" data-id="${d.id}">
    <div class="rv-h"><div class="rv-t"><b>${esc(d.vendor)}</b><span class="num">${esc(fmtMoney(d.amount, d.currency))}</span><span class="chip type">${DOC_TYPES[d.docType] || 'מסמך'}</span></div><div class="rv-src">${src}</div></div>
    ${dup ? `<div class="note info">ייתכן שזה כפול: כבר יש מסמך מאושר של ${esc(dup.vendor)} באותו סכום ובאותו תאריך.</div>` : ''}
    ${d.linkOnly ? `<div class="note info">המסמך עצמו נמצא בקישור בתוך המייל. כדאי לפתוח את המייל ולשמור אותו.</div>` : ''}
    <div class="rv-grid">
      <label class="field rv-wide"><span>ספק</span><input type="text" data-f="vendor" value="${val('vendor')}" class="${need('vendor')}"></label>
      <label class="field"><span>ח.פ / ע.מ</span><input type="text" data-f="taxId" inputmode="numeric" value="${val('taxId')}" class="ltr${need('taxId')}"></label>
      <label class="field"><span>סוג מסמך</span><select data-f="docType">${sel('docType', Object.entries(DOC_TYPES))}</select></label>
      <label class="field"><span>מספר מסמך</span><input type="text" data-f="number" value="${val('number')}" class="ltr${need('number')}"></label>
      <label class="field"><span>תאריך</span><input type="date" data-f="date" value="${val('date')}" class="${need('date')}"></label>
      <label class="field"><span>סכום כולל מע״מ</span><input type="number" step="0.01" data-f="amount" value="${val('amount')}" class="ltr${need('amount')}"></label>
      <label class="field"><span>מע״מ</span><input type="number" step="0.01" data-f="vat" value="${val('vat')}" class="ltr"></label>
      <label class="field"><span>מטבע</span><select data-f="currency">${sel('currency', curs)}</select></label>
      <label class="field"><span>מספר הקצאה</span><input type="text" data-f="allocNum" inputmode="numeric" value="${val('allocNum')}" class="ltr" placeholder="אם מופיע"></label>
      <label class="field"><span>סוג</span><select data-f="dir">${sel('dir', [['expense', 'הוצאה (קיבלתי)'], ['income', 'הכנסה (הוצאתי ללקוח)']])}</select></label>
      <label class="field"><span>קטגוריה</span><input type="text" data-f="category" list="catList" value="${val('category')}" placeholder="למשל: דלק"></label>
      <label class="field rv-wide"><span>תיאור</span><input type="text" data-f="desc" value="${val('desc')}"></label>
      <label class="chk"><input type="checkbox" data-f="exempt" ${exempt ? 'checked' : ''}> הספק עוסק פטור</label>
    </div>
    <div class="rv-f"><button class="btn primary" data-act="rv-approve" data-id="${d.id}" type="button">אשר</button><button class="btn ghost danger" data-act="rv-reject" data-id="${d.id}" type="button">זו לא חשבונית</button></div>
  </article>`;
}
function renderReview(){
  const list = S.docs.filter(d => d.review === 'pending').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const cnt = $('#reviewCnt'); cnt.textContent = list.length || ''; cnt.classList.toggle('hidden', !list.length);
  const el = $('#tab-review');
  if (!list.length){ el.innerHTML = `<div class="card"><div class="empty"><b>אין מסמכים שממתינים לאישור</b><br>חשבוניות וקבלות שיימצאו במייל או שתעלה יופיעו כאן לבדיקה, לפני שהן נכנסות להתאמה.</div></div>`; return; }
  el.innerHTML = `<div class="card"><div class="card-h"><h2>ממתינות לאישור</h2><span class="meta">${list.length} מסמכים. בדוק את מה שה-AI קרא, תקן אם צריך ואשר. רק מסמך מאושר נכנס להתאמה ולדוח.</span><div class="actions"><button class="btn" data-act="rv-approve-all" type="button">אשר הכל (${list.length})</button></div></div></div>`
    + `<datalist id="catList">${categoryList().map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>`
    + list.map(reviewCard).join('');
}
function readReview(card, d){
  const v = f => card.querySelector(`[data-f="${f}"]`);
  d.vendor = v('vendor').value.trim() || d.vendor;
  d.taxId = v('taxId').value.replace(/[^\d-]/g, '');
  d.docType = v('docType').value;
  d.number = v('number').value.trim();
  d.date = v('date').value || d.date;
  const a = parseFloat(v('amount').value); d.amount = isFinite(a) ? a : d.amount;
  const t = parseFloat(v('vat').value); d.vat = isFinite(t) ? t : null;
  d.currency = (v('currency').value || 'ILS').toUpperCase(); d.foreign = d.currency !== 'ILS' || !!d.foreign;
  d.allocNum = v('allocNum').value.replace(/\D/g, '');
  d.dir = v('dir').value;
  d.category = v('category').value.trim();
  d.desc = v('desc').value.trim();
  d.exempt = v('exempt').checked;
  delete UI.rvDraft[d.id];
}
function txTable(list, opts = {}){
  return `<div class="tbl-wrap"><table class="txt">${opts.head === false ? '' : '<thead><tr><th>תאריך</th><th>בית עסק</th><th>תיאור בבנק</th><th>חשבון</th><th style="text-align:end">סכום</th><th>מצב</th><th></th></tr></thead>'}<tbody>${list.map(t => {
    const src = srcOf(t);
    const info = t._docs.length ? t._docs.map(d => `${DOC_TYPES[d.docType]} ${d.number ? '#' + d.number : ''}`).join(' + ') : (t.needReason || '');
    return `<tr><td class="dt">${fmtDateLong(t.date)}</td><td>${esc(t.merchant || '—')}</td><td>${esc(t.desc)}${info ? `<div class="muted" style="font-size:12.5px">${esc(info)}</div>` : ''}</td><td>${esc(src?.label || '')}</td><td class="amt">${esc(money(t))}${t.origAmount ? `<div class="muted" style="font-size:12px">${esc(fmtMoney(t.origAmount, t.origCurrency))}</div>` : ''}</td><td>${chip(t._status)}</td><td style="white-space:nowrap"><button class="btn small" data-act="link" data-id="${t.id}" type="button">קשר מסמך</button> ${opts.noNeed !== false ? `<button class="btn small ghost" data-act="set-need" data-need="no" data-id="${t.id}" type="button">לא נדרש</button>` : ''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function groupByVendor(list){
  const g = new Map();
  for (const t of list){ const k = (t.merchant || t.desc).trim(); if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
  return [...g.entries()].map(([k, v]) => ({ name: k, list: v.sort((a, b) => a.date.localeCompare(b.date)), total: v.reduce((a, t) => a + t.amount, 0) })).sort((a, b) => b.total - a.total);
}
function renderReport(){
  const s = stats();
  const el = $('#tab-report');
  const sec = (id, title, meta, body, actions = '') => `<div class="card" id="${id}"><div class="card-h"><h2>${title}</h2><span class="meta">${meta}</span>${actions ? `<div class="actions">${actions}</div>` : ''}</div><div class="card-b">${body}</div></div>`;
  const missOut = s.missing.filter(t => t.dir === 'out'), missIn = s.missing.filter(t => t.dir === 'in');
  const missingGroups = groupByVendor(missOut);
  const missingBody = missingGroups.length ? missingGroups.map((g, i) => `<div class="vendor"><div class="vendor-h"><b>${esc(g.name)}</b><span class="meta">${nTx(g.list.length, 'תנועה אחת', 'תנועות')} · <span class="num">${esc(fmtMoney(g.total))}</span></span><div class="actions"><button class="btn small" data-act="copy-req" data-group="${i}" type="button">העתק בקשת חשבונית לספק</button></div></div>${txTable(g.list, { head: i === 0 })}</div>`).join('') : `<div class="empty">אין תשלומים שחסר להם מסמך בתקופה הזו.</div>`;
  UI.missingGroups = missingGroups;
  const orphansBody = s.orphans.length ? `<div class="tbl-wrap"><table><thead><tr><th>תאריך</th><th>ספק</th><th>סוג</th><th>מספר</th><th style="text-align:end">סכום</th><th>הערה</th><th></th></tr></thead><tbody>${s.orphans.sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(d => `<tr><td class="dt">${fmtDateLong(d.date)}</td><td>${esc(d.vendor)}</td><td>${DOC_TYPES[d.docType]}</td><td>${esc(d.number)}</td><td class="amt">${esc(fmtMoney(d.amount, d.currency))}</td><td class="muted">${esc(d.dir === 'income' ? 'מסמך שהוצאת ללקוח. בדוק שהכסף נכנס' : 'אולי שולם במזומן, בחשבון אחר או בכרטיס שלא הועלה')}</td><td><button class="btn small" data-act="doc" data-id="${d.id}" type="button">פרטים</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">כל המסמכים בתקופה הותאמו לתנועה.</div>`;
  const checkList = [...s.check, ...s.pending];
  const bar = `<div class="report-bar"><div class="grow"><b>הדוח של ${esc(periodLabel(s.p))}</b><div class="muted" style="font-size:12.5px">${periodLabel(s.p).includes('/') ? '' : `${fmtDateLong(s.p.from)} עד ${fmtDateLong(s.p.to)} · `}לשינוי התקופה, בחר תאריכים בפס העליון</div></div><div class="actions"><button class="btn primary" data-act="pdf" type="button"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>הורד PDF</button><button class="btn" data-act="export" type="button">ייצוא לאקסל</button></div></div>`;
  el.innerHTML = bar + [
    sec('r-missing', 'תשלומים בלי חשבונית או קבלה', `${missOut.length} תנועות · ${esc(fmtMoney(s.sum(missOut)))} · ${fmtDateLong(s.p.from)} עד ${fmtDateLong(s.p.to)}`, missingBody),
    missIn.length ? sec('r-income', 'הכנסות שלא נמצאה עליהן קבלה שהוצאת', `${missIn.length} תנועות · ${esc(fmtMoney(s.sum(missIn)))}. בדוק שהוצאת ללקוח חשבונית מס/קבלה`, txTable(missIn)) : '',
    sec('r-noinv', 'יש תשלום ואישור, אבל אין חשבונית מס', `${s.noInv.length} תנועות. נמצא רק אישור תשלום, חשבון עסקה או מסמך אחר. בקש מהספק חשבונית מס`, s.noInv.length ? txTable(s.noInv) : '<div class="empty">אין.</div>'),
    sec('r-check', 'לבדיקה שלך', `${checkList.length} תנועות ש-Claude לא בטוח לגביהן: העברות לאנשים פרטיים, צ׳קים, קניות שאולי פרטיות`, checkList.length ? `<div class="tbl-wrap"><table><thead><tr><th>תאריך</th><th>בית עסק</th><th>תיאור בבנק</th><th>חשבון</th><th style="text-align:end">סכום</th><th>למה</th><th></th></tr></thead><tbody>${checkList.map(t => `<tr><td class="dt">${fmtDateLong(t.date)}</td><td>${esc(t.merchant || '—')}</td><td>${esc(t.desc)}</td><td>${esc(srcOf(t)?.label || '')}</td><td class="amt">${esc(money(t))}</td><td class="muted">${esc(t.needReason || 'טרם סווג')}</td><td style="white-space:nowrap"><button class="btn small" data-act="set-need" data-need="yes" data-id="${t.id}" type="button">צריך מסמך</button> <button class="btn small ghost" data-act="set-need" data-need="no" data-id="${t.id}" type="button">לא נדרש</button> <button class="btn small ghost" data-act="link" data-id="${t.id}" type="button">קשר</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">אין תנועות לבדיקה.</div>'),
    sec('r-orphans', 'מסמכים שלא נמצא להם חיוב', `${s.orphans.length} מסמכים בתקופה`, orphansBody),
    sec('r-norec', 'יש חשבונית מס, אין קבלה', `${s.noRec.length} תנועות. בדרך כלל מספיק כשהתשלום בכרטיס אשראי, אבל כדאי לדעת`, s.noRec.length ? txTable(s.noRec) : '<div class="empty">אין.</div>'),
    sec('r-complete', 'מותאם ומלא', `${s.complete.length} תנועות עם מסמכים מלאים · ${s.notNeeded.length} תנועות שלא דורשות מסמך${s.recurring.length ? ` · ${s.recurring.length} הוראות קבע (בלשונית "הוראות קבע")` : ''}${s.donations.length ? ` · ${s.donations.length} תרומות (בלשונית "תרומות")` : ''}`, `<details style="padding:10px 18px"><summary class="muted" style="cursor:pointer">הצג את התנועות המותאמות</summary>${txTable(s.complete, { noNeed: false })}</details><details style="padding:10px 18px;border-top:1px solid var(--line)"><summary class="muted" style="cursor:pointer">הצג תנועות שלא דורשות מסמך ולמה</summary><div class="tbl-wrap"><table><tbody>${s.notNeeded.map(t => `<tr><td class="dt">${fmtDateLong(t.date)}</td><td>${esc(t.merchant || t.desc)}</td><td class="amt">${esc(money(t))}</td><td class="muted">${esc(reasonOf(t))}</td><td><button class="btn small ghost" data-act="set-need" data-need="yes" data-id="${t.id}" type="button">דווקא צריך מסמך</button></td></tr>`).join('')}</tbody></table></div></details>`)
  ].join('');
}
/* ============================== הכנסות והוצאות ============================== */
// הכנסות: כל הזיכויים לחשבון הבנק. הוצאות: כל החיובים בבנק ובאשראי.
// חיוב מרוכז של כרטיס אשראי בבנק לא נספר כשדפי האשראי הועלו, כי כל קנייה בכרטיס כבר נספרה משם.
const kindOf = t => srcOf(t)?.kind === 'credit' ? 'credit' : 'bank';
const CARD_BILL = /ישראכרט|isracard|לאומי ?קארד|leumi ?card|אמריקן ?אקספרס|american ?express|\bamex\b|דיינרס|diners|ויזה ?כאל|כאל[\s-]|^כאל$|\bcal\b|מקס ?איט|max ?it|חיוב ?כרטיס|כרטיס ?אשראי/i;
const isCardBill = t => kindOf(t) === 'bank' && t.dir === 'out' && (CARD_BILL.test(`${t.desc} ${t.merchant || ''}`) || /כרטיס[\s-]?ה?אשראי/.test(t.needReason || ''));
const sumAmt = list => list.reduce((a, t) => a + t.amount, 0);
function flows(){
  const p = period();
  const tx = S.tx.filter(t => inPeriod(t.date, p));
  const credit = tx.filter(t => kindOf(t) === 'credit');
  const cardBills = tx.filter(isCardBill);
  const skip = new Set(credit.length ? cardBills : []);
  return {
    p, hasCredit: credit.length > 0, cardBills,
    income: tx.filter(t => t.dir === 'in' && kindOf(t) === 'bank'),
    refunds: credit.filter(t => t.dir === 'in'),
    expense: tx.filter(t => t.dir === 'out' && !skip.has(t))
  };
}
function groupSum(list, keyFn){
  const g = new Map();
  for (const t of list){ const k = keyFn(t) || 'ללא שם'; const r = g.get(k) || { name: k, sum: 0, n: 0 }; r.sum += t.amount; r.n++; g.set(k, r); }
  return [...g.values()].sort((a, b) => b.sum - a.sum);
}
function rankBars(rows, total, limit = 8){
  if (!rows.length) return '<div class="empty">אין נתונים.</div>';
  const top = rows.slice(0, limit), rest = rows.slice(limit);
  if (rest.length) top.push({ name: `אחרים (${rest.length})`, sum: rest.reduce((a, r) => a + r.sum, 0), n: rest.reduce((a, r) => a + r.n, 0) });
  const max = Math.max(...top.map(r => r.sum), 0.01);
  return `<ul class="bars">${top.map(r => `<li title="${esc(r.name)}: ${esc(fmtMoney(r.sum))} · ${r.n === 1 ? 'תנועה אחת' : r.n + ' תנועות'}"><span class="bn">${esc(r.name)}</span><span class="bt"><i style="width:${Math.max(1.5, 100 * r.sum / max).toFixed(1)}%"></i></span><span class="bv num">${esc(fmtMoney(r.sum))}</span><span class="bp num">${total ? Math.round(100 * r.sum / total) : 0}%</span></li>`).join('')}</ul>`;
}
const nTx = (n, one, many) => n === 1 ? one : `${n} ${many}`;
const ftile = (cls, k, list, sub) => `<div class="tile static ${cls}${list.length ? '' : ' zero'}"><div class="k">${k}</div><div class="v num">${esc(fmtMoney(sumAmt(list)))}</div><div class="s">${esc(sub ?? nTx(list.length, 'תנועה אחת', 'תנועות'))}</div></div>`;
function flowList(title, list){
  const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date));
  const shown = sorted.slice(0, UI.flowLimit);
  return `<div class="card"><div class="card-h"><h2>${title}</h2><span class="meta">${nTx(list.length, 'תנועה אחת', 'תנועות')}</span></div><div class="card-b">${list.length ? txTable(shown) + (sorted.length > shown.length ? `<button class="more" data-act="more" data-what="flow" type="button">הצג עוד ${Math.min(200, sorted.length - shown.length)} מתוך ${sorted.length - shown.length} שנותרו</button>` : '') : '<div class="empty">אין תנועות בתקופה הזו.</div>'}</div></div>`;
}
function hero(cls, label, list, p, unit){
  return `<div class="hero ${cls}"><div class="hero-k">${label} · ${esc(periodLabel(p))}</div><div class="hero-v num">${esc(fmtMoney(sumAmt(list)))}</div><div class="hero-s">${nTx(list.length, unit[0], unit[1])}${periodLabel(p).includes('/') ? '' : ` · ${fmtDateLong(p.from)} עד ${fmtDateLong(p.to)}`}</div></div>`;
}
function renderFlows(){
  const f = flows();
  const noData = !S.tx.length ? `<div class="note info" style="margin:0">עוד אין תנועות. העלה קובץ מהבנק ומחברות האשראי בלוח העבודה.</div>` : '';
  // הכנסות
  const inc = f.income, incTotal = sumAmt(inc);
  const withRec = inc.filter(t => ['complete', 'no_receipt', 'no_invoice'].includes(t._status));
  const noRec = inc.filter(t => t._status === 'missing');
  const chk = inc.filter(t => t._status === 'check' || t._status === 'pending');
  const noNeed = inc.filter(t => t._status === 'not_needed');
  $('#tab-income').innerHTML = [
    hero('in', 'הכנסות לחשבון הבנק', inc, f.p, ['זיכוי אחד לחשבון', 'זיכויים והעברות לחשבון']),
    noData,
    `<div class="ftiles">${ftile('ok', 'עם קבלה שהוצאת', withRec)}${ftile('bad', 'בלי קבלה', noRec, noRec.length ? 'כדאי להוציא קבלה ללקוח' : 'אין')}${ftile('check', 'לבדיקה שלך', chk)}${ftile('', 'לא דורש קבלה', noNeed, 'העברות בין חשבונות, החזרים וכדומה')}</div>`,
    f.refunds.length ? `<div class="note info" style="margin:0">זיכויים בכרטיסי האשראי (${nTx(f.refunds.length, 'זיכוי אחד', 'זיכויים')}, ${esc(fmtMoney(sumAmt(f.refunds)))}) לא נכללים בהכנסות.</div>` : '',
    inc.length ? `<div class="card"><div class="card-h"><h2>לפי משלם</h2><span class="meta">מי העביר הכי הרבה</span></div><div class="card-b">${rankBars(groupSum(inc, t => t.merchant || t.desc), incTotal)}</div></div>` : '',
    flowList('כל ההכנסות', inc)
  ].join('');
  // הוצאות
  const exp = f.expense, expTotal = sumAmt(exp);
  const fromBank = exp.filter(t => kindOf(t) === 'bank'), fromCard = exp.filter(t => kindOf(t) === 'credit');
  const label = list => { const ids = [...new Set(list.map(t => t.sourceId))]; return ids.length === 1 ? (S.sources.find(s => s.id === ids[0])?.label || '') : ids.length ? `${ids.length} חשבונות` : 'אין'; };
  const withDoc = exp.filter(t => ['complete', 'no_receipt'].includes(t._status));
  const missDoc = exp.filter(t => t._status === 'missing');
  let billNote = '';
  if (f.cardBills.length){
    const list = `<details class="adv" style="margin-top:6px"><summary>הצג את החיובים</summary><div class="inner">${f.cardBills.map(t => `<div>${fmtDateLong(t.date)} · ${esc(t.desc)} · <span class="num">${esc(fmtMoney(t.amount))}</span></div>`).join('')}</div></details>`;
    billNote = f.hasCredit
      ? `<div class="note info" style="margin:0">${f.cardBills.length === 1 ? 'לא נספר חיוב מרוכז אחד' : `לא נספרו ${f.cardBills.length} חיובים מרוכזים`} של כרטיס אשראי מחשבון הבנק (${esc(fmtMoney(sumAmt(f.cardBills)))}), כי כל קנייה בכרטיס כבר נספרה מדף האשראי. אם לא העלית את הדף של אחד הכרטיסים, הקניות שלו חסרות כאן.${list}</div>`
      : `<div class="note info" style="margin:0">חיובי כרטיס האשראי מהבנק (${esc(fmtMoney(sumAmt(f.cardBills)))}) נספרו כאן כסכום אחד. כדי לראות על מה הוצא הכסף, העלה בלוח העבודה את דפי הפירוט של האשראי.${list}</div>`;
  }
  $('#tab-expense').innerHTML = [
    hero('out', 'הוצאות מהבנק ומהאשראי', exp, f.p, ['חיוב אחד', 'חיובים']),
    noData,
    `<div class="ftiles">${ftile('', 'מחשבון הבנק', fromBank, `${nTx(fromBank.length, 'חיוב אחד', 'חיובים')} · ${label(fromBank)}`)}${ftile('', 'מכרטיסי האשראי', fromCard, `${nTx(fromCard.length, 'חיוב אחד', 'חיובים')} · ${label(fromCard)}`)}${ftile('ok', 'עם חשבונית או קבלה', withDoc)}${ftile('bad', 'חסר מסמך', missDoc, missDoc.length ? `${nTx(missDoc.length, 'תנועה אחת', 'תנועות')}. הפירוט בדוח החוסרים` : 'אין')}</div>`,
    billNote,
    exp.length ? (() => {
      const byVendor = `<div class="card"><div class="card-h"><h2>לפי בית עסק</h2></div><div class="card-b">${rankBars(groupSum(exp, t => t.merchant || t.desc), expTotal)}</div></div>`;
      // לפני שה-AI סיווג את התנועות אין קטגוריות, ואז מציגים רק את הפילוח לפי בית עסק
      if (!exp.some(t => t.category)) return byVendor;
      return `<div class="flow-grid"><div class="card"><div class="card-h"><h2>לפי קטגוריה</h2></div><div class="card-b">${rankBars(groupSum(exp, t => t.category || 'ללא קטגוריה'), expTotal)}</div></div>${byVendor}</div>`;
    })() : '',
    flowList('כל ההוצאות', exp)
  ].join('');
}

/* לשונית הוראות קבע: כל התשלומים הקבועים, מקובצים לפי ספק. הם לא נכללים בדוח החוסרים */
function renderRecurring(){
  const p = period();
  const all = S.tx.filter(t => t._rec);
  const inP = all.filter(t => inPeriod(t.date, p));
  const groups = new Map();
  for (const t of all){ const k = recKey(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const rows = [...groups.entries()].map(([k, list]) => {
    list.sort((a, b) => b.date.localeCompare(a.date));
    const months = new Set(list.map(t => t.date.slice(0, 7)));
    const inList = list.filter(t => inPeriod(t.date, p));
    const names = groupSum(list, t => t.merchant || t.desc);
    return { k, name: names[0].name, list, inList, last: list[0], monthly: sumAmt(list) / Math.max(1, months.size), months: months.size, inSum: sumAmt(inList), cat: list.find(t => t.category)?.category || '', src: srcOf(list[0])?.label || '' };
  }).filter(r => r.inList.length).sort((a, b) => b.inSum - a.inSum);
  const monthlyTotal = rows.reduce((a, r) => a + r.monthly, 0);
  const rules = S.settings.recurringRules || {};
  const removed = Object.keys(rules).filter(k => rules[k] === 'no');
  const nameOf = k => { const t = S.tx.find(x => recKey(x) === k); return t ? (t.merchant || t.desc) : k; };
  const list = rows.length ? `<div class="tbl-wrap"><table class="rec-t"><thead><tr><th>ספק</th><th>קטגוריה</th><th>חשבון</th><th>חיוב אחרון</th><th style="text-align:end">בממוצע לחודש</th><th style="text-align:end">בתקופה</th><th></th></tr></thead><tbody>${rows.map(r => `<tr>
      <td><b>${esc(r.name)}</b><div class="muted" style="font-size:12.5px">${r.months === 1 ? 'חודש אחד' : r.months + ' חודשים'} · ${r.inList.length === 1 ? 'חיוב אחד בתקופה' : r.inList.length + ' חיובים בתקופה'}</div></td>
      <td>${esc(r.cat || '—')}</td><td class="muted">${esc(r.src)}</td><td class="dt">${fmtDateLong(r.last.date)}</td>
      <td class="amt">${esc(fmtMoney(r.monthly))}</td><td class="amt"><b>${esc(fmtMoney(r.inSum))}</b></td>
      <td style="white-space:nowrap"><button class="btn small ghost" data-act="rec-no" data-k="${esc(r.k)}" type="button">לא קבוע</button></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${S.tx.length ? 'לא נמצאו תשלומים קבועים בתקופה הזו.' : 'עוד אין תנועות. העלה קובץ מהבנק ומחברות האשראי בלוח העבודה.'}</div>`;
  $('#tab-recurring').innerHTML = [
    `<div class="hero"><div class="hero-k">הוראות קבע ותשלומים קבועים · ${esc(periodLabel(p))}</div><div class="hero-v num">${esc(fmtMoney(sumAmt(inP)))}</div><div class="hero-s">${rows.length === 1 ? 'ספק אחד' : rows.length + ' ספקים'} · ${inP.length === 1 ? 'חיוב אחד' : inP.length + ' חיובים'}</div></div>`,
    `<div class="ftiles rec-tiles"><div class="tile static"><div class="k">בממוצע לחודש</div><div class="v num">${esc(fmtMoney(monthlyTotal))}</div><div class="s">כמה יוצא כל חודש על התשלומים הקבועים</div></div><div class="tile static"><div class="k">בשנה, בקצב הזה</div><div class="v num">${esc(fmtMoney(monthlyTotal * 12))}</div><div class="s">הערכה לפי הממוצע החודשי</div></div></div>`,
    `<div class="note info" style="margin:0">התשלומים האלה <b>לא נכללים בדוח החוסרים</b>. תשלום שזוהה בטעות: לחץ "לא קבוע". כדי להוסיף תשלום, לחץ עליו בלוח העבודה ובחר "סמן כהוראת קבע".</div>`,
    `<div class="card"><div class="card-h"><h2>לפי ספק</h2><span class="meta">מהגבוה לנמוך, בתקופה שנבחרה</span></div><div class="card-b">${list}</div></div>`,
    removed.length ? `<div class="card"><div class="card-h"><h2>סימנת כלא קבועים</h2><span class="meta">הם חוזרים לדוח החוסרים כרגיל</span></div><div class="card-b" style="padding:10px 18px;display:flex;flex-wrap:wrap;gap:8px">${removed.map(k => `<span class="src">${esc(nameOf(k))}<button data-act="rec-reset" data-k="${esc(k)}" aria-label="החזר את ${esc(nameOf(k))} לתשלומים הקבועים" title="החזר לתשלומים הקבועים" type="button">↺</button></span>`).join('')}</div></div>` : ''
  ].join('');
}

/* לשונית תרומות (סעיף 46). הנתונים נכונים ל-2026: זיכוי 35% ליחיד ו-23% לחברה, מעל 207 ₪ בשנה */
const DON46 = { year: 2026, min: 207, person: 0.35, company: 0.23 };
function renderDonations(){
  const p = period();
  const all = S.tx.filter(t => t._don);
  const inP = all.filter(t => inPeriod(t.date, p)).sort((a, b) => b.date.localeCompare(a.date));
  const year = p.to.slice(0, 4);
  const yearList = all.filter(t => t.date.startsWith(year));
  const yearSum = sumAmt(yearList);
  const withRec = inP.filter(t => t._docs.length), noRec = inP.filter(t => !t._docs.length);
  const credit = yearSum > DON46.min ? yearSum * DON46.person : 0;
  const groups = new Map();
  for (const t of inP){ const k = recKey(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const rows = [...groups.entries()].map(([k, list]) => ({ k, name: groupSum(list, t => t.merchant || t.desc)[0].name, list, sum: sumAmt(list), rec: list.filter(t => t._docs.length).length })).sort((a, b) => b.sum - a.sum);
  const rules = S.settings.donationRules || {};
  const removed = Object.keys(rules).filter(k => rules[k] === 'no');
  const nameOf = k => { const t = S.tx.find(x => recKey(x) === k); return t ? (t.merchant || t.desc) : k; };
  const table = rows.length ? `<div class="tbl-wrap"><table class="rec-t don-t"><thead><tr><th>מוסד</th><th>תרומות</th><th>קבלות</th><th>חשבון</th><th style="text-align:end">סכום בתקופה</th><th></th></tr></thead><tbody>${rows.map(r => `<tr>
      <td><b>${esc(r.name)}</b><div class="muted" style="font-size:12.5px">${r.list.length === 1 ? 'תרומה אחת' : r.list.length + ' תרומות'} · אחרונה ב-${fmtDateLong(r.list[0].date)}</div></td>
      <td>${r.list.length}</td><td>${r.rec === r.list.length ? '<span class="chip ok">יש קבלה</span>' : r.rec ? `<span class="chip warn">${r.rec} מתוך ${r.list.length}</span>` : '<span class="chip warn">אין קבלה</span>'}</td>
      <td class="muted">${esc(srcOf(r.list[0])?.label || '')}</td><td class="amt"><b>${esc(fmtMoney(r.sum))}</b></td>
      <td style="white-space:nowrap"><button class="btn small ghost" data-act="don-no" data-k="${esc(r.k)}" type="button">לא תרומה</button></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${S.tx.length ? 'לא נמצאו תרומות בתקופה הזו. כדי לסמן תשלום כתרומה, לחץ עליו בלוח העבודה ובחר "סמן כתרומה".' : 'עוד אין תנועות. העלה קובץ מהבנק ומחברות האשראי בלוח העבודה.'}</div>`;
  $('#tab-donations').innerHTML = [
    `<div class="hero don"><div class="hero-k">תרומות · ${esc(periodLabel(p))}</div><div class="hero-v num">${esc(fmtMoney(sumAmt(inP)))}</div><div class="hero-s">${inP.length === 1 ? 'תרומה אחת' : inP.length + ' תרומות'}${rows.length ? ` · ${rows.length === 1 ? 'מוסד אחד' : rows.length + ' מוסדות'}` : ''}</div></div>`,
    `<div class="ftiles don-tiles">
      <div class="tile static"><div class="k">סך התרומות בשנת ${year}</div><div class="v num">${esc(fmtMoney(yearSum))}</div><div class="s">${yearList.length === 1 ? 'תרומה אחת' : yearList.length + ' תרומות'} מתחילת השנה</div></div>
      <div class="tile static ok${credit ? '' : ' zero'}"><div class="k">זיכוי מס משוער</div><div class="v num">${esc(fmtMoney(credit))}</div><div class="s">${yearSum > DON46.min ? `35% ליחיד. לחברה 23%: ${esc(fmtMoney(yearSum * DON46.company))}` : `הזיכוי מתחיל מעל ${DON46.min} ₪ בשנה`}</div></div>
      <div class="tile static${noRec.length ? ' bad' : ''}"><div class="k">בלי קבלה</div><div class="v num">${noRec.length}</div><div class="s">${noRec.length ? esc(fmtMoney(sumAmt(noRec))) + ' בתקופה. כדאי לבקש קבלה מהמוסד' : 'לכל התרומות בתקופה יש קבלה'}</div></div>
    </div>`,
    `<div class="note info" style="margin:0">התרומות <b>לא נכללות בדוח החוסרים</b>. הזיכוי לפי סעיף 46 ניתן רק על תרומה למוסד עם אישור לפי סעיף 46, כשסך התרומות בשנה עולה על ${DON46.min} ₪ (נכון ל-${DON46.year}). מ-${DON46.year} המוסדות מדווחים את התרומות למערכת המקוונת של רשות המסים, וכדאי לבדוק באזור האישי שכל תרומה מופיעה שם. החישוב כאן הוא הערכה בלבד. את הסכום הסופי קובע רואה החשבון.</div>`,
    `<div class="card"><div class="card-h"><h2>לפי מוסד</h2><span class="meta">בתקופה שנבחרה</span></div><div class="card-b">${table}</div></div>`,
    inP.length ? `<div class="card"><div class="card-h"><h2>כל התרומות</h2><span class="meta">כדי לחבר קבלה, לחץ "קשר מסמך"</span></div><div class="card-b">${txTable(inP, { noNeed: false })}</div></div>` : '',
    removed.length ? `<div class="card"><div class="card-h"><h2>סימנת כלא תרומות</h2><span class="meta">הם חוזרים לדוח החוסרים כרגיל</span></div><div class="card-b" style="padding:10px 18px;display:flex;flex-wrap:wrap;gap:8px">${removed.map(k => `<span class="src">${esc(nameOf(k))}<button data-act="don-reset" data-k="${esc(k)}" aria-label="החזר את ${esc(nameOf(k))} לתרומות" title="החזר לתרומות" type="button">↺</button></span>`).join('')}</div></div>` : ''
  ].join('');
}

/* ============================== מע"מ ============================== */
// נכון ל-2026: מע"מ 18% (מ-1.1.2025, לפני כן 17%).
// קיזוז מע"מ תשומות רק מחשבונית מס של ספק ישראלי, ומעל סף מסוים רק עם מספר הקצאה מרשות המסים.
const vatRate = date => (date || '') >= '2025-01-01' ? 0.18 : 0.17;
const ALLOC = [['2026-06-01', 5000], ['2026-01-01', 10000], ['2025-01-01', 20000], ['2024-01-01', 25000]];
const allocLimit = date => (ALLOC.find(([d]) => (date || '') >= d) || [null, Infinity])[1];
const VAT_DOCS = new Set(['tax_invoice', 'tax_invoice_receipt', 'credit_note']);
function vatOf(d){
  const amt = Number(d.amount) || 0, v = Number(d.vat);
  if (d.vat != null && d.vat !== '' && isFinite(v) && v >= 0 && v < amt) return v;
  const r = vatRate(d.date); return +(amt * r / (1 + r)).toFixed(2);
}
function vatReport(p = period()){
  const docs = S.docs.filter(d => isApproved(d) && inPeriod(d.date, p)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const out = [], inp = [], review = [], skipped = [];
  for (const d of docs){
    const sg = d.docType === 'credit_note' ? -1 : 1, total = Number(d.amount) || 0;
    const foreign = d.foreign || (d.currency && d.currency !== 'ILS');
    const vat = foreign || d.exempt ? 0 : vatOf(d);
    const row = { d, vat: sg * vat, net: sg * (total - vat), total: sg * total };
    if (d.dir === 'income'){
      // רק חשבונית מס יוצרת מע"מ עסקאות. קבלה על חשבונית שכבר הוצאה לא נספרת שוב
      if (VAT_DOCS.has(d.docType) && !d.exempt && !foreign) out.push(row);
      continue;
    }
    if (foreign){ skipped.push({ ...row, why: 'ספק מחו״ל, אין מע״מ ישראלי' }); continue; }
    if (d.exempt){ skipped.push({ ...row, why: 'עוסק פטור, אין מע״מ' }); continue; }
    if (!VAT_DOCS.has(d.docType)){ skipped.push({ ...row, why: `${DOC_TYPES[d.docType] || 'מסמך'}: צריך חשבונית מס כדי לקזז` }); continue; }
    if (sg > 0 && row.net > allocLimit(d.date) && !d.allocNum){ review.push({ ...row, why: `מעל ${fmtMoney(allocLimit(d.date))} לפני מע״מ, וחסר מספר הקצאה` }); continue; }
    inp.push(row);
  }
  const s = list => +list.reduce((a, r) => a + r.vat, 0).toFixed(2);
  const sn = list => +list.reduce((a, r) => a + r.net, 0).toFixed(2);
  const outVat = s(out), inVat = s(inp);
  return { p, out, inp, review, skipped, outVat, inVat, outNet: sn(out), inNet: sn(inp), reviewVat: s(review), net: +(outVat - inVat).toFixed(2), pending: S.docs.filter(d => d.review === 'pending' && inPeriod(d.date, p)).length };
}
function vatPresets(){
  const t = todayISO(), cur = t.slice(0, 7), prev = prevYm(cur);
  const m = +prev.slice(5, 7), biStart = `${prev.slice(0, 4)}-${pad(m % 2 ? m : m - 1)}`;
  return { month: { from: prev + '-01', to: monthEnd(prev) }, bi: { from: biStart + '-01', to: monthEnd(nextYm(biStart)) } };
}
function vatTable(rows, kind){
  if (!rows.length) return '<div class="empty">אין מסמכים.</div>';
  const who = r => kind === 'out' ? (r.d.customer || r.d.desc || r.d.vendor) : r.d.vendor;
  const head = `<thead><tr><th>תאריך</th><th>${kind === 'out' ? 'לקוח' : 'ספק'}</th><th>${kind === 'skip' || kind === 'review' ? 'למה' : kind === 'out' ? 'סוג' : 'ח.פ'}</th><th>מספר</th><th style="text-align:end">לפני מע״מ</th><th style="text-align:end">מע״מ</th><th style="text-align:end">סה״כ</th><th></th></tr></thead>`;
  return `<div class="tbl-wrap"><table class="vt">${head}<tbody>${rows.map(r => `<tr${r.total < 0 ? ' class="neg"' : ''}>
    <td class="dt">${fmtDateLong(r.d.date)}</td>
    <td>${esc(who(r) || '—')}${r.d.docType === 'credit_note' ? ' <span class="chip muted">זיכוי</span>' : ''}</td>
    <td class="${kind === 'skip' || kind === 'review' ? 'why' : 'muted'}">${esc(kind === 'skip' || kind === 'review' ? r.why : kind === 'out' ? DOC_TYPES[r.d.docType] : (r.d.taxId || '—'))}</td>
    <td class="muted">${esc(r.d.number || '')}${r.d.allocNum ? `<div class="sub">הקצאה ${esc(r.d.allocNum)}</div>` : ''}</td>
    <td class="amt">${esc(fmtMoney(r.net))}</td><td class="amt vv">${esc(fmtMoney(r.vat))}</td><td class="amt">${esc(fmtMoney(r.total))}</td>
    <td><button class="btn small ghost" data-act="doc" data-id="${r.d.id}" type="button">${kind === 'review' ? 'הוסף מספר הקצאה' : 'פרטים'}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderVat(){
  const r = vatReport(), pre = vatPresets();
  const pay = r.net >= 0;
  const isP = x => r.p.from === x.from && r.p.to === x.to;
  $('#tab-vat').innerHTML = [
    `<div class="report-bar"><div class="grow"><b>מע״מ של ${esc(periodLabel(r.p))}</b><div class="muted" style="font-size:12.5px">לפי תאריך המסמך. לשינוי התקופה, בחר תאריכים בפס העליון או:</div></div><div class="actions">
      <button class="btn small${isP(pre.month) ? ' primary' : ''}" data-act="vat-period" data-kind="month" type="button">${esc(periodLabel(pre.month))}</button>
      <button class="btn small${isP(pre.bi) ? ' primary' : ''}" data-act="vat-period" data-kind="bi" type="button">${esc(periodLabel(pre.bi))}</button>
      <button class="btn small" data-act="pdf" type="button">הורד PDF</button><button class="btn small" data-act="vat-export" type="button">ייצוא לאקסל</button></div></div>`,
    `<div class="hero ${pay ? 'out' : 'in'}"><div class="hero-k">${pay ? 'מע״מ לתשלום' : 'מע״מ להחזר'} · ${esc(periodLabel(r.p))}</div><div class="hero-v num">${esc(fmtMoney(Math.abs(r.net)))}</div><div class="hero-s">מע״מ עסקאות ${esc(fmtMoney(r.outVat))} פחות מע״מ תשומות ${esc(fmtMoney(r.inVat))}</div></div>`,
    `<div class="ftiles">
      <div class="tile static"><div class="k">מע״מ עסקאות (הכנסות)</div><div class="v num">${esc(fmtMoney(r.outVat))}</div><div class="s">על הכנסות של ${esc(fmtMoney(r.outNet))} לפני מע״מ · ${r.out.length === 1 ? 'מסמך אחד' : r.out.length + ' מסמכים'}</div></div>
      <div class="tile static ok"><div class="k">מע״מ תשומות לקיזוז</div><div class="v num">${esc(fmtMoney(r.inVat))}</div><div class="s">על הוצאות של ${esc(fmtMoney(r.inNet))} לפני מע״מ · ${r.inp.length === 1 ? 'חשבונית אחת' : r.inp.length + ' חשבוניות'}</div></div>
      <div class="tile static${r.review.length ? ' bad' : ' zero'}"><div class="k">חסר מספר הקצאה</div><div class="v num">${esc(fmtMoney(r.reviewVat))}</div><div class="s">${r.review.length ? `${r.review.length === 1 ? 'חשבונית אחת שלא נכנסה' : r.review.length + ' חשבוניות שלא נכנסו'} לקיזוז` : 'אין'}</div></div>
      <div class="tile static zero"><div class="k">לא נכלל בקיזוז</div><div class="v num">${r.skipped.length}</div><div class="s">קבלות, אישורי תשלום, ספקים מחו״ל ועוסקים פטורים</div></div>
    </div>`,
    `<div class="note info" style="margin:0">מע״מ ${Math.round(vatRate(r.p.to) * 100)}%. החישוב לפי מסמכים שאישרת${r.pending ? `, ו-${r.pending === 1 ? 'מסמך אחד שממתין' : r.pending + ' מסמכים שממתינים'} לאישור לא נכלל${r.pending === 1 ? '' : 'ו'}` : ''}. הוא לא מתחשב בהגבלות על קיזוז מע״מ ברכב, בכיבוד ובטלפון, ולא בהוצאות מעורבות. זו הערכה לפני הדיווח, ואת הדוח עצמו מגיש רואה החשבון.</div>`,
    `<div class="card"><div class="card-h"><h2>עסקאות: חשבוניות שהוצאת</h2><span class="meta">${esc(fmtMoney(r.outVat))} מע״מ</span></div><div class="card-b">${vatTable(r.out, 'out')}</div></div>`,
    `<div class="card"><div class="card-h"><h2>תשומות: חשבוניות מס מספקים</h2><span class="meta">${esc(fmtMoney(r.inVat))} מע״מ לקיזוז</span></div><div class="card-b">${vatTable(r.inp, 'in')}</div></div>`,
    r.review.length ? `<div class="card"><div class="card-h"><h2>חשבוניות שחסר בהן מספר הקצאה</h2><span class="meta">בלי מספר הקצאה אי אפשר לקזז את המע״מ. אם המספר מופיע בחשבונית, הוסף אותו והיא תיכנס לחישוב</span></div><div class="card-b">${vatTable(r.review, 'review')}</div></div>` : '',
    r.skipped.length ? `<div class="card"><details><summary class="card-h" style="cursor:pointer"><h2>לא נכלל בקיזוז</h2><span class="meta">${r.skipped.length === 1 ? 'מסמך אחד' : r.skipped.length + ' מסמכים'}. לחץ להצגה</span></summary><div class="card-b">${vatTable(r.skipped, 'skip')}</div></details></div>` : ''
  ].join('');
}
function vatExport(){
  if (!window.XLSX){ toast(errText({ code: 'no_xlsx' })); return; }
  const r = vatReport();
  const rows = (list, kind) => list.map(x => [fmtDateLong(x.d.date), kind === 'out' ? (x.d.customer || x.d.desc || x.d.vendor) : x.d.vendor, x.d.taxId || '', DOC_TYPES[x.d.docType] || '', x.d.number || '', x.d.allocNum || '', +x.net.toFixed(2), +x.vat.toFixed(2), +x.total.toFixed(2), x.why || '']);
  const head = ['תאריך', 'שם', 'ח.פ', 'סוג מסמך', 'מספר', 'מספר הקצאה', 'לפני מע״מ', 'מע״מ', 'סה״כ', 'הערה'];
  const wb = XLSX.utils.book_new();
  const add = (name, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = w.map(x => ({ wch: x })); XLSX.utils.book_append_sheet(wb, ws, name); };
  const W = [11, 26, 12, 16, 10, 12, 12, 10, 12, 34];
  add('סיכום', [['Ka-Ching · חישוב מע״מ'], [`תקופה: ${periodLabel(r.p)} (${fmtDateLong(r.p.from)} עד ${fmtDateLong(r.p.to)})`], [],
    ['', 'לפני מע״מ', 'מע״מ'], ['עסקאות', r.outNet, r.outVat], ['תשומות לקיזוז', r.inNet, r.inVat], [r.net >= 0 ? 'מע״מ לתשלום' : 'מע״מ להחזר', '', Math.abs(r.net)], [],
    ['חסר מספר הקצאה (לא קוזז)', '', r.reviewVat], [], ['הערכה בלבד. לא כולל הגבלות קיזוז ברכב, כיבוד וטלפון.']], [28, 14, 14]);
  add('עסקאות', [head, ...rows(r.out, 'out')], W);
  add('תשומות', [head, ...rows(r.inp, 'in')], W);
  if (r.review.length) add('חסר מספר הקצאה', [head, ...rows(r.review, 'in')], W);
  if (r.skipped.length) add('לא נכלל', [head, ...rows(r.skipped, 'in')], W);
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.writeFile(wb, `מעמ-${r.p.from}-עד-${r.p.to}.xlsx`);
}
function vatPrintHtml(){
  const r = vatReport(), biz = (S.settings.bizNames.split(',')[0] || '').trim();
  const t = (list, kind) => list.length ? `<table><thead><tr><th>תאריך</th><th>${kind === 'out' ? 'לקוח' : 'ספק'}</th><th>${kind === 'out' ? 'סוג' : 'ח.פ'}</th><th>מספר</th><th class="amt">לפני מע״מ</th><th class="amt">מע״מ</th><th class="amt">סה״כ</th></tr></thead><tbody>${list.map(x => `<tr><td class="dt">${fmtDateLong(x.d.date)}</td><td>${esc(kind === 'out' ? (x.d.customer || x.d.desc || x.d.vendor) : x.d.vendor)}${x.why ? `<div class="sub">${esc(x.why)}</div>` : ''}</td><td class="sub">${esc(kind === 'out' ? DOC_TYPES[x.d.docType] : (x.d.taxId || ''))}</td><td>${esc(x.d.number || '')}</td><td class="amt">${esc(fmtMoney(x.net))}</td><td class="amt"><b>${esc(fmtMoney(x.vat))}</b></td><td class="amt">${esc(fmtMoney(x.total))}</td></tr>`).join('')}</tbody></table>` : '<div class="none">אין.</div>';
  return `<header class="p-head"><div><div class="p-brand">Ka-Ching</div><div class="p-title">חישוב מע״מ · ${esc(periodLabel(r.p))}</div>${biz ? `<div class="p-biz">${esc(biz)}</div>` : ''}</div><div class="p-meta">תקופה: ${fmtDateLong(r.p.from)} עד ${fmtDateLong(r.p.to)}<br>הופק: ${fmtDateLong(todayISO())}</div></header>
    <section class="p-sec p-summary"><h2 style="border-color:#1d3b66">סיכום</h2><table class="sumt"><thead><tr><th></th><th class="amt">לפני מע״מ</th><th class="amt">מע״מ</th></tr></thead><tbody>
      <tr><td>עסקאות</td><td class="amt">${esc(fmtMoney(r.outNet))}</td><td class="amt">${esc(fmtMoney(r.outVat))}</td></tr>
      <tr><td>תשומות לקיזוז</td><td class="amt">${esc(fmtMoney(r.inNet))}</td><td class="amt">${esc(fmtMoney(r.inVat))}</td></tr>
      <tr class="tot"><td>${r.net >= 0 ? 'מע״מ לתשלום' : 'מע״מ להחזר'}</td><td></td><td class="amt">${esc(fmtMoney(Math.abs(r.net)))}</td></tr></tbody></table>
      <div class="meta">מע״מ ${Math.round(vatRate(r.p.to) * 100)}%, לפי מסמכים שאושרו. הערכה בלבד: לא כולל הגבלות קיזוז ברכב, כיבוד וטלפון.${r.review.length ? ` ${r.review.length} חשבוניות בלי מספר הקצאה (${esc(fmtMoney(r.reviewVat))} מע״מ) לא קוזזו.` : ''}</div></section>
    <section class="p-sec"><h2 style="border-color:#067647">עסקאות <span class="cnt">${r.out.length}</span></h2>${t(r.out, 'out')}</section>
    <section class="p-sec"><h2 style="border-color:#1d3b66">תשומות לקיזוז <span class="cnt">${r.inp.length}</span></h2>${t(r.inp, 'in')}</section>
    ${r.review.length ? `<section class="p-sec"><h2 style="border-color:#b42318">חסר מספר הקצאה <span class="cnt">${r.review.length}</span></h2>${t(r.review, 'in')}</section>` : ''}
    ${r.skipped.length ? `<section class="p-sec"><h2 style="border-color:#98a2b3">לא נכלל בקיזוז <span class="cnt">${r.skipped.length}</span></h2>${t(r.skipped, 'in')}</section>` : ''}
    <footer class="p-foot">הופק ב-Ka-Ching.</footer>`;
}

/* מצב החיבורים: נקודה ליד עיגול המשתמש. הפירוט המלא בחלון ההגדרות, ובתחתית הדף מופיעות רק תקלות */
function capsItems(){
  if (!CAP.me) return [];
  return [
    { on: true, label: `מחובר כ-${CAP.me.email}` },
    S.demo ? { on: null, label: 'נתוני דוגמה, לא נשמרים' } : { on: CAP.saveOk !== false, label: 'הנתונים נשמרים בשרת שלך', off: 'השמירה האחרונה נכשלה' },
    { on: CAP.gmail === 'ok', label: 'Gmail מחובר (קריאה בלבד)', off: 'Gmail לא מחובר. "הגדרות" ← "התחבר מחדש ל-Google"' },
    { on: CAP.ai, label: `Claude זמין · מצב ${S.settings.aiMode === 'precise' ? 'מדויק' : 'מהיר'}`, off: 'קריאת חשבוניות עם AI לא זמינה' },
    { on: !!window.XLSX, label: 'קורא האקסל נטען', off: 'קורא האקסל לא נטען. רענן את הדף' },
    ...(S.settings.monthlyReport === true && CAP.report ? [{ on: CAP.report.canSend, label: 'דוח חוסרים במייל פעיל, ב-10 לכל חודש', off: 'דוח החוסרים במייל עוד לא אושר ב-Google. "הגדרות" ← "שמור"' }] : []),
    ...(S.settings.driveSave === true && CAP.drive ? [{ on: CAP.drive.canWrite, label: 'חשבוניות נשמרות ב-Google Drive', off: 'השמירה ב-Drive עוד לא אושרה ב-Google. "הגדרות" ← "שמור"' }] : [])
  ];
}
const capLine = c => `<span><span class="dot ${c.on === null ? '' : c.on ? 'on' : 'off'}"></span>${esc(c.on === false ? c.off : c.label)}</span>`;
function renderCaps(){
  const letter = $('#accLetter'), dot = $('#accDot'), btn = $('#btnAccount');
  if (!CAP.ready){ $('#caps').innerHTML = ''; dot.className = 'adot'; return; }
  if (!CAP.me){ $('#caps').innerHTML = ''; letter.textContent = '?'; dot.className = 'adot off'; btn.setAttribute('aria-label', 'לא מחובר'); return; }
  const items = capsItems();
  const bad = items.filter(c => c.on === false);
  letter.textContent = (CAP.me.email || '?').charAt(0).toUpperCase();
  dot.className = 'adot ' + (bad.length ? 'off' : 'on');
  btn.setAttribute('aria-label', `החשבון שלי: ${CAP.me.email}${bad.length ? ' · יש תקלה' : ''}`);
  btn.title = bad.length ? bad.map(c => c.off).join(' · ') : CAP.me.email;
  $('#caps').innerHTML = bad.map(capLine).join('');
}

/* ============================== חלונות ============================== */
function modal(title, body, foot){
  $('#modalRoot').innerHTML = `<div class="overlay" data-act="close-overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-h"><h3>${esc(title)}</h3><button class="iconbtn" data-act="close" aria-label="סגור" type="button">×</button></div><div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ''}</div></div>`;
  setTimeout(() => { const f = $('#modalRoot .modal-b input, #modalRoot .modal-b select, #modalRoot .modal-f .btn'); f && f.focus(); }, 30);
}
function closeModal(){ $('#modalRoot').innerHTML = ''; }
function openTx(id){
  const t = S.tx.find(x => x.id === id); if (!t) return;
  const src = srcOf(t);
  const docs = t._docs.map(d => { const l = S.links.find(x => x.t === t.id && x.d === d.id); return `<div class="cand"><b>${esc(d.vendor)}</b><span class="num">${esc(fmtMoney(d.amount, d.currency))}</span><button class="btn small danger" data-act="unlink" data-t="${t.id}" data-d="${d.id}" type="button">נתק</button><span class="sub">${DOC_TYPES[d.docType]} ${d.number ? '#' + esc(d.number) : ''} · ${fmtDateLong(d.date)} · ${esc(l?.by === 'manual' ? 'קושר ידנית' : l?.reason || '')}</span></div>`; }).join('');
  modal(t.merchant || t.desc, `
    <div class="grid2"><div><div class="muted" style="font-size:12.5px">תאריך</div><div class="num">${fmtDateLong(t.date)}${t.chargeDate ? ` · חיוב ${fmtDateLong(t.chargeDate)}` : ''}</div></div><div><div class="muted" style="font-size:12.5px">סכום</div><div class="num">${esc(money(t))}${t.origAmount ? ` (${esc(fmtMoney(t.origAmount, t.origCurrency))})` : ''}</div></div>
    <div><div class="muted" style="font-size:12.5px">תיאור בבנק</div><div>${esc(t.desc)}</div></div><div><div class="muted" style="font-size:12.5px">חשבון</div><div>${esc(src?.label || '')}</div></div></div>
    <div>${chip(t._status)} <span class="muted">${esc(reasonOf(t))}</span></div>
    <div><div class="muted" style="font-size:12.5px;margin-bottom:6px">מסמכים מקושרים</div>${docs || '<div class="muted">אין</div>'}</div>`,
    `<button class="btn primary" data-act="link" data-id="${t.id}" type="button">קשר מסמך</button>
     <button class="btn" data-act="set-need" data-need="no" data-id="${t.id}" type="button">לא דורש מסמך</button>
     <button class="btn" data-act="set-need" data-need="yes" data-id="${t.id}" type="button">דורש מסמך</button>
     ${S.overrides[t.id] ? `<button class="btn ghost" data-act="set-need" data-need="" data-id="${t.id}" type="button">חזור לסיווג של Claude</button>` : ''}
     ${t.dir === 'out' && !isCardBill(t) && !t._don ? `<button class="btn ghost" data-act="${t._rec ? 'rec-no' : 'rec-yes'}" data-id="${t.id}" type="button">${t._rec ? 'זו לא הוראת קבע' : 'סמן כהוראת קבע'}</button>` : ''}
     ${t.dir === 'out' && !isCardBill(t) ? `<button class="btn ghost" data-act="${t._don ? 'don-no' : 'don-yes'}" data-id="${t.id}" type="button">${t._don ? 'זו לא תרומה' : 'סמן כתרומה'}</button>` : ''}`);
}
function openLink(id, q = ''){
  const t = S.tx.find(x => x.id === id); if (!t) return;
  const linked = new Set(t._docs.map(d => d.id));
  let cands = S.docs.filter(d => isApproved(d) && !linked.has(d.id)).map(d => ({ d, s: (docSide(d) === t.dir ? 0.2 : 0) + 0.45 * Math.max(amountScore(t, d), d.amount ? Math.max(0, 1 - Math.abs(d.amount - t.amount) / Math.max(1, t.amount)) * 0.5 : 0) + 0.15 * dateScore(t, d) + 0.2 * nameScore(t, d) }));
  if (q) cands = cands.filter(c => [c.d.vendor, c.d.number, c.d.amount, ...(c.d.aliases || [])].join(' ').toLowerCase().includes(q.toLowerCase()));
  cands.sort((a, b) => b.s - a.s);
  const body = `<div class="muted">${esc(t.merchant || t.desc)} · <span class="num">${esc(money(t))}</span> · ${fmtDateLong(t.date)}</div>
    <input type="search" id="linkSearch" placeholder="חיפוש ספק, מספר או סכום" value="${esc(q)}" data-tx="${t.id}" aria-label="חיפוש מסמך">
    ${cands.slice(0, 25).map(c => `<div class="cand"><b>${esc(c.d.vendor)}</b><span class="num">${esc(fmtMoney(c.d.amount, c.d.currency))}</span><button class="btn small primary" data-act="do-link" data-t="${t.id}" data-d="${c.d.id}" type="button">קשר</button><span class="sub">${DOC_TYPES[c.d.docType]} ${c.d.number ? '#' + esc(c.d.number) : ''} · ${fmtDateLong(c.d.date)}${c.d._tx.length ? ' · כבר מקושר לתנועה אחרת' : ''}</span></div>`).join('') || '<div class="muted">לא נמצאו מסמכים. אפשר להעלות את החשבונית בעמודת המסמכים.</div>'}`;
  modal('קישור מסמך לתנועה', body);
}
function openDoc(id){
  const d = S.docs.find(x => x.id === id); if (!d) return;
  const opt = cur => Object.entries(DOC_TYPES).map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('');
  const txs = d._tx.map(t => `<div class="cand"><b>${esc(t.merchant || t.desc)}</b><span class="num">${esc(money(t))}</span><button class="btn small danger" data-act="unlink" data-t="${t.id}" data-d="${d.id}" type="button">נתק</button><span class="sub">${fmtDateLong(t.date)} · ${esc(srcOf(t)?.label || '')}</span></div>`).join('');
  modal('פרטי מסמך', `
    <div class="grid2">
      <div class="field"><label for="dv">ספק</label><input type="text" id="dv" value="${esc(d.vendor)}"></div>
      <div class="field"><label for="dt">סוג מסמך</label><select id="dt">${opt(d.docType)}</select></div>
      <div class="field"><label for="dd">תאריך</label><input type="date" id="dd" value="${esc(d.date || '')}"></div>
      <div class="field"><label for="da">סכום כולל מע״מ</label><input type="number" step="0.01" id="da" value="${d.amount ?? ''}" style="direction:ltr"></div>
      <div class="field"><label for="dc">מטבע</label><input type="text" id="dc" value="${esc(d.currency)}" style="direction:ltr"></div>
      <div class="field"><label for="dn">מספר מסמך</label><input type="text" id="dn" value="${esc(d.number)}"></div>
      <div class="field"><label for="dtx">ח.פ / ע.מ</label><input type="text" id="dtx" inputmode="numeric" value="${esc(d.taxId || '')}" style="direction:ltr"></div>
      <div class="field"><label for="dvat">מע״מ</label><input type="number" step="0.01" id="dvat" value="${d.vat ?? ''}" style="direction:ltr"></div>
      <div class="field"><label for="dal">מספר הקצאה</label><input type="text" id="dal" inputmode="numeric" value="${esc(d.allocNum || '')}" style="direction:ltr" placeholder="מופיע בחשבונית מס"></div>
      <div class="field"><label for="dcat">קטגוריה</label><input type="text" id="dcat" list="catList2" value="${esc(d.category || '')}"><datalist id="catList2">${categoryList().map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist></div>
      <div class="field"><label for="dr">כיוון</label><select id="dr"><option value="expense" ${d.dir === 'expense' ? 'selected' : ''}>הוצאה (קיבלתי)</option><option value="income" ${d.dir === 'income' ? 'selected' : ''}>הכנסה (הוצאתי ללקוח)</option></select></div>
      <div class="field"><label for="de">&nbsp;</label><label style="flex-direction:row;align-items:center;gap:6px;font-size:14px;color:var(--ink)"><input type="checkbox" id="de" ${d.exempt ? 'checked' : ''}> הספק עוסק פטור</label></div>
    </div>
    ${d.desc ? `<div class="muted">${esc(d.desc)}</div>` : ''}
    <div class="muted" style="font-size:12.5px">${d.origin === 'upload' ? 'הועלה ידנית: ' + esc(d.fileName || '') : 'מהמייל'}${d.viewUrl ? ` · <a href="${esc(d.viewUrl)}" target="_blank" rel="noopener">פתח את המייל</a>` : ''}${driveLink(d)}</div>
    <div><div class="muted" style="font-size:12.5px;margin-bottom:6px">תנועות מקושרות</div>${txs || '<div class="muted">אין</div>'}</div>`,
    `<button class="btn primary" data-act="save-doc" data-id="${d.id}" type="button">שמור</button><button class="btn danger" data-act="del-doc" data-id="${d.id}" type="button">מחק מסמך</button>`);
}
function openSettings(){
  const s = S.settings;
  modal('הגדרות', `
    ${CAP.me ? `<div class="status-list">${capsItems().map(capLine).join('')}</div>
    <div class="actions"><a class="btn small" href="/auth/login?consent=1&hint=${encodeURIComponent(CAP.me.email)}">התחבר מחדש ל-Google</a><button class="btn small" data-act="logout" type="button">התנתק</button></div>` : ''}
    ${CAP.me ? reportSettingsHtml() + driveSettingsHtml() : ''}
    <div class="field"><label for="setBiz">שמות העסק והבעלים, מופרדים בפסיק. כך Claude מזהה חשבוניות שאתה הוצאת ללקוחות.</label><input type="text" id="setBiz" value="${esc(s.bizNames)}" placeholder="לדוגמה: שטיינברג שמאות מקרקעין, שלום שטיינברג"></div>
    <div class="field"><label for="setMode">מצב AI</label><select id="setMode"><option value="fast" ${s.aiMode !== 'precise' ? 'selected' : ''}>מהיר וזול: מתאים לרוב החשבוניות</option><option value="precise" ${s.aiMode === 'precise' ? 'selected' : ''}>מדויק: מודל חזק יותר. איטי ויקר יותר</option></select></div>
    <div class="field"><label for="setMax">מספר שרשורי מייל מקסימלי בכל סריקה</label><input type="number" id="setMax" min="10" max="2000" value="${s.maxThreads}" style="direction:ltr;max-width:140px"></div>
    <div class="note info" style="margin:0">החיבור לבנק נעשה דרך קובץ שאתה מוריד מאתר הבנק. האתר לא מבקש ולא שומר סיסמאות לבנק.</div>
    <div style="border-top:1px solid var(--line);padding-top:12px"><button class="btn danger" data-act="wipe" type="button">מחק את כל הנתונים</button> <span class="muted" style="font-size:12.5px">תנועות, מיילים שנסרקו, מסמכים והתאמות</span></div>`,
    `<button class="btn primary" data-act="save-settings" type="button">שמור</button><button class="btn" data-act="close" type="button">ביטול</button>`);
}
/* דוח החוסרים במייל: החלק בחלון ההגדרות */
function nextReport(){
  const r = CAP.report; if (!r) return null;
  const today = r.today, day = +today.slice(8, 10), thisM = today.slice(0, 7);
  let ym = day <= r.sendDay && r.lastSent?.month !== prevYm(thisM) ? prevYm(thisM) : thisM;
  if (S.settings.monthlyReportSince && S.settings.monthlyReportSince > ym) ym = S.settings.monthlyReportSince;
  const sendM = nextYm(ym);
  return { ym, date: `${pad(r.sendDay)}/${sendM.slice(5, 7)}/${sendM.slice(0, 4)}` };
}
function cronScript(){
  return `// Ka-Ching: מעיר את האתר פעם ביום, כדי שדוח החוסרים יישלח ב-10 לחודש גם כשהאתר סגור.
const KA_CHING_URL = '${CAP.report.cronUrl}';

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('ping').timeBased().everyDays(1).atHour(8).inTimezone('Asia/Jerusalem').create();
  ping();
}

function ping() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = UrlFetchApp.fetch(KA_CHING_URL, { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) { Logger.log(r.getContentText()); return; }
    } catch (e) { Logger.log(e); }
    Utilities.sleep(40000);
  }
}
`;
}
function reportSettingsHtml(){
  const r = CAP.report; if (!r) return '';
  const on = S.settings.monthlyReport === true;
  const prev = prevYm(r.today.slice(0, 7));
  const nx = nextReport();
  let status;
  if (!r.canSend) status = on ? 'עוד לא אישרת ל-Google לשלוח את הדוח. לחץ "שמור", ותועבר למסך אישור קצר של Google.' : 'בלחיצה על "שמור" תועבר פעם אחת למסך של Google, כדי לאשר שהאתר ישלח לך את הדוח. האתר שולח רק את הדוח הזה, ורק אליך.';
  else if (on) status = `הדוח הבא, על ${monthName(nx.ym)}, יישלח ב-${nx.date} אל ${esc(CAP.me.email)}.${r.lastSent ? ` נשלח לאחרונה: הדוח על ${monthName(r.lastSent.month)}.` : ''}`;
  else status = 'הדוח החודשי כבוי.';
  const err = on && r.lastError ? `<div class="note err" style="margin:0">השליחה של הדוח על ${monthName(r.lastError.month)} נכשלה. ${esc(errText({ code: r.lastError.error }))} אנסה שוב אוטומטית.</div>` : '';
  return `<div class="rep-box">
    <label class="chk"><input type="checkbox" id="setReport" ${on ? 'checked' : ''}> שלח לי דוח חוסרים במייל ב-10 לכל חודש, על החודש הקודם</label>
    <div class="muted" style="font-size:13px">${status}</div>${err}
    ${r.canSend ? `<div class="actions"><button class="btn small" data-act="report-send-now" data-month="${prev}" type="button">שלח לי עכשיו את הדוח על ${monthName(prev)}</button></div>` : ''}
    ${r.canSend && on ? `<details class="adv"><summary>שליחה גם כשהאתר סגור (הגדרה חד-פעמית, 2 דקות)</summary><div class="inner">
      <div class="muted" style="font-size:12.5px">האתר נרדם כשלא משתמשים בו. בלי ההגדרה הזו, הדוח יישלח רק כשתיכנס לאתר אחרי ה-10. כך מגדירים שהאתר יתעורר לבד כל בוקר:</div>
      <ol class="steps"><li>פתח את <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a> עם אותו חשבון Google. ייפתח פרויקט חדש.</li><li>מחק את מה שכתוב שם, והדבק את הקוד שלמטה.</li><li>שמור (Ctrl+S). בשורה העליונה בחר <b>setup</b>, לחץ "הפעלה" ואשר את ההרשאות.</li></ol>
      <textarea class="code" rows="6" readonly id="cronCode">${esc(cronScript())}</textarea>
      <div class="actions"><button class="btn small" data-act="copy-cron" type="button">העתק את הקוד</button><span class="muted" style="font-size:12px">הקוד כולל קישור אישי. אל תשתף אותו.</span></div>
    </div></details>` : ''}
  </div>`;
}
/* שמירת החשבוניות ב-Google Drive: החלק בחלון ההגדרות */
const driveCandidates = () => S.docs.filter(d => d.origin === 'gmail' && d.emailId && d.fileName && !d.fileId && !d.linkOnly && d.review !== 'rejected');
function driveSettingsHtml(){
  const dv = CAP.drive; if (!dv) return '';
  const on = S.settings.driveSave === true;
  let status;
  if (!dv.canWrite) status = 'בלחיצה על "שמור" תועבר פעם אחת למסך של Google, כדי לאשר שהאתר ישמור קבצים ב-Drive שלך. האתר רואה רק את הקבצים שהוא עצמו שמר, ולא שום קובץ אחר שלך.';
  else if (on) status = `כל חשבונית חדשה, מהמייל, מהעלאה או מצילום, נשמרת בתיקייה Ka-Ching, בתיקייה של החודש שלה.${dv.folderUrl ? ` <a href="${esc(dv.folderUrl)}" target="_blank" rel="noopener">פתח את התיקייה</a>` : ''}`;
  else status = 'השמירה ב-Drive כבויה.';
  const cand = driveCandidates().length;
  return `<div class="rep-box">
    <label class="chk"><input type="checkbox" id="setDrive" ${on ? 'checked' : ''}> שמור עותק של כל חשבונית וקבלה ב-Google Drive</label>
    <div class="muted" style="font-size:13px">${status}</div>
    ${dv.canWrite && on && cand && !S.demo ? `<div class="actions"><button class="btn small" data-act="drive-backfill" type="button">העתק ל-Drive את ${cand === 1 ? 'החשבונית' : cand + ' החשבוניות'} שכבר נמצאו במייל</button></div>` : ''}
    ${on ? '<div class="muted" style="font-size:12px">קבצים שהעלית או צילמת לפני שהשמירה הופעלה לא נשמרו, ואי אפשר לשחזר אותם מכאן.</div>' : ''}
  </div>`;
}
async function driveBackfill(){
  if (jobs.drive) return;
  const list = driveCandidates(); if (!list.length) return;
  const ctl = new AbortController();
  jobs.drive = { label: 'מעתיק חשבוניות ל-Google Drive', done: 0, total: list.length, ctl }; renderJobs();
  let ok = 0, failed = 0, fatal = null;
  for (let i = 0; i < list.length && !ctl.signal.aborted; i += 6){
    const batch = list.slice(i, i + 6);
    try {
      const r = await api('/drive/backfill', { method: 'POST', signal: ctl.signal, body: { items: batch.map(d => ({ key: d.id, emailId: d.emailId, fileName: d.fileName, doc: { date: d.date, vendor: d.vendor, amount: d.amount, dir: d.dir } })) } });
      for (const x of r.results || []){ const d = S.docs.find(o => o.id === x.key); if (x.id && d){ d.fileId = x.id; d.fileUrl = x.url; ok++; } else failed++; }
    } catch (e){
      if (isFatal(e) || e.code === 'no_drive_scope' || e.code === 'drive_api_disabled'){ fatal = e; break; }
      failed += batch.length;
    }
    jobs.drive.done = Math.min(list.length, i + batch.length); renderJobs(); markDirty('docs');
  }
  delete jobs.drive; markDirty('docs'); renderAll();
  if (fatal?.code === 'cancelled') toast(`ההעתקה הופסקה. ${ok} חשבוניות הועתקו.`);
  else toast(fatal ? errText(fatal) : `${ok} חשבוניות הועתקו ל-Google Drive${failed ? `. ${failed} לא הצליחו, למשל כי הקובץ כבר לא נמצא במייל` : ''}.`, 7000);
}
function syncInputs(){ const p = period(); $('#pFrom').value = p.from; $('#pTo').value = p.to; $('#gq').value = S.settings.gmailQuery || DEFAULT_QUERY; }
const TABS = ['board','income','expense','vat','recurring','donations','review','report','ask'];
function switchTab(tab){
  UI.tab = tab;
  document.body.dataset.tab = tab;
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of TABS) $('#tab-' + t).classList.toggle('hidden', t !== tab);
  if (matchMedia('(max-width:700px)').matches) $('#tabbtn-' + tab)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  if (location.hash !== '#' + tab) history.replaceState(null, '', location.pathname + '#' + tab);
}

/* ============================== PDF ============================== */
// "הורד PDF" פותח את חלון ההדפסה של הדפדפן עם דוח נקי, ושם בוחרים "שמירה כ-PDF".
// גם Ctrl+P רגיל מדפיס את אותו דוח נקי ולא את המסך.
function periodLabel(p){
  const ym = p.from.slice(0, 7), ym2 = p.to.slice(0, 7);
  if (p.from === ym + '-01' && p.to === monthEnd(ym)) return monthName(ym);
  if (p.from === ym + '-01' && p.to === monthEnd(ym2) && ym.slice(0, 4) === ym2.slice(0, 4)) return `${HE_MONTHS[+ym.slice(5, 7) - 1]}–${HE_MONTHS[+ym2.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
  return `${fmtDateLong(p.from)} עד ${fmtDateLong(p.to)}`;
}
function printHtml(){
  const s = stats();
  const biz = (S.settings.bizNames.split(',')[0] || '').trim();
  const missOut = s.missing.filter(t => t.dir === 'out'), missIn = s.missing.filter(t => t.dir === 'in');
  const checkList = [...s.check, ...s.pending];
  const docsOf = t => t._docs.map(d => `${DOC_TYPES[d.docType]}${d.number ? ' #' + d.number : ''}`).join(' + ');
  const amt = t => `<td class="amt">${esc(money(t))}${t.origAmount ? `<div class="sub">${esc(fmtMoney(t.origAmount, t.origCurrency))}</div>` : ''}</td>`;
  const COLS = {
    base: { h: ['תאריך', 'בית עסק', 'תיאור בבנק', 'חשבון', 'סכום'], r: t => `<td class="dt">${fmtDateLong(t.date)}</td><td>${esc(t.merchant || '—')}</td><td>${esc(t.desc)}</td><td class="sub">${esc(srcOf(t)?.label || '')}</td>${amt(t)}` },
    docs: { h: ['תאריך', 'בית עסק', 'תיאור בבנק', 'מסמכים', 'סכום'], r: t => `<td class="dt">${fmtDateLong(t.date)}</td><td>${esc(t.merchant || '—')}</td><td>${esc(t.desc)}</td><td>${esc(docsOf(t))}</td>${amt(t)}` },
    reason: { h: ['תאריך', 'בית עסק', 'תיאור בבנק', 'למה', 'סכום'], r: t => `<td class="dt">${fmtDateLong(t.date)}</td><td>${esc(t.merchant || '—')}</td><td>${esc(t.desc)}</td><td class="sub">${esc(reasonOf(t) || 'טרם סווג')}</td>${amt(t)}` }
  };
  const table = (list, kind) => `<table><thead><tr>${COLS[kind].h.map((h, i) => `<th${i === 4 ? ' class="amt"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${list.map(t => `<tr>${COLS[kind].r(t)}</tr>`).join('')}</tbody></table>`;
  const sec = (title, meta, list, kind, color, emptyText = 'אין.') => `<section class="p-sec"><h2 style="border-color:${color}">${title} <span class="cnt">${list.length}</span></h2>${meta && list.length ? `<div class="meta">${meta}</div>` : ''}${list.length ? table(list, kind) : `<div class="none">${emptyText}</div>`}</section>`;
  const groups = groupByVendor(missOut);
  const missTable = groups.length ? `<table><thead><tr><th>תאריך</th><th>בית עסק</th><th>תיאור בבנק</th><th>חשבון</th><th class="amt">סכום</th></tr></thead>${groups.map(g => `<tbody class="grp"><tr class="vrow"><td colspan="4"><b>${esc(g.name)}</b> · ${g.list.length === 1 ? 'תנועה אחת' : g.list.length + ' תנועות'}</td><td class="amt"><b>${esc(fmtMoney(g.total))}</b></td></tr>${g.list.map(t => `<tr>${COLS.base.r(t)}</tr>`).join('')}</tbody>`).join('')}</table>` : '<div class="none">אין. לכל התשלומים שדורשים מסמך נמצא מסמך.</div>';
  const pct = s.need.length ? Math.round(100 * s.covered.length / s.need.length) : null;
  const sumRow = (label, list, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${list.length}</td><td class="amt">${esc(fmtMoney(s.sum(list)))}</td></tr>`;
  const orphanSum = s.orphans.reduce((a, d) => a + (d.currency === 'ILS' || !d.currency ? (d.amount || 0) : 0), 0);
  const accounts = [...new Set(s.tx.map(t => srcOf(t)?.label).filter(Boolean))];
  const pending = S.docs.filter(d => d.review === 'pending').length;
  const orphansSec = `<section class="p-sec"><h2 style="border-color:#5d6b7e">מסמכים שלא נמצא להם חיוב <span class="cnt">${s.orphans.length}</span></h2>${s.orphans.length ? `<div class="meta">אולי שולמו במזומן, בחשבון אחר או בכרטיס שלא הועלה. מסמך שהוצאת ללקוח: בדוק שהכסף נכנס</div><table><thead><tr><th>תאריך</th><th>ספק</th><th>סוג</th><th>מספר</th><th class="amt">סכום</th></tr></thead><tbody>${[...s.orphans].sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(d => `<tr><td class="dt">${fmtDateLong(d.date)}</td><td>${esc(d.vendor)}${d.dir === 'income' ? '<div class="sub">הוצאת ללקוח</div>' : ''}</td><td>${DOC_TYPES[d.docType]}</td><td>${esc(d.number)}</td><td class="amt">${esc(fmtMoney(d.amount, d.currency))}</td></tr>`).join('')}</tbody></table>` : '<div class="none">כל המסמכים בתקופה הותאמו לתנועה.</div>'}</section>`;
  return `<header class="p-head"><div><div class="p-brand">Ka-Ching</div><div class="p-title">דוח התאמת בנק וחשבוניות · ${esc(periodLabel(s.p))}</div>${biz ? `<div class="p-biz">${esc(biz)}</div>` : ''}</div><div class="p-meta">תקופה: ${fmtDateLong(s.p.from)} עד ${fmtDateLong(s.p.to)}<br>הופק: ${fmtDateLong(todayISO())}${S.demo ? '<br><b>נתוני דוגמה</b>' : ''}</div></header>
    <section class="p-sec p-summary"><h2 style="border-color:#1d3b66">סיכום</h2>
      <table class="sumt"><thead><tr><th>קטגוריה</th><th class="num">תנועות</th><th class="amt">סכום</th></tr></thead><tbody>
        ${sumRow('חסר מסמך (חשבונית או קבלה)', s.missing, 'bad')}${sumRow('חסרה חשבונית מס', s.noInv, 'warn')}${sumRow('לבדיקה', checkList)}${sumRow('יש חשבונית, אין קבלה', s.noRec)}${sumRow('מותאם ומלא', s.complete, 'ok')}${sumRow('לא נדרש מסמך', s.notNeeded)}${s.recurring.length ? sumRow('הוראות קבע (לא נכללות בדוח)', s.recurring) : ''}${s.donations.length ? sumRow('תרומות (לא נכללות בדוח)', s.donations) : ''}
        <tr><td>מסמכים שלא נמצא להם חיוב</td><td class="num">${s.orphans.length}</td><td class="amt">${esc(fmtMoney(orphanSum))}</td></tr>
        <tr class="tot"><td>סך הכל תנועות בתקופה</td><td class="num">${s.tx.length}</td><td class="amt"></td></tr>
      </tbody></table>
      <div class="meta">${pct == null ? '' : `כיסוי: ${pct}% מהתנועות שדורשות מסמך (${s.covered.length} מתוך ${s.need.length}). `}${accounts.length ? `חשבונות בדוח: ${esc(accounts.join(', '))}.` : 'לא הועלו תנועות לתקופה הזו.'}${pending ? ` ${pending} מסמכים ממתינים לאישור ולא נכללו בדוח.` : ''}</div>
    </section>
    <section class="p-sec"><h2 style="border-color:#b42318">תשלומים בלי חשבונית או קבלה <span class="cnt">${missOut.length}</span></h2>${missOut.length ? `<div class="meta">סך הכל ${esc(fmtMoney(s.sum(missOut)))}, לפי ספק</div>` : ''}${missTable}</section>
    ${missIn.length ? sec('הכנסות שלא נמצאה עליהן קבלה שהוצאת', 'בדוק שהוצאת ללקוח חשבונית מס/קבלה', missIn, 'base', '#b42318') : ''}
    ${sec('יש תשלום ואישור, אבל אין חשבונית מס', 'נמצא רק אישור תשלום, חשבון עסקה או מסמך אחר. יש לבקש מהספק חשבונית מס', s.noInv, 'docs', '#b54708')}
    ${sec('לבדיקה', 'לא ברור אם צריך מסמך: העברות לאנשים פרטיים, צ׳קים, קניות שאולי פרטיות', checkList, 'reason', '#3538cd')}
    ${orphansSec}
    ${sec('יש חשבונית מס, אין קבלה', 'בדרך כלל מספיק כשהתשלום בכרטיס אשראי', s.noRec, 'docs', '#5d6b7e')}
    ${sec('מותאם ומלא', '', s.complete, 'docs', '#067647')}
    ${sec('לא נדרש מסמך', '', s.notNeeded, 'reason', '#98a2b3')}
    <footer class="p-foot">הופק ב-Ka-Ching. הוצאות מתחת ל-${MIN_AMOUNT} ₪ לא נספרות. מסמכים שממתינים לאישור לא נכללים.</footer>`;
}
let printTitle = null;
window.addEventListener('beforeprint', () => {
  let root = $('#printRoot');
  if (!root){ root = document.createElement('div'); root.id = 'printRoot'; document.body.append(root); }
  rederive();
  const vat = UI.tab === 'vat';
  root.innerHTML = vat ? vatPrintHtml() : printHtml();
  if (printTitle == null) printTitle = document.title;
  document.title = `Ka-Ching ${vat ? 'מעמ' : 'דוח חוסרים'} ${periodLabel(period()).replace(/\//g, '-')}`;
});
window.addEventListener('afterprint', () => {
  if (printTitle != null){ document.title = printTitle; printTitle = null; }
  const root = $('#printRoot'); if (root) root.innerHTML = '';
});

/* ============================== ייצוא ============================== */
function exportXlsx(){
  if (!window.XLSX){ toast(errText({ code: 'no_xlsx' })); return; }
  const s = stats();
  const row = t => [fmtDateLong(t.date), t.merchant || '', t.desc, srcOf(t)?.label || '', t.dir === 'in' ? t.amount : -t.amount, t.origAmount ? `${t.origAmount} ${t.origCurrency}` : '', ST[t._status].label, t._docs.map(d => `${DOC_TYPES[d.docType]} ${d.number || ''}`).join(' + ') || t.needReason || ''];
  const head = ['תאריך','בית עסק','תיאור בבנק','חשבון','סכום ₪','סכום מקורי','מצב','מסמכים / הערה'];
  const wb = XLSX.utils.book_new();
  const summary = [
    ['Ka-Ching · דוח התאמת בנק וחשבוניות'], [`תקופה: ${fmtDateLong(s.p.from)} עד ${fmtDateLong(s.p.to)}`], [],
    ['קטגוריה','מספר תנועות','סכום ₪'],
    ['חסר מסמך', s.missing.length, +s.sum(s.missing).toFixed(2)],
    ['חסרה חשבונית מס', s.noInv.length, +s.sum(s.noInv).toFixed(2)],
    ['לבדיקה', s.check.length + s.pending.length, +s.sum([...s.check, ...s.pending]).toFixed(2)],
    ['יש חשבונית, אין קבלה', s.noRec.length, +s.sum(s.noRec).toFixed(2)],
    ['מלא', s.complete.length, +s.sum(s.complete).toFixed(2)],
    ['לא נדרש מסמך', s.notNeeded.length, +s.sum(s.notNeeded).toFixed(2)],
    ['הוראות קבע (לא בדוח)', s.recurring.length, +s.sum(s.recurring).toFixed(2)],
    ['תרומות (לא בדוח)', s.donations.length, +s.sum(s.donations).toFixed(2)],
    ['מסמכים ללא תנועה', s.orphans.length, +s.orphans.reduce((a, d) => a + (d.amount || 0), 0).toFixed(2)]
  ];
  const add = (name, aoa, widths) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = widths.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name); };
  const W = [11, 22, 30, 24, 12, 14, 16, 34];
  add('סיכום', summary, [26, 14, 14]);
  add('חסר מסמך', [head, ...groupByVendor(s.missing).flatMap(g => g.list.map(row))], W);
  add('חסרה חשבונית מס', [head, ...s.noInv.map(row)], W);
  add('לבדיקה', [head, ...[...s.check, ...s.pending].map(row)], W);
  add('מסמכים ללא תנועה', [['תאריך','ספק','סוג','מספר','סכום','מטבע','כיוון'], ...s.orphans.map(d => [fmtDateLong(d.date), d.vendor, DOC_TYPES[d.docType], d.number, d.amount, d.currency, d.dir === 'income' ? 'הכנסה' : 'הוצאה'])], [11, 26, 16, 12, 12, 8, 10]);
  add('כל התנועות', [head, ...[...s.tx].sort((a, b) => a.date.localeCompare(b.date)).map(row)], W);
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.writeFile(wb, `דוח-התאמה-${s.p.from}-עד-${s.p.to}.xlsx`);
}
function requestText(g){
  const me = (S.settings.bizNames.split(',')[0] || '').trim();
  return `שלום,\nאשמח לקבל חשבונית מס/קבלה עבור התשלומים הבאים:\n${g.list.map(t => `• ${fmtDateLong(t.date)} — ${fmtMoney(t.amount)}${t.desc ? ` (${t.desc})` : ''}`).join('\n')}\n\nתודה רבה${me ? ',\n' + me : ''}`;
}
async function copyText(text){
  try { await navigator.clipboard.writeText(text); toast('הנוסח הועתק. אפשר להדביק במייל או בוואטסאפ לספק.'); }
  catch { modal('העתק את הנוסח', `<textarea rows="9" readonly>${esc(text)}</textarea><div class="muted">סמן את הטקסט והעתק.</div>`); }
}

/* ============================== שאלות ל-Claude ============================== */
let askCtl = null;
function digest(){
  const s = stats();
  const tl = s.tx.map(t => `${t.date} | ${srcOf(t)?.label || ''} | ${t.merchant || '-'} | ${t.desc} | ${t.dir === 'in' ? '+' : '-'}${t.amount}${t.origAmount ? ` (${t.origAmount} ${t.origCurrency})` : ''} | ${ST[t._status].label} | ${t.category || ''} | ${t._docs.map(d => DOC_TYPES[d.docType] + ' ' + (d.number || '')).join(' + ')}`);
  const dl = S.docs.filter(d => isApproved(d) && inPeriod(d.date, { from: addDays(s.p.from, -45), to: addDays(s.p.to, 45) })).map(d => `${d.date} | ${d.vendor} | ${DOC_TYPES[d.docType]} | ${d.number || '-'} | ${d.amount} ${d.currency} | מע"מ ${d.vat ?? '?'} | ${d.dir === 'income' ? 'הכנסה' : 'הוצאה'} | ${d._tx.length ? 'מותאם' : 'ללא תנועה'}`);
  let txt = `תקופה: ${s.p.from} עד ${s.p.to}\n\nתנועות (תאריך | חשבון | בית עסק | תיאור | סכום | מצב | קטגוריה | מסמכים):\n${tl.join('\n')}\n\nמסמכים (תאריך | ספק | סוג | מספר | סכום | מע"מ | כיוון | מצב):\n${dl.join('\n')}`;
  if (txt.length > 200000) txt = txt.slice(0, 200000) + '\n(הנתונים קוצרו)';
  return txt;
}
async function ask(q){
  q = (q || $('#askQ').value).trim(); if (!q) return;
  $('#askQ').value = q;
  askCtl?.abort(); askCtl = new AbortController();
  $('#btnAskStop').classList.remove('hidden'); $('#btnAsk').disabled = true;
  $('#askOut').textContent = 'Claude חושב… (עד דקה)';
  try {
    $('#askOut').textContent = await ai(`You are a bookkeeping assistant for an Israeli business owner. ${bizLine()} Answer in clear, plain Hebrew, short paragraphs or a short list, with exact amounts in ₪. Use only the data below; if the data cannot answer, say so.\n\n${digest()}\n\nהשאלה: ${q}`, { json: false, kind: 'ask', signal: askCtl.signal });
  } catch (e){ $('#askOut').textContent = e?.code === 'cancelled' ? '' : errText(e); }
  $('#btnAskStop').classList.add('hidden'); $('#btnAsk').disabled = false;
}

/* ============================== אירועים ============================== */
function bindDrop(zoneSel, inputSel, handler){
  const z = $(zoneSel), inp = $(inputSel);
  inp.addEventListener('change', () => { if (inp.files.length) handler([...inp.files]); inp.value = ''; });
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('over'); if (e.dataTransfer.files.length) handler([...e.dataTransfer.files]); });
}
bindDrop('#dropBank', '#fileBank', importBankFiles);
bindDrop('#dropDocs', '#fileDocs', importDocFiles);
$('#fileCamera').addEventListener('change', e => { const inp = e.target; if (inp.files.length) importDocFiles([...inp.files]); inp.value = ''; });
$('#btnAccount').addEventListener('click', openSettings);
$('#btnScan').addEventListener('click', () => scanGmail(false));
$('#btnRescan').addEventListener('click', () => scanGmail(true));
$('#btnMatch').addEventListener('click', runMatch);
$('#btnExport').addEventListener('click', exportXlsx);
$('#btnSettings').addEventListener('click', openSettings);
$('#btnAsk').addEventListener('click', () => ask());
$('#btnAskStop').addEventListener('click', () => askCtl?.abort());
$('#askQ').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); });
$('#txSearch').addEventListener('input', () => { UI.txLimit = 150; renderBank(); });
$('#docSearch').addEventListener('input', () => { UI.docLimit = 150; renderDocs(); });
$('#gq').addEventListener('change', e => { S.settings.gmailQuery = e.target.value; markDirty('settings'); });
for (const id of ['#pFrom', '#pTo']) $(id).addEventListener('change', () => {
  const f = $('#pFrom').value, t = $('#pTo').value;
  if (f) S.settings.from = f; if (t) S.settings.to = t;
  markDirty('settings'); renderAll();
});
for (const b of $$('.tab')) b.addEventListener('click', () => switchTab(b.dataset.tab));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
// שומרים טיוטה של מה שהקלדת בכרטיסי האישור, כדי שרענון של המסך לא ימחק אותה
function rvDraftCapture(e){
  const f = e.target.dataset?.f, card = e.target.closest?.('#tab-review .rv');
  if (!f || !card) return;
  const id = card.dataset.id;
  (UI.rvDraft[id] = UI.rvDraft[id] || {})[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (e.target.classList.contains('need') && e.target.value.trim()) e.target.classList.remove('need');
}
document.addEventListener('change', rvDraftCapture);
document.addEventListener('input', rvDraftCapture);
document.addEventListener('input', e => { if (e.target.id === 'linkSearch'){ const v = e.target.value; const id = e.target.dataset.tx; clearTimeout(UI.lt); UI.lt = setTimeout(() => { openLink(id, v); const i = $('#linkSearch'); if (i){ i.focus(); i.setSelectionRange(v.length, v.length); } }, 250); } });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act], [data-txf], [data-mf], [data-df], [data-preset]');
  if (!el) return;
  if (el.dataset.txf){ UI.txf = el.dataset.txf; UI.txLimit = 150; $$('[data-txf]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); renderBank(); return; }
  if (el.dataset.mf){ UI.mf = el.dataset.mf; $$('[data-mf]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); renderMail(); return; }
  if (el.dataset.df){ UI.df = el.dataset.df; $$('[data-df]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); renderDocs(); return; }
  if (el.dataset.preset){ ask(el.dataset.preset); return; }
  const act = el.dataset.act, id = el.dataset.id;
  switch (act){
    case 'close-overlay': if (e.target === el) closeModal(); break;
    case 'close': closeModal(); break;
    case 'logout': logout(); break;
    case 'clear-demo': clearDemo(); rederive(); renderAll(); break;
    case 'stop': jobs[el.dataset.job]?.ctl?.abort(); break;
    case 'more': if (el.dataset.what === 'flow') UI.flowLimit += 200; if (el.dataset.what === 'tx') UI.txLimit += 150; if (el.dataset.what === 'mail') UI.mailLimit += 150; if (el.dataset.what === 'doc') UI.docLimit += 150; renderAll(); break;
    case 'goto': {
      const go = el.dataset.go;
      if (go === 'complete'){ switchTab('board'); UI.txf = 'complete'; $$('[data-txf]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.txf === 'complete'))); renderBank(); break; }
      switchTab('report');
      const target = { missing: '#r-missing', noinv: '#r-noinv', check: '#r-check', orphans: '#r-orphans' }[go];
      setTimeout(() => $(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
      break;
    }
    case 'tx': openTx(id); break;
    case 'link': openLink(id); break;
    case 'do-link': {
      const t = el.dataset.t, d = el.dataset.d;
      S.links.push({ t, d, by: 'manual', conf: 1, reason: 'קושר ידנית' });
      S.rejects = S.rejects.filter(r => r !== t + '|' + d);
      markDirty('links', 'rejects'); rederive(); renderAll(); openTx(t); break;
    }
    case 'unlink': {
      const t = el.dataset.t, d = el.dataset.d;
      S.links = S.links.filter(l => !(l.t === t && l.d === d));
      if (!S.rejects.includes(t + '|' + d)) S.rejects.push(t + '|' + d);
      const inDoc = $('#modalRoot .modal-h h3')?.textContent === 'פרטי מסמך';
      markDirty('links', 'rejects'); rederive(); renderAll();
      if ($('#modalRoot').innerHTML){ if (inDoc) openDoc(d); else openTx(t); }
      break;
    }
    case 'set-need': {
      const need = el.dataset.need;
      if (need) S.overrides[id] = { needsDoc: need }; else delete S.overrides[id];
      markDirty('overrides'); rederive(); renderAll();
      if ($('#modalRoot').innerHTML) openTx(id);
      break;
    }
    case 'doc': openDoc(id); break;
    case 'goto-review': switchTab('review'); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
    case 'rv-approve': {
      const d = S.docs.find(x => x.id === id), card = el.closest('.rv'); if (!d || !card) break;
      readReview(card, d); d.review = 'approved';
      markDirty('docs'); localMatch(); rederive(); renderAll();
      const t = d._tx[0];
      toast(t ? `אושר והותאם לתנועה: ${t.merchant || t.desc}, ${fmtMoney(t.amount)}` : 'אושר. עוד לא נמצאה תנועה מתאימה.');
      break;
    }
    case 'rv-approve-all': {
      let n = 0;
      for (const card of $$('#tab-review .rv')){ const d = S.docs.find(x => x.id === card.dataset.id); if (d){ readReview(card, d); d.review = 'approved'; n++; } }
      markDirty('docs'); localMatch(); rederive(); renderAll();
      toast(`${n} מסמכים אושרו.`);
      break;
    }
    case 'rv-reject': {
      if (el.dataset.sure !== '1'){ el.dataset.sure = '1'; el.textContent = 'בטוח? לחץ שוב'; break; }
      const d = S.docs.find(x => x.id === id); if (!d) break;
      d.review = 'rejected'; delete UI.rvDraft[id]; trashIfOrphan(d);
      S.links = S.links.filter(l => l.d !== id);
      markDirty('docs', 'links'); rederive(); renderAll();
      toast('המסמך הוסר מהרשימה.');
      break;
    }
    case 'save-doc': {
      const d = S.docs.find(x => x.id === id); if (!d) break;
      d.vendor = $('#dv').value.trim() || d.vendor; d.docType = $('#dt').value; d.date = $('#dd').value || d.date;
      const a = parseFloat($('#da').value); d.amount = isFinite(a) ? a : d.amount;
      d.currency = ($('#dc').value.trim() || 'ILS').toUpperCase(); d.foreign = d.currency !== 'ILS' || d.foreign;
      d.number = $('#dn').value.trim(); d.dir = $('#dr').value; d.exempt = $('#de').checked;
      d.taxId = $('#dtx').value.replace(/[^\d-]/g, ''); d.category = $('#dcat').value.trim();
      const vt = parseFloat($('#dvat').value); d.vat = isFinite(vt) ? vt : null;
      d.allocNum = $('#dal').value.replace(/\D/g, '');
      markDirty('docs'); localMatch(); rederive(); renderAll(); closeModal(); toast('המסמך נשמר.'); break;
    }
    case 'del-doc': {
      if (el.dataset.sure !== '1'){ el.dataset.sure = '1'; el.textContent = 'בטוח? לחץ שוב למחיקה'; break; }
      trashIfOrphan(S.docs.find(x => x.id === id));
      S.docs = S.docs.filter(x => x.id !== id); S.links = S.links.filter(l => l.d !== id);
      markDirty('docs', 'links'); rederive(); renderAll(); closeModal(); break;
    }
    case 'del-src': {
      if (el.dataset.sure !== '1'){ el.dataset.sure = '1'; el.textContent = 'למחוק?'; setTimeout(() => { if (el.isConnected){ el.dataset.sure = ''; el.textContent = '×'; } }, 3500); break; }
      const ids = new Set(S.tx.filter(t => t.sourceId === id).map(t => t.id));
      S.tx = S.tx.filter(t => !ids.has(t.id)); S.sources = S.sources.filter(s => s.id !== id); S.links = S.links.filter(l => !ids.has(l.t));
      markDirty('tx', 'sources', 'links'); rederive(); renderAll(); break;
    }
    case 'copy-req': { const g = UI.missingGroups?.[+el.dataset.group]; if (g) copyText(requestText(g)); break; }
    case 'export': exportXlsx(); break;
    case 'pdf': window.print(); break;
    case 'vat-export': vatExport(); break;
    case 'vat-period': { const x = vatPresets()[el.dataset.kind]; if (x){ S.settings.from = x.from; S.settings.to = x.to; markDirty('settings'); syncInputs(); renderAll(); } break; }
    case 'save-settings': {
      S.settings.bizNames = $('#setBiz').value.trim(); S.settings.aiMode = $('#setMode').value;
      S.settings.maxThreads = Math.max(10, Math.min(2000, parseInt($('#setMax').value) || 300));
      const rep = $('#setReport'), drv = $('#setDrive');
      const turnOn = !!rep?.checked && S.settings.monthlyReport !== true;
      if (rep){ S.settings.monthlyReport = rep.checked; if (turnOn) S.settings.monthlyReportSince = reportSince(); }
      if (drv) S.settings.driveSave = drv.checked;
      markDirty('settings');
      // הפעלה ראשונה: אחרי שההגדרה נשמרה, עוברים פעם אחת ל-Google לאשר את מה שצריך
      const need = [];
      if (rep?.checked && CAP.report && !CAP.report.canSend) need.push('send');
      if (drv?.checked && CAP.drive && !CAP.drive.canWrite) need.push('drive');
      if (need.length){
        el.disabled = true; el.textContent = 'שומר…';
        clearTimeout(saveTimer); flush();
        saveChain.then(() => { location.href = `/auth/login?add=${need.join(',')}&hint=${encodeURIComponent(CAP.me.email)}`; });
        break;
      }
      closeModal(); renderCaps(); toast(turnOn ? `נשמר. דוח החוסרים יישלח אליך ב-${nextReport()?.date || '10 לחודש'}.` : 'ההגדרות נשמרו.'); break;
    }
    case 'report-send-now': {
      const ym = el.dataset.month;
      el.disabled = true; el.textContent = 'שולח…';
      clearTimeout(saveTimer); flush();
      saveChain.then(() => api('/report/send-now', { method: 'POST', body: { month: ym } }))
        .then(r => { toast(`הדוח על ${monthName(ym)} נשלח אל ${CAP.me.email}. בדוק את תיבת הדואר.`, 6000); el.textContent = 'נשלח ✓'; })
        .catch(e => { toast(errText(e), 7000); el.disabled = false; el.textContent = `שלח לי עכשיו את הדוח על ${monthName(ym)}`; });
      break;
    }
    case 'drive-backfill': closeModal(); driveBackfill(); break;
    case 'don-no': case 'don-yes': case 'don-reset': {
      const tx = id ? S.tx.find(t => t.id === id) : null;
      const k = el.dataset.k || (tx ? recKey(tx) : '');
      if (!k) break;
      const rules = S.settings.donationRules = { ...(S.settings.donationRules || {}) };
      if (act === 'don-reset') delete rules[k]; else rules[k] = act === 'don-yes' ? 'yes' : 'no';
      markDirty('settings'); rederive(); renderAll();
      if (id && $('#modalRoot').innerHTML) openTx(id);
      toast(act === 'don-yes' ? 'סומן כתרומה. התשלומים למוסד הזה מופיעים בלשונית "תרומות" ולא בדוח החוסרים.' : act === 'don-no' ? 'הוסר מהתרומות. התשלומים האלה חוזרים לדוח החוסרים.' : 'הוחזר לתרומות.');
      break;
    }
    case 'rec-no': case 'rec-yes': case 'rec-reset': {
      const k = el.dataset.k || (S.tx.find(t => t.id === id) ? recKey(S.tx.find(t => t.id === id)) : '');
      if (!k) break;
      const rules = S.settings.recurringRules = { ...(S.settings.recurringRules || {}) };
      if (act === 'rec-reset') delete rules[k]; else rules[k] = act === 'rec-yes' ? 'yes' : 'no';
      markDirty('settings'); rederive(); renderAll();
      if (id && $('#modalRoot').innerHTML) openTx(id);
      toast(act === 'rec-yes' ? 'סומן כהוראת קבע. התשלומים של הספק הזה לא ייכנסו לדוח החוסרים.' : act === 'rec-no' ? 'הוסר מהוראות הקבע. התשלומים של הספק הזה חוזרים לדוח החוסרים.' : 'הוחזר לתשלומים הקבועים.');
      break;
    }
    case 'copy-cron': {
      const t = $('#cronCode'); if (!t) break;
      navigator.clipboard?.writeText(t.value).then(() => toast('הקוד הועתק.'), () => { t.select(); toast('סמן את הקוד והעתק עם Ctrl+C.'); });
      break;
    }
    case 'wipe': {
      if (el.dataset.sure !== '1'){ el.dataset.sure = '1'; el.textContent = 'בטוח? הפעולה מוחקת הכל. לחץ שוב'; break; }
      const keep = { ...S.settings, from: '', to: '' };
      S.demo = false; S.sources = []; S.tx = []; S.emails = []; S.docs = []; S.links = []; S.rejects = []; S.overrides = {}; S.threads = {}; S.settings = keep;
      markDirty(...KEYS); syncInputs(); rederive(); renderAll(); closeModal(); toast('כל הנתונים נמחקו.'); break;
    }
  }
});

/* ============================== הפעלה ============================== */
loadDemo(); syncInputs(); rederive(); renderAll();
const fromHash = () => {
  const h = (location.hash || '').slice(1);
  // קישור מהמייל: #report:2026-10 פותח את הדוח על החודש הזה
  const m = h.match(/^report:(\d{4}-(0[1-9]|1[0-2]))$/);
  if (m){ UI.hashMonth = m[1]; setMonthPeriod(m[1]); switchTab('report'); return; }
  if (TABS.includes(h) && h !== UI.tab) switchTab(h);
};
fromHash(); window.addEventListener('hashchange', fromHash);
init();
