// דוח החוסרים החודשי במייל: חישוב (אותם כללים כמו באתר) ובניית המייל.
// החישוב כאן חייב להתאים ל-txStatus/stats שב-public/app.js.

const MIN_AMOUNT = 50; // הוצאה מתחת לסכום הזה לא נספרת, אלא אם סימנת אחרת ידנית
const ROW_LIMIT = 150; // שורות מקסימום בכל חלק של המייל, כדי שהמייל לא יהיה ענק

const DOC_TYPES = {
  tax_invoice_receipt: 'חשבונית מס/קבלה',
  tax_invoice: 'חשבונית מס',
  receipt: 'קבלה',
  deal_invoice: 'חשבון עסקה',
  payment_confirmation: 'אישור תשלום',
  credit_note: 'חשבונית זיכוי',
  other: 'מסמך אחר'
};
const ST_LABEL = {
  missing: 'חסר מסמך', no_invoice: 'חסרה חשבונית מס', check: 'לבדיקה', no_receipt: 'חסרה קבלה',
  pending: 'טרם סווג', complete: 'מלא', recurring: 'הוראת קבע', donation: 'תרומה', not_needed: 'לא נדרש'
};
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

const pad = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const fmtDate = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
function fmtMoney(n, cur = 'ILS'){
  if (n == null || !isFinite(Number(n))) return '—';
  try { return new Intl.NumberFormat('he-IL', { style: 'currency', currency: cur || 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n)); }
  catch { return Number(n).toFixed(2) + ' ' + (cur || ''); }
}

