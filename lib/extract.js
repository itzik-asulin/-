// חילוץ חשבוניות וקבלות ממייל או מקובץ, בעזרת Claude.
// קבצי PDF נשלחים ל-Claude כמו שהם, כך שהוא רואה גם את הטקסט וגם את המראה של החשבונית.
import { claude, parseJson, modelFor } from './claude.js';
import { getMessage, getAttachment, HttpError } from './google.js';
import { saveFile } from './drive.js';

const IMG = /^image\/(jpeg|png|gif|webp)$/i;
const MAX_FILE = 20 * 1024 * 1024;

export function docPrompt(ctx){
  const biz = ctx.bizNames ? `The user's own business / owner names: ${ctx.bizNames}.` : 'The user did not specify business names.';
  const parts = ctx.parts.map((p, i) => `- Attachment ${i + 1}: "${p.name}" ${p.note}`).join('\n');
  return `You extract accounting documents (invoices and receipts) for an Israeli business owner. ${biz}
${ctx.kind === 'upload' ? 'The user uploaded the attached file manually.' : 'Below is one email; its PDF and image attachments are attached above.'}

${ctx.kind === 'upload' ? '' : `From: ${ctx.from}\nDate: ${ctx.date}\nSubject: ${ctx.subject}\n\nBody (may be truncated):\n${ctx.body}\n\n`}Attachments:
${parts || '(none)'}

Reply with ONLY a JSON object:
{"relevant":true,"reason":"short Hebrew note","documents":[{"source":"attachment file name or \\"body\\"","docType":"tax_invoice_receipt|tax_invoice|receipt|deal_invoice|payment_confirmation|credit_note|other","vendor":"issuer name as written, Hebrew if shown","customer":"name the document is addressed to (לכבוד)","aliases":["other names of the same issuer: English/Hebrew brand, legal name"],"taxId":"ע.מ / ח.פ digits or null","date":"YYYY-MM-DD","amount":123.45,"currency":"ILS","vat":21.06,"number":"document number","direction":"expense|income","exempt":false,"foreign":false,"linkOnly":false,"cardLast4":null,"description":"what was bought, short Hebrew","allocationNumber":null}]}

Rules:
- amount = the final total including VAT (סה"כ לתשלום). Numbers only, no commas.
- docType: חשבונית מס/קבלה → tax_invoice_receipt; חשבונית מס → tax_invoice; קבלה → receipt; חשבון עסקה / דרישת תשלום / proforma → deal_invoice; אישור תשלום / אישור עסקה / payment gateway confirmation → payment_confirmation; חשבונית זיכוי → credit_note. A foreign "Invoice" → tax_invoice, a foreign "Receipt" or "Invoice - Paid" → receipt, and set foreign=true.
- direction = "income" only when the issuer is the user's own business (a document the user issued to a customer); otherwise "expense".
- exempt = true when the issuer is עוסק פטור.
- allocationNumber = the "מספר הקצאה" printed on an Israeli tax invoice (digits only), or null when there is none.
- linkOnly = true when the email only links to the document and its details are not in the email or attachments; still fill what is known.
- relevant = false (and documents = []) for marketing, newsletters, quotes (הצעת מחיר), order or shipping notices without a billed amount, and anything that is not a bill, invoice or receipt.
- Several documents (for example an invoice and a separate receipt) → several entries. Never invent numbers you cannot see.`;
}

async function runExtraction(prompt, docs, images, precise){
  const model = modelFor(precise ? 'main' : 'fast');
  let res;
  try { res = await claude({ prompt, model, docs, images, maxTokens: 4000 }); }
  catch (e){
    // PDF פגום או מוגן בסיסמה: מנסים שוב בלי הקבצים, רק עם תוכן המייל
    if (e.code === 'ai_bad_request' && (docs.length || images.length)) res = await claude({ prompt: prompt + '\n\n(The attachments could not be read.)', model, maxTokens: 4000 });
    else throw e;
  }
  const json = parseJson(res.text);
  if (json === undefined) throw new HttpError(502, 'invalid_json', 'model did not return JSON');
  return json;
}

// אחרי שה-AI מצא חשבוניות, שומרים את הקבצים המקוריים ב-Drive (אם המשתמש הפעיל את זה).
// תקלה ב-Drive לא עוצרת את קריאת החשבונית: היא רק מוחזרת כהערה.
const docList = result => (result && result.relevant !== false && Array.isArray(result.documents)) ? result.documents.filter(d => d && typeof d === 'object') : [];
const docMeta = d => ({ date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? d.date : null, vendor: d.vendor, amount: d.amount, dir: d.direction === 'income' ? 'income' : 'expense' });

