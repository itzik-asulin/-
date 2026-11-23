// הגדרות השרת. כל הערכים מגיעים ממשתני סביבה (ב-Render: Environment).
const env = process.env;

const port = Number(env.PORT) || 3000;
const baseUrl = (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');

export const cfg = {
  port,
  baseUrl,
  production: baseUrl.startsWith('https://'),
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
  allowedEmails: (env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  sessionSecret: env.SESSION_SECRET || '',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  models: {
    fast: env.AI_MODEL_FAST || 'claude-haiku-5-5',
    main: env.AI_MODEL || 'claude-sonnet-5-5',
    best: env.AI_MODEL_BEST || env.AI_MODEL || 'claude-sonnet-5-5'
  },
  databaseUrl: env.DATABASE_URL || '',
  dataDir: env.DATA_DIR || './data'
};

// מה חסר כדי שהאתר יעבוד. מוצג במסך הכניסה כדי שיהיה ברור מה להשלים.
export function missingConfig(){
  const m = [];
  if (!cfg.googleClientId) m.push('GOOGLE_CLIENT_ID');
  if (!cfg.googleClientSecret) m.push('GOOGLE_CLIENT_SECRET');
  if (!cfg.allowedEmails.length) m.push('ALLOWED_EMAILS');
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 24) m.push('SESSION_SECRET');
  if (!cfg.anthropicKey) m.push('ANTHROPIC_API_KEY');
  if (!cfg.databaseUrl && cfg.production) m.push('DATABASE_URL');
  return m;
}