/* ---------- תאריכים לפי שעון ישראל ---------- */
export function israelToday(now = new Date()){
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export const monthOf = iso => iso.slice(0, 7);
export function prevMonth(iso){
  const [y, m] = iso.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}
export function monthRange(ym){
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
}
export const monthName = ym => `${HE_MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const isMonth = v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/* ---------- החישוב ---------- */
const isApproved = d => !d.review || d.review === 'approved';

// תרומות, הוראות קבע וחיובי כרטיס אשראי: אותם כללים בדיוק כמו ב-public/app.js
// (DONATION_RX, donationKeys, RECUR_RX, recurringKeys, CARD_BILL, isCardBill)
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const str = v => (v == null ? '' : String(v)).replace(BIDI, '').trim();
const normDesc = s => str(s).toLowerCase().replace(/\d{3,}/g, '#').replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();
const RECUR_RX = /הוראת?\s*קבע|(?<![א-ת])הו["״׳'.]?\s?ק(?![א-ת])|ה\.\s?קבע|הרשאה\s*לחיוב|חיוב\s*קבוע|standing\s*order|direct\s*debit|ביטוח|insurance|הפניקס|מגדל\s*(מקפת|חברה|לביטוח)|מנורה\s*מבטחים|איילון\s*(חברה|לביטוח)|שירביט|ליברה|פספורטכארד|פנסי|קופת\s*גמל|קרן\s*השתלמות|מיטב|אלטשולר|ילין\s*לפידות|הלוואה|משכנתא|mortgage|חברת\s*החשמל|ארנונה|עיריי|עירית|תאגיד\s*ה?מים|גיחון|מי\s*אביבים|אמישראגז|פזגז|סופרגז|בזק|סלקום|cellcom|פרטנר|partner|פלאפון|pelephone|גולן\s*טלקום|(?<![א-ת])הוט(?![א-ת])|\bhot\b|\byes\b|ליסינג|leasing|ועד\s*בית/i;
const DONATION_RX = /תרומ|עמות|(?<![א-ת])ע["״']ר(?![א-ת])|(?<![א-ת])חל["״']צ(?![א-ת])|צדקה|גמ["״']ח|(?<![א-ת])ישיב|תלמוד\s*תורה|בית\s*כנסת|בית\s*חב["״']?ד|נדרים|קופת\s*(העיר|רבי|ר["״']מ)|jgive|ג['׳]יגיב|israeltoremet|ישראל\s*תורמת|charity|donat|יד\s*שרה|איחוד\s*הצלה|זק["״']א|עזר\s*מציון|יד\s*לאחים/i;
const CARD_BILL = /ישראכרט|isracard|לאומי ?קארד|leumi ?card|אמריקן ?אקספרס|american ?express|\bamex\b|דיינרס|diners|ויזה ?כאל|כאל[\s-]|^כאל$|\bcal\b|מקס ?איט|max ?it|חיוב ?כרטיס|כרטיס ?אשראי/i;
function classifySetup(state){
  const sources = new Map((Array.isArray(state.sources) ? state.sources : []).map(s => [s.id, s]));
  const kindOf = t => sources.get(t.sourceId)?.kind === 'credit' ? 'credit' : 'bank';
  const isCardBill = t => kindOf(t) === 'bank' && t.dir === 'out' && (CARD_BILL.test(`${t.desc} ${t.merchant || ''}`) || /כרטיס[\s-]?ה?אשראי/.test(t.needReason || ''));
  const recKey = t => normDesc(t.merchant || t.desc);
  const rules = state.settings?.recurringRules || {};
  const donRules = state.settings?.donationRules || {};
  const groups = new Map();
  for (const t of Array.isArray(state.tx) ? state.tx : []){
    if (t.dir !== 'out' || isCardBill(t)) continue;
    const k = recKey(t); if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const text = list => list.map(t => `${t.desc} ${t.merchant || ''} ${t.category || ''}`).join(' | ');
  const don = new Set();
  for (const [k, list] of groups){
    if (donRules[k] === 'no') continue;
    if (donRules[k] === 'yes' || list.some(t => t.donation === true) || DONATION_RX.test(text(list))) don.add(k);
  }
  const keys = new Set();
  for (const [k, list] of groups){
    if (rules[k] === 'no' || don.has(k)) continue;
    if (rules[k] === 'yes' || list.some(t => t.recurring === true) || RECUR_RX.test(text(list))){ keys.add(k); continue; }
    const months = new Set(list.map(t => String(t.date).slice(0, 7)));
    const a = list.map(t => Number(t.amount));
    if (months.size >= 2 && list.length <= months.size + 1 && Math.max(...a) <= Math.min(...a) * 1.03 + 0.01) keys.add(k);
  }
  const base = t => t.dir === 'out' && !isCardBill(t);
  return { isDonation: t => base(t) && don.has(recKey(t)), isRecurring: t => base(t) && !don.has(recKey(t)) && keys.has(recKey(t)) };
}

export function computeReport(state, ym){
  const p = monthRange(ym);
  const overrides = state.overrides && typeof state.overrides === 'object' ? state.overrides : {};
  const allDocs = Array.isArray(state.docs) ? state.docs : [];
  const docs = allDocs.filter(isApproved);
  const allTx = (Array.isArray(state.tx) ? state.tx : []).map(t => ({ ...t, amount: n2(t.amount) }));
  const sources = new Map((Array.isArray(state.sources) ? state.sources : []).map(s => [s.id, s]));
  const docById = new Map(docs.map(d => [d.id, d]));
  const txById = new Map(allTx.map(t => [t.id, t]));
  const tDocs = new Map(), dTx = new Map();
  for (const l of Array.isArray(state.links) ? state.links : []){
    const t = txById.get(l.t), d = docById.get(l.d);
    if (!t || !d) continue;
    if (!tDocs.has(t.id)) tDocs.set(t.id, []);
    if (!dTx.has(d.id)) dTx.set(d.id, []);
    tDocs.get(t.id).push(d); dTx.get(d.id).push(t);
  }
  const isSmall = t => t.dir === 'out' && t.amount < MIN_AMOUNT;
  const needOf = t => overrides[t.id]?.needsDoc || t.needsDoc || null;
  const { isDonation, isRecurring } = classifySetup({ ...state, tx: allTx });
  function docsStatus(t, list){
    if (!list.length) return null;
    if (list.some(d => d.docType === 'credit_note')) return 'complete';
    const inv = list.some(d => d.docType === 'tax_invoice_receipt' || d.docType === 'tax_invoice');
    const rec = list.some(d => d.docType === 'tax_invoice_receipt' || d.docType === 'receipt');
    if ((list.some(d => d.exempt || d.foreign) || t.dir === 'in') && (inv || rec)) return 'complete';
    if (inv && rec) return 'complete';
    if (inv) return 'no_receipt';
    return 'no_invoice';
  }
  function status(t, list){
    if (isSmall(t) && !overrides[t.id]) return 'not_needed';
    const ds = docsStatus(t, list);
    if (isDonation(t) && overrides[t.id]?.needsDoc !== 'yes') return 'donation';
    if (isRecurring(t) && overrides[t.id]?.needsDoc !== 'yes') return ds === 'complete' ? 'complete' : 'recurring';
    if (ds) return ds;
    const need = needOf(t);
    if (need === 'no') return 'not_needed';
    if (need === 'maybe') return 'check';
    if (need === 'yes') return 'missing';
    return 'pending';
  }
  const inP = iso => !!iso && iso >= p.from && iso <= p.to;
  const tx = allTx.filter(t => inP(t.date)).map(t => {
    const list = tDocs.get(t.id) || [];
    return { ...t, _docs: list, _status: status(t, list), _src: sources.get(t.sourceId)?.label || '', _reason: isSmall(t) && !overrides[t.id] ? `הוצאה מתחת ל-${MIN_AMOUNT} ₪` : (t.needReason || '') };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const by = k => tx.filter(t => t._status === k);
  const need = tx.filter(t => !['not_needed', 'recurring', 'donation'].includes(t._status));
  const covered = tx.filter(t => t._status === 'complete' || t._status === 'no_receipt');
  const orphans = docs.filter(d => !(dTx.get(d.id) || []).length && inP(d.date)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const missing = by('missing');
  return {
    ym, p, tx,
    missOut: missing.filter(t => t.dir === 'out'),
    missIn: missing.filter(t => t.dir === 'in'),
    noInv: by('no_invoice'), noRec: by('no_receipt'),
    check: [...by('check'), ...by('pending')],
    complete: by('complete'), notNeeded: by('not_needed'), recurring: by('recurring'), donations: by('donation'),
    need, covered, orphans,
    coverage: need.length ? Math.round(100 * covered.length / need.length) : null,
    lastTxDate: tx.length ? tx[tx.length - 1].date : null,
    pendingReview: allDocs.filter(d => d.review === 'pending').length
  };
}

const sum = list => list.reduce((a, t) => a + n2(t.amount), 0);
function groupByVendor(list){
  const g = new Map();
  for (const t of list){ const k = String(t.merchant || t.desc || '').trim() || 'ללא שם'; if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
  return [...g.entries()].map(([name, v]) => ({ name, list: v, total: sum(v) })).sort((a, b) => b.total - a.total);
}

/* ---------- המייל ---------- */
const C = { ink: '#101828', ink2: '#344054', muted: '#5d6b7e', line: '#e4e7ec', paper: '#f5f6f8', accent: '#1d3b66', accentSoft: '#eef2f8', bad: '#b42318', badSoft: '#fef3f2', warn: '#b54708', warnSoft: '#fffaeb', check: '#3538cd', checkSoft: '#eef4ff', ok: '#067647', okSoft: '#ecfdf3' };
const FONT = `font-family:Heebo,Assistant,'Segoe UI',Arial,sans-serif`;
const td = (s, extra = '') => `<td style="padding:7px 10px;border-top:1px solid ${C.line};vertical-align:top;${extra}">${s}</td>`;
const th = (s, extra = '') => `<th style="padding:7px 10px;text-align:right;font-weight:600;color:${C.muted};font-size:12px;${extra}">${s}</th>`;
const nT = n => n === 1 ? 'תנועה אחת' : `${n} תנועות`;
const moneyTx = t => `${t.dir === 'in' ? '+' : ''}${fmtMoney(t.amount)}`;

function txRows(list, { reason = false } = {}){
  const rows = list.slice(0, ROW_LIMIT).map(t => {
    const info = t._docs.length ? t._docs.map(d => `${DOC_TYPES[d.docType] || 'מסמך'}${d.number ? ' #' + d.number : ''}`).join(' + ') : (reason ? t._reason : '');
    return `<tr>${td(esc(fmtDate(t.date)), 'white-space:nowrap')}${td(`${esc(t.merchant || '—')}<div style="color:${C.muted};font-size:12px">${esc(t.desc || '')}${info ? ' · ' + esc(info) : ''}</div>`)}${td(esc(t._src), `color:${C.muted};font-size:12px`)}${td(esc(moneyTx(t)), 'white-space:nowrap;text-align:left;direction:ltr')}</tr>`;
  }).join('');
  const more = list.length > ROW_LIMIT ? `<tr><td colspan="4" style="padding:7px 10px;border-top:1px solid ${C.line};color:${C.muted}">ועוד ${list.length - ROW_LIMIT} תנועות. הרשימה המלאה בקובץ המצורף ובאתר.</td></tr>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13.5px;color:${C.ink}"><tr>${th('תאריך')}${th('בית עסק')}${th('חשבון')}${th('סכום', 'text-align:left')}</tr>${rows}${more}</table>`;
}