export async function extractFromEmail(email, messageId, { bizNames = '', precise = false, drive = false } = {}){
  const m = await getMessage(email, messageId);
  const candidates = m.attachments
    .filter(a => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename) || IMG.test(a.mimeType))
    .filter(a => !(IMG.test(a.mimeType) && (a.inline || a.size < 15000)))   // לוגו וחתימות
    .filter(a => !/^(image\d{3}|logo|outlook|signature|banner)/i.test(a.filename))
    .slice(0, 3);
  const docs = [], images = [], parts = [], bufs = new Map();
  for (const a of candidates){
    if (a.size > MAX_FILE){ parts.push({ name: a.filename, note: '(too large, not attached)' }); continue; }
    try {
      const buf = a.data ? Buffer.from(String(a.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64') : await getAttachment(email, m.id, a.id);
      const data = buf.toString('base64');
      bufs.set(a.filename, { buf, mime: IMG.test(a.mimeType) ? a.mimeType.toLowerCase().replace('jpg', 'jpeg') : 'application/pdf' });
      if (IMG.test(a.mimeType)){ images.push({ mime: a.mimeType.toLowerCase().replace('jpg', 'jpeg'), data }); parts.push({ name: a.filename, note: '(image, attached)' }); }
      else { docs.push({ data }); parts.push({ name: a.filename, note: '(PDF, attached)' }); }
    } catch (e){
      if (e.code === 'needs_reauth' || e.code === 'no_gmail_scope') throw e;
      parts.push({ name: a.filename, note: '(could not be downloaded)' });
    }
  }
  const prompt = docPrompt({ kind: 'email', bizNames, from: `${m.from} <${m.fromEmail}>`, date: m.date, subject: m.subject, body: m.body.slice(0, 5000), parts });
  const result = await runExtraction(prompt, docs, images, precise);
  const meta = { ...m }; delete meta.body; meta.attachments = m.attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType }));
  const files = {}; let driveError = null;
  if (drive){
    for (const d of docList(result)){
      const b = bufs.get(String(d.source || ''));
      if (!b || files[d.source]) continue;
      try { files[d.source] = await saveFile(email, { buf: b.buf, mime: b.mime, original: d.source, doc: docMeta(d) }); }
      catch (e){ driveError = e.code || 'drive_failed'; if (['needs_reauth', 'no_drive_scope', 'drive_api_disabled'].includes(e.code)) break; }
    }
  }
  return { meta, result, files, driveError };
}

// השלמה: שמירה ב-Drive של חשבונית שכבר נמצאה במייל בעבר
export async function saveEmailAttachment(email, { emailId, fileName, doc }){
  const m = await getMessage(email, String(emailId));
  const a = m.attachments.find(x => x.filename === fileName) || (m.attachments.length === 1 ? m.attachments[0] : null);
  if (!a) throw new HttpError(404, 'no_attachment', 'attachment not found');
  if (a.size > MAX_FILE) throw new HttpError(413, 'too_big', 'attachment too large');
  const buf = a.data ? Buffer.from(String(a.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64') : await getAttachment(email, m.id, a.id);
  const mime = IMG.test(a.mimeType) ? a.mimeType.toLowerCase().replace('jpg', 'jpeg') : (/pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename) ? 'application/pdf' : (a.mimeType || 'application/octet-stream'));
  return saveFile(email, { buf, mime, original: a.filename, doc });
}

export async function extractFromFile({ email, name, mime, data, bizNames = '', precise = false, drive = false }){
  const isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(name);
  if (!isPdf && !IMG.test(mime)) throw new HttpError(400, 'bad_file', 'only PDF or image files');
  const prompt = docPrompt({ kind: 'upload', bizNames, parts: [{ name, note: isPdf ? '(PDF, attached)' : '(image, attached)' }] });
  const result = await runExtraction(prompt, isPdf ? [{ data }] : [], isPdf ? [] : [{ mime: mime.toLowerCase().replace('jpg', 'jpeg'), data }], precise);
  let file = null, driveError = null;
  const first = docList(result)[0];
  if (drive && first){
    try { file = await saveFile(email, { buf: Buffer.from(data, 'base64'), mime: isPdf ? 'application/pdf' : mime.toLowerCase().replace('jpg', 'jpeg'), original: name, doc: docMeta(first) }); }
    catch (e){ driveError = e.code || 'drive_failed'; }
  }
  return { result, file, driveError };
}
