// Vercel serverless function — connect an athlete's own Strava or WHOOP account.
// All athletes share the project's ONE Strava app and ONE WHOOP app (the env-var
// client id/secret); each athlete authorizes it against their own account, and the
// resulting refresh token is stored per-user in KV.
//
//   POST { provider: 'strava'|'whoop' }  (authed via x-app-password, like every fn)
//     → { url } — the provider's authorize page. A one-time nonce is stored in KV
//       so the callback can map the code back to the user without trusting the URL
//       (this is also the CSRF protection: unknown state → rejected).
//   GET ?state=<nonce>&code=<code>       (the provider redirecting the browser back)
//     → exchanges the code, stores the refresh token, 302s back to the app with
//       ?connected=<provider> (or ?connect_error=<msg> on failure).
//
// Register this callback URL with BOTH providers (Settings → redirect/callback URL):
//   https://<your-app>.vercel.app/api/oauth
// KV is required — without it there is nowhere to keep per-user tokens.
import crypto from 'node:crypto';
import { requireUser } from './_auth.js';
import { kvGet, kvSet, kvDel } from './_kv.js';

const NONCE_TTL_S = 600; // athlete has 10 minutes to finish the provider's consent screen

const PROVIDERS = {
  strava: {
    authorizeUrl: 'https://www.strava.com/oauth/authorize',
    tokenUrl: 'https://www.strava.com/oauth/token',
    scope: 'activity:read_all',
    clientId: () => process.env.STRAVA_CLIENT_ID,
    clientSecret: () => process.env.STRAVA_CLIENT_SECRET,
    tokenKey: (userId) => userId === 'master' ? 'strava_refresh_token' : `strava_tokens:${userId}`,
    extraAuthParams: { approval_prompt: 'auto' },
  },
  whoop: {
    authorizeUrl: 'https://api.prod.whoop.com/oauth/oauth2/auth',
    tokenUrl: 'https://api.prod.whoop.com/oauth/oauth2/token',
    scope: 'read:profile read:recovery read:sleep read:workout offline',
    clientId: () => process.env.WHOOP_CLIENT_ID,
    clientSecret: () => process.env.WHOOP_CLIENT_SECRET,
    tokenKey: (userId) => userId === 'master' ? 'whoop_refresh_token' : `whoop_tokens:${userId}`,
    extraAuthParams: {},
  },
};

function callbackUrl(req) {
  // Vercel terminates TLS in front of the function, so the public URL is always https.
  return `https://${req.headers.host}/api/oauth`;
}

async function startConnect(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const provider = PROVIDERS[req.body?.provider];
  if (!provider) { res.status(400).json({ error: "provider must be 'strava' or 'whoop'." }); return; }
  if (!provider.clientId() || !provider.clientSecret()) {
    res.status(200).json({ error: `Server missing ${req.body.provider.toUpperCase()} client credentials.` });
    return;
  }
  if (!process.env.KV_REST_API_URL) {
    res.status(200).json({ error: 'Connecting accounts needs the KV store — link Upstash Redis to the Vercel project first.' });
    return;
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  await kvSet(`oauth_state:${nonce}`, { userId: user.id, provider: req.body.provider }, { ex: NONCE_TTL_S });

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', provider.clientId());
  url.searchParams.set('redirect_uri', callbackUrl(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', nonce);
  for (const [k, v] of Object.entries(provider.extraAuthParams)) url.searchParams.set(k, v);

  res.status(200).json({ url: url.toString() });
}

function bounce(res, query) {
  res.writeHead(302, { Location: `/?${query}` });
  res.end();
}

async function finishConnect(req, res) {
  const { state, code, error } = req.query || {};
  if (error) { bounce(res, `connect_error=${encodeURIComponent(error)}`); return; }
  if (!state || !code) { bounce(res, 'connect_error=missing%20state%20or%20code'); return; }

  const pending = await kvGet(`oauth_state:${state}`);
  if (!pending?.userId || !PROVIDERS[pending.provider]) {
    bounce(res, 'connect_error=expired%20or%20unknown%20request%20—%20try%20again');
    return;
  }
  await kvDel(`oauth_state:${state}`); // one-time use

  const provider = PROVIDERS[pending.provider];
  try {
    const r = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: provider.clientId(),
        client_secret: provider.clientSecret(),
        redirect_uri: callbackUrl(req), // WHOOP requires an exact match with the authorize leg
      }),
    });
    if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${(await r.text()).slice(0, 150)}`);
    const tok = await r.json();
    if (!tok.refresh_token) throw new Error('provider returned no refresh token');

    // Master's keys store the bare token (legacy shape the data fns expect);
    // member keys store an object.
    const key = provider.tokenKey(pending.userId);
    await kvSet(key, pending.userId === 'master' ? tok.refresh_token : { refresh_token: tok.refresh_token });

    bounce(res, `connected=${pending.provider}`);
  } catch (err) {
    bounce(res, `connect_error=${encodeURIComponent(err?.message || String(err))}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') { await startConnect(req, res); return; }
    if (req.method === 'GET') { await finishConnect(req, res); return; }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(200).json({ error: err?.message || String(err) });
  }
}