function section(title, meta, body, color = C.accent){
  return `<tr><td style="padding:0 24px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px;background:#fff"><tr><td style="padding:14px 16px 8px;border-top:3px solid ${color};border-radius:10px 10px 0 0"><div style="font-size:16px;font-weight:700;color:${C.ink}">${title}</div>${meta ? `<div style="font-size:12.5px;color:${C.muted};margin-top:3px">${meta}</div>` : ''}</td></tr><tr><td style="padding:0 6px 8px">${body}</td></tr></table></td></tr>`;
}

function tile(label, value, sub, color, soft){
  return `<td width="25%" style="padding:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${soft};border-radius:10px"><tr><td style="padding:12px 12px 10px"><div style="font-size:12px;color:${C.ink2}">${label}</div><div style="font-size:24px;font-weight:700;color:${color};line-height:1.25">${value}</div><div style="font-size:11.5px;color:${C.muted}">${sub}</div></td></tr></table></td>`;
}

export function buildEmail(r, { to, baseUrl }){
  const mName = monthName(r.ym);
  const subject = `Ka-Ching · דוח חוסרים ל${mName}`;
  const link = `${baseUrl}/#report:${r.ym}`;
  const noData = !r.tx.length;
  const sumMiss = sum(r.missOut);
  const parts = [];

  // כותרת
  parts.push(`<tr><td style="background:${C.accent};padding:20px 24px;border-radius:12px 12px 0 0"><div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:.2px">Ka-Ching</div><div style="font-size:14px;color:#c9d6ea;margin-top:2px">דוח חוסרים · ${esc(mName)} (${fmtDate(r.p.from)} עד ${fmtDate(r.p.to)})</div></td></tr>`);

  if (noData){
    parts.push(`<tr><td style="padding:22px 24px 8px;font-size:15px;line-height:1.7;color:${C.ink}"><b>לא הועלו לאתר תנועות בנק או אשראי ל${esc(mName)}.</b><br>כדי לקבל דוח חוסרים, העלה לאתר את קובץ התנועות מהבנק ומחברות האשראי לחודש הזה. הדוח יתעדכן מיד באתר.</td></tr>`);
  } else {
    // סיכום
    parts.push(`<tr><td style="padding:18px 20px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${tile('חסר מסמך', r.missOut.length + r.missIn.length, esc(fmtMoney(sumMiss + sum(r.missIn))), C.bad, C.badSoft)}
      ${tile('חסרה חשבונית מס', r.noInv.length, 'יש רק אישור תשלום', C.warn, C.warnSoft)}
      ${tile('לבדיקה שלך', r.check.length, 'אולי פרטי', C.check, C.checkSoft)}
      ${tile('כיסוי', r.coverage == null ? '—' : r.coverage + '%', `${r.covered.length} מתוך ${r.need.length} תנועות`, C.ok, C.okSoft)}
    </tr></table></td></tr>`);
    const facts = [`נבדקו ${r.tx.length} תנועות מ${esc(mName)}`];
    if (r.recurring.length) facts.push(`${r.recurring.length === 1 ? 'הוראת קבע אחת' : r.recurring.length + ' הוראות קבע'} (${esc(fmtMoney(sum(r.recurring)))}) לא נכללות בדוח`);
    if (r.donations.length) facts.push(`${r.donations.length === 1 ? 'תרומה אחת' : r.donations.length + ' תרומות'} (${esc(fmtMoney(sum(r.donations)))}) לא נכללות בדוח`);
    if (r.lastTxDate && r.lastTxDate < r.p.to) facts.push(`התנועה האחרונה שהועלתה היא מ-${fmtDate(r.lastTxDate)}, אז ייתכן שחסרות תנועות מסוף החודש`);
    parts.push(`<tr><td style="padding:4px 24px 16px;font-size:13px;color:${C.muted}">${facts.join('. ')}.</td></tr>`);
  }

  if (r.pendingReview){
    parts.push(`<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.accentSoft};border-radius:10px"><tr><td style="padding:12px 14px;font-size:14px;color:${C.accent}"><b>${r.pendingReview} מסמכים ממתינים לאישור שלך.</b> הם לא נספרים בדוח עד שתאשר אותם. <a href="${esc(baseUrl)}/#review" style="color:${C.accent}">לאישור המסמכים</a></td></tr></table></td></tr>`);
  }

  if (!noData){
    if (r.missOut.length){
      const groups = groupByVendor(r.missOut);
      const body = groups.map(g => `<div style="padding:10px 10px 2px;font-size:14px"><b>${esc(g.name)}</b> <span style="color:${C.muted};font-size:12.5px">· ${nT(g.list.length)} · ${esc(fmtMoney(g.total))}</span></div>${txRows(g.list)}`).join('');
      parts.push(section('תשלומים בלי חשבונית או קבלה', `${nT(r.missOut.length)} · ${esc(fmtMoney(sumMiss))}. כדאי לבקש מהספקים`, body, C.bad));
    } else {
      parts.push(section('תשלומים בלי חשבונית או קבלה', 'אין. לכל התשלומים שדורשים מסמך נמצא מסמך.', '', C.ok));
    }
    if (r.missIn.length) parts.push(section('הכנסות שלא נמצאה עליהן קבלה שהוצאת', `${nT(r.missIn.length)} · ${esc(fmtMoney(sum(r.missIn)))}. בדוק שהוצאת ללקוח חשבונית מס/קבלה`, txRows(r.missIn), C.bad));
    if (r.noInv.length) parts.push(section('יש תשלום ואישור, אבל אין חשבונית מס', `${nT(r.noInv.length)}. נמצא רק אישור תשלום, חשבון עסקה או מסמך אחר`, txRows(r.noInv), C.warn));
    if (r.check.length) parts.push(section('לבדיקה שלך', `${r.check.length === 1 ? 'תנועה אחת שלא ברור' : r.check.length + ' תנועות שלא ברור'} אם צריך עליהן מסמך: העברות לאנשים פרטיים, קניות שאולי פרטיות`, txRows(r.check, { reason: true }), C.check));
    if (r.orphans.length){
      const rows = r.orphans.slice(0, ROW_LIMIT).map(d => `<tr>${td(esc(fmtDate(d.date)), 'white-space:nowrap')}${td(`${esc(d.vendor || '—')}<div style="color:${C.muted};font-size:12px">${esc(DOC_TYPES[d.docType] || 'מסמך')}${d.number ? ' #' + esc(d.number) : ''}${d.dir === 'income' ? ' · מסמך שהוצאת ללקוח' : ''}</div>`)}${td(esc(fmtMoney(d.amount, d.currency)), 'white-space:nowrap;text-align:left;direction:ltr')}</tr>`).join('');
      parts.push(section('מסמכים שלא נמצא להם חיוב', `${r.orphans.length === 1 ? 'מסמך אחד' : r.orphans.length + ' מסמכים'}. אולי שולמו במזומן, בחשבון אחר או בכרטיס שלא הועלה`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13.5px;color:${C.ink}"><tr>${th('תאריך')}${th('ספק')}${th('סכום', 'text-align:left')}</tr>${rows}</table>`, C.muted));
    }
  }

  // כפתור וחתימה
  parts.push(`<tr><td style="padding:6px 24px 22px" align="center"><a href="${esc(link)}" style="display:inline-block;background:${C.accent};color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 22px;border-radius:8px">פתח את הדוח באתר</a></td></tr>`);
  parts.push(`<tr><td style="padding:14px 24px 18px;border-top:1px solid ${C.line};font-size:12px;color:${C.muted};line-height:1.6">הדוח נשלח אוטומטית מ-Ka-Ching ל-${esc(to)} ב-10 לכל חודש, על החודש הקודם. הוא מבוסס על מה שהועלה לאתר ועל מסמכים שאישרת. הוצאות מתחת ל-${MIN_AMOUNT} ₪ לא נספרות. אפשר לכבות את הדוח בהגדרות האתר.${noData ? '' : ' רשימה מלאה מצורפת כקובץ שנפתח באקסל.'}</td></tr>`);

  const html = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head><body style="margin:0;padding:0;background:${C.paper}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};${FONT}" dir="rtl"><tr><td align="center" style="padding:20px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#fff;border:1px solid ${C.line};border-radius:12px;${FONT};text-align:right" dir="rtl">${parts.join('')}</table></td></tr></table></body></html>`;

  // גרסת טקסט פשוט, לתוכנות מייל שלא מציגות HTML
  const tl = list => list.slice(0, ROW_LIMIT).map(t => `- ${fmtDate(t.date)}  ${t.merchant || t.desc || ''}  ${moneyTx(t)}`).join('\n');
  const text = [
    `Ka-Ching · דוח חוסרים · ${mName}`, '',
    noData ? `לא הועלו לאתר תנועות ל${mName}. העלה את קובץ התנועות מהבנק כדי לקבל דוח.` :
      [`חסר מסמך: ${r.missOut.length + r.missIn.length}`, `חסרה חשבונית מס: ${r.noInv.length}`, `לבדיקה: ${r.check.length}`, r.missOut.length ? `\nתשלומים בלי חשבונית או קבלה:\n${tl(r.missOut)}` : '', r.noInv.length ? `\nאין חשבונית מס:\n${tl(r.noInv)}` : ''].filter(Boolean).join('\n'),
    r.pendingReview ? `\n${r.pendingReview} מסמכים ממתינים לאישור שלך: ${baseUrl}/#review` : '',
    '', `לדוח באתר: ${link}`
  ].join('\n');

  // קובץ מצורף שנפתח באקסל
  let csv = null;
  if (!noData){
    const q = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['מצב', 'תאריך', 'בית עסק', 'תיאור בבנק', 'חשבון', 'סכום ₪', 'סכום מקורי', 'מסמכים / הערה'];
    const order = ['missing', 'no_invoice', 'check', 'pending', 'no_receipt', 'complete', 'recurring', 'donation', 'not_needed'];
    const rows = [...r.tx].sort((a, b) => order.indexOf(a._status) - order.indexOf(b._status) || String(a.date).localeCompare(String(b.date)))
      .map(t => [ST_LABEL[t._status], fmtDate(t.date), t.merchant || '', t.desc || '', t._src, (t.dir === 'in' ? 1 : -1) * t.amount, t.origAmount ? `${t.origAmount} ${t.origCurrency || ''}` : '', t._docs.map(d => `${DOC_TYPES[d.docType] || ''} ${d.number || ''}`.trim()).join(' + ') || t._reason]);
    const orphanRows = r.orphans.map(d => ['מסמך ללא תנועה', fmtDate(d.date), d.vendor || '', DOC_TYPES[d.docType] || '', '', (d.dir === 'income' ? 1 : -1) * n2(d.amount), d.currency && d.currency !== 'ILS' ? d.currency : '', d.number ? '#' + d.number : '']);
    csv = '﻿' + [head, ...rows, ...orphanRows].map(row => row.map(q).join(',')).join('\r\n');
  }
  return { subject, html, text, csv, csvName: `ka-ching-${r.ym}.csv`, csvNameHe: `דוח-חוסרים-${r.ym}.csv` };
}

/* ---------- בניית הודעת מייל (MIME) לשליחה דרך Gmail ---------- */
const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
const encWord = s => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

export function buildMime({ from, to, subject, html, text, csv, csvName, csvNameHe }){
  const b1 = 'kc_mixed_' + Math.random().toString(36).slice(2), b2 = 'kc_alt_' + Math.random().toString(36).slice(2);
  const lines = [
    `From: Ka-Ching <${from}>`,
    `To: ${to}`,
    `Subject: ${encWord(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b1}"`,
    '',
    `--${b1}`,
    `Content-Type: multipart/alternative; boundary="${b2}"`,
    '',
    `--${b2}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${b2}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${b2}--`
  ];
  if (csv){
    const he = encodeURIComponent(csvNameHe || csvName);
    lines.push(
      `--${b1}`,
      `Content-Type: text/csv; charset="UTF-8"; name="${csvName}"`,
      `Content-Disposition: attachment; filename="${csvName}"; filename*=UTF-8''${he}`,
      'Content-Transfer-Encoding: base64',
      '',
      b64(csv)
    );
  }
  lines.push(`--${b1}--`, '');
  return lines.join('\r\n');
}
