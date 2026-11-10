// Body composition (Hume) — read from the "Hume body composition" Google Sheet.
//
// The Sheet is the source of truth for body comp: one row per monthly Hume progress
// report, each metric as a start/end pair for that report's period. Rows are added by a
// scheduled task that transcribes the report screenshots; this module only READS.
//
// Auth is a Google service account with Viewer access to that one Sheet. Done with
// node:crypto (an RS256-signed JWT exchanged for an access token) rather than the
// googleapis package, so the API stays dependency-free like the rest of api/.
//
// Columns are matched by HEADER TEXT, not position, so adding or reordering a column in
// the Sheet doesn't silently shift every value into the wrong field.
import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const MONTHLY_TAB = 'Monthly';
const TOTAL_TAB = '12-month total';

const UNIT_SUFFIX = { kg: 'kg', '%': 'pct', kcal: 'kcal', yrs: 'yrs', bpm: 'bpm' };

// The metrics worth charting and handing to the coach. Everything else is still in
// `reports` for anyone who wants it.
export const TREND_METRICS = [
  'weight_kg', 'body_fat_pct', 'body_fat_mass_kg', 'lean_mass_kg',
  'skeletal_muscle_mass_kg', 'visceral_fat_index', 'bmr_kcal',
];

// ---------------------------------------------------------------- credentials

// Vercel env vars arrive in whichever shape they were pasted: the JSON-escaped form with
// literal "\n", real newlines, or wrapped in the quotes copied from the key file.
// All three must yield the same PEM.
export function normalizePrivateKey(raw) {
  if (!raw) return '';
  let key = String(raw).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim() + '\n';
}

const b64url = buf => Buffer.from(buf).toString('base64url');

export function buildServiceAccountJwt(email, privateKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: email, scope: SHEETS_SCOPE, aud: TOKEN_URL,
    iat: nowSeconds, exp: nowSeconds + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey);
  } catch (err) {
    // The commonest setup fault, so say which variable to look at.
    throw new Error(`GOOGLE_PRIVATE_KEY could not be read as a private key (${err.message}). Re-paste the "private_key" value from the service account JSON.`);
  }
  return `${unsigned}.${b64url(signature)}`;
}

async function getAccessToken(email, privateKey) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildServiceAccountJwt(email, privateKey),
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    throw new Error(`Google sign-in failed (${r.status}): ${body.error_description || body.error || 'no access token'}. Check GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.`);
  }
  return body.access_token;
}

async function fetchTabs(sheetId, token) {
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  params.append('ranges', `'${MONTHLY_TAB}'!A:AZ`);
  params.append('ranges', `'${TOTAL_TAB}'!A:AZ`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchGet?${params}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const hint = r.status === 403 || r.status === 404
      ? ' Is the Sheet shared with the service account, and is HUME_SHEET_ID right?' : '';
    throw new Error(`Sheets read failed (${r.status}): ${body.error?.message || 'unknown error'}.${hint}`);
  }
  const [monthly, total] = body.valueRanges || [];
  return { monthly: monthly?.values || [], total: total?.values || [] };
}

// ---------------------------------------------------------------- shaping (pure)

// "Skeletal muscle mass end (kg)" → { key: 'skeletal_muscle_mass_kg', side: 'end' }
// Headers that aren't a start/end pair ("Month", "Source file", "Health score (as shown)")
// map to a plain key.
export function parseHeader(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(.*?)\s+(start|end)(?:\s*\(([^)]*)\))?$/i);
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (m) {
    const unit = UNIT_SUFFIX[(m[3] || '').trim().toLowerCase()];
    return { key: unit ? `${slug(m[1])}_${unit}` : slug(m[1]), side: m[2].toLowerCase() };
  }
  const plain = slug(t.replace(/\(.*\)/, ''));
  return { key: plain === 'period' ? 'month' : plain, side: null };
}

const toNum = v => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// [[headers...], [cells...], ...] → [{ month, source_file, health_score, metrics: { key: {start,end} } }]
export function parseRows(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const cols = values[0].map(parseHeader);
  const out = [];
  for (const row of values.slice(1)) {
    if (!row || row.every(c => c === '' || c == null)) continue;
    const rec = { month: null, source_file: null, health_score: null, metrics: {} };
    cols.forEach((col, i) => {
      const cell = row[i];
      if (col.side) {
        (rec.metrics[col.key] ||= { start: null, end: null })[col.side] = toNum(cell);
      } else if (col.key === 'month') {
        rec.month = cell === '' || cell == null ? null : String(cell).trim();
      } else if (col.key === 'source_file') {
        rec.source_file = cell ? String(cell) : null;
      } else if (col.key === 'health_score') {
        rec.health_score = toNum(cell);
      }
    });
    if (rec.month) out.push(rec);
  }
  return out;
}

const monthIndex = ym => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  return m ? Number(m[1]) * 12 + (Number(m[2]) - 1) : null;
};
const fromIndex = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

// Calendar months between the first and last report that have no report.
export function missingMonths(reports) {
  const idx = reports.map(r => monthIndex(r.month)).filter(i => i != null).sort((a, b) => a - b);
  if (idx.length < 2) return [];
  const have = new Set(idx);
  const gaps = [];
  for (let i = idx[0] + 1; i < idx[idx.length - 1]; i++) if (!have.has(i)) gaps.push(fromIndex(i));
  return gaps;
}

const round1 = n => (n == null ? null : Math.round(n * 10) / 10);

export function buildBodyCompFromValues({ monthly, total }) {
  const reports = parseRows(monthly)
    .filter(r => monthIndex(r.month) != null)
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
  if (!reports.length) return { error: 'The body composition Sheet has no monthly rows yet.' };

  const first = reports[0];
  const latest = reports[reports.length - 1];

  // One point per report, using the END of its period: that's the reading the report
  // was written about, and the next report's start is normally the same weigh-in.
  const trend = reports.map(r => {
    const p = { month: r.month };
    for (const k of TREND_METRICS) p[k] = r.metrics[k]?.end ?? null;
    return p;
  });

  const change = {};
  for (const k of TREND_METRICS) {
    const a = first.metrics[k]?.start ?? first.metrics[k]?.end;
    const b = latest.metrics[k]?.end;
    change[k] = a != null && b != null ? round1(b - a) : null;
  }

  const latestValues = {};
  for (const [k, v] of Object.entries(latest.metrics)) latestValues[k] = v.end;

  return {
    source: 'Hume Body Pod monthly progress reports (Google Sheet)',
    first_month: first.month,
    latest_month: latest.month,
    latest: latestValues,
    change_since_first: change,
    missing_months: missingMonths(reports),
    trend,
    reports,
    summaries: parseRows(total),
  };
}

// ---------------------------------------------------------------- entry point

export async function buildBodyCompSummary({ email, privateKey, sheetId }) {
  const token = await getAccessToken(email, normalizePrivateKey(privateKey));
  return buildBodyCompFromValues(await fetchTabs(sheetId, token));
}
