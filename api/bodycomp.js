// Vercel serverless function — body composition from the Hume Google Sheet.
//
// Reads the "Hume body composition" Sheet as a Google service account (Viewer on that one
// Sheet only) and returns the monthly series plus a latest/change summary. The Sheet is
// filled by a scheduled task that transcribes each Hume report screenshot; nothing here
// writes to it.
//
// Response shaping lives in shared/bodycomp-core.js — this file owns ONLY credentials
// and the HTTP surface, same split as api/intervals.js.
//
// Env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, HUME_SHEET_ID.
import { requireAuth } from './_auth.js';
import { cached } from './_kv.js';
import { buildBodyCompSummary } from '../shared/bodycomp-core.js';

// Reports arrive about once a month and the Sheet is updated twice a month at most, so
// an hour is plenty fresh. ?fresh=1 bypasses it after adding a row by hand.
const SUMMARY_TTL_S = 3600;

export async function getBodyCompSummary(force = false) {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.HUME_SHEET_ID;
  if (!email || !privateKey || !sheetId) {
    throw new Error('Missing body composition config — set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY and HUME_SHEET_ID.');
  }
  return cached('bodycomp_sum', SUMMARY_TTL_S, () => buildBodyCompSummary({ email, privateKey, sheetId }), force);
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await getBodyCompSummary(req.query?.fresh === '1'));
  } catch (err) {
    // { error } over HTTP 200 so the app's existing error path surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
