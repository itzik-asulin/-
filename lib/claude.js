// קריאות ל-Claude API. המפתח נשמר רק בשרת ולא מגיע לדפדפן.
import { cfg } from './config.js';
import { HttpError } from './google.js';

const API = 'https://api.anthropic.com/v1/messages';

export async function claude({ prompt, model, docs = [], images = [], maxTokens = 8000 }){
  if (!cfg.anthropicKey) throw new HttpError(503, 'no_ai', 'ANTHROPIC_API_KEY is not set');
  const content = [
    ...docs.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.data } })),
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
    { type: 'text', text: prompt }
  ];
  const body = JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
  for (let attempt = 0; ; attempt++){
    let r;
    try {
      r = await fetch(API, { method: 'POST', headers: { 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body });
    } catch (e){
      if (attempt < 2){ await wait(1500 * (attempt + 1)); continue; }
      throw new HttpError(502, 'ai_error', 'network error: ' + e.message);
    }
    if (r.ok){
      const j = await r.json();
      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return { text, truncated: j.stop_reason === 'max_tokens' };
    }
    const retryable = r.status === 429 || r.status === 529 || r.status >= 500;
    if (retryable && attempt < 3){
      const ra = Number(r.headers.get('retry-after'));
      await wait(ra > 0 ? Math.min(ra, 60) * 1000 : 2000 * 2 ** attempt + Math.random() * 1000);
      continue;
    }
    const t = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'ai_key', 'Anthropic rejected the API key');
    if (/credit balance/i.test(t)) throw new HttpError(402, 'ai_credit', 'Anthropic credit balance is too low');
    if (r.status === 429) throw new HttpError(429, 'rate_limited', 'Anthropic rate limit');
    if (r.status === 400 || r.status === 413) throw new HttpError(400, 'ai_bad_request', t.slice(0, 300));
    throw new HttpError(502, 'ai_error', `Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
}
const wait = ms => new Promise(res => setTimeout(res, ms));

// קורא JSON גם כשהמודל עוטף אותו בטקסט או בבלוק קוד
export function parseJson(text){
  const s = String(text || '').trim();
  const tries = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = Math.min(...['{', '['].map(c => s.indexOf(c)).filter(i => i >= 0));
  const b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (isFinite(a) && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries){ try { return JSON.parse(t); } catch {} }
  return undefined;
}

export function modelFor(tier){
  return tier === 'fast' ? cfg.models.fast : tier === 'best' ? cfg.models.best : cfg.models.main;
}
