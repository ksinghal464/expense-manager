import { Env, HttpError } from './http';

// -----------------------------------------------------------------------
// Free, built-in password gate — no Cloudflare Access, no third-party
// identity provider, no billing/credit-card requirement of any kind. A
// single Worker secret (APP_PASSWORD) is the only thing needed. A
// successful login sets a signed, HttpOnly session cookie; nothing is
// stored server-side (no session table), so there's nothing to clean up
// and no D1 dependency for auth itself.
//
// The signing key is derived from APP_PASSWORD itself (SHA-256 of the
// password + a fixed label), so no second secret is required. Changing
// APP_PASSWORD automatically invalidates every previously-issued cookie.
// -----------------------------------------------------------------------

const COOKIE_NAME = 'em_session';
const SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days

const BYPASS_PATHS = new Set([
  '/api/drive/connect',
  '/api/drive/callback',
  '/api/health',
  '/api/login',
]);

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`${env.APP_PASSWORD}:em-session-key`)
  );
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function createSessionToken(env: Env): Promise<string> {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_MS });
  const payloadB64 = b64url(new TextEncoder().encode(payload));
  const key = await signingKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64url(new Uint8Array(sig))}`;
}

async function verifySessionToken(env: Env, token: string): Promise<boolean> {
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return false;
  try {
    const key = await signingKey(env);
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch {
    return false;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/** Constant-time-ish string compare (best-effort; fine for a personal app). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Throws if the request doesn't carry a valid session cookie. */
export async function requireAuth(request: Request, url: URL, env: Env): Promise<void> {
  if (BYPASS_PATHS.has(url.pathname)) return;
  if (!env.APP_PASSWORD) {
    // Not configured: fail closed rather than silently allowing everyone
    // through, so a missing secret can't accidentally leave the API open.
    throw new HttpError(503, 'This app is not configured yet (missing APP_PASSWORD secret).');
  }
  const token = readCookie(request, COOKIE_NAME);
  if (!token || !(await verifySessionToken(env, token))) {
    throw new HttpError(401, 'Not signed in.');
  }
}

/** POST /api/login handler: checks the password, issues the session cookie. */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.APP_PASSWORD) {
    throw new HttpError(503, 'This app is not configured yet (missing APP_PASSWORD secret).');
  }
  let password = '';
  try {
    const body = (await request.json()) as { password?: string };
    password = String(body?.password || '');
  } catch {
    throw new HttpError(400, 'Body must be JSON with a "password" field.');
  }
  if (!password || !safeEqual(password, env.APP_PASSWORD)) {
    throw new HttpError(401, 'Incorrect password.');
  }
  const token = await createSessionToken(env);
  const maxAge = Math.floor(SESSION_MS / 1000);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

/** POST /api/logout handler: clears the session cookie. */
export function handleLogout(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
