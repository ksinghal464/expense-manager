import { Env, HttpError } from './http';
import { now } from './db';

// -----------------------------------------------------------------------
// Google Drive backup, using OAuth to the *user's own* Google account
// (Authorization Code + refresh token), not a service account. D1 remains
// the live database; Drive only ever holds an independent backup copy.
// -----------------------------------------------------------------------

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FILE_NAME = 'expense-manager-backup.json';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth round trip

type Row = Record<string, any>;

function oauthConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<Row>();
  return r ? r.value : null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  )
    .bind(key, value, now())
    .run();
}

async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
}

// ---- refresh-token encryption at rest -------------------------------------
// Encrypted with AES-GCM using a Worker secret (DRIVE_TOKEN_ENCRYPTION_KEY,
// a base64-encoded 32-byte key) so a raw D1 dump doesn't hand over a working
// Google Drive credential. Ciphertext is stored as `${ivB64}.${dataB64}`.

async function importKey(env: Env): Promise<CryptoKey> {
  const raw = env.DRIVE_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new HttpError(503, 'DRIVE_TOKEN_ENCRYPTION_KEY is not configured.');
  const keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function encryptToken(env: Env, plain: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}

async function decryptToken(env: Env, stored: string): Promise<string> {
  const [ivB64, dataB64] = stored.split('.');
  if (!ivB64 || !dataB64) throw new HttpError(500, 'Stored Drive token is malformed.');
  const key = await importKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) },
    key,
    fromB64(dataB64)
  );
  return new TextDecoder().decode(plain);
}

function redirectUri(url: URL): string {
  return `${url.protocol}//${url.host}/api/drive/callback`;
}

/** Whether Drive backup can be used at all (OAuth client configured on the Worker). */
export function driveConfigured(env: Env): boolean {
  return oauthConfigured(env);
}

/** Current connection/backup status for the UI. */
export async function driveStatus(env: Env): Promise<{
  configured: boolean;
  connected: boolean;
  lastBackupAt: string | null;
  lastBackupError: string | null;
  autoBackup: boolean;
}> {
  const refreshToken = await getSetting(env, 'drive_refresh_token');
  const lastBackupAt = await getSetting(env, 'drive_last_backup_at');
  const lastBackupError = await getSetting(env, 'drive_last_backup_error');
  const autoBackup = (await getSetting(env, 'drive_auto_backup')) === '1';
  return {
    configured: oauthConfigured(env),
    connected: Boolean(refreshToken),
    lastBackupAt,
    lastBackupError,
    autoBackup,
  };
}

/**
 * Build the Google consent-screen URL the browser should be sent to.
 * Generates a random, single-use `state` value bound to a short expiry and
 * persists it so the callback can detect a forged/replayed/missing state
 * (OAuth login-CSRF / account-linking protection).
 */
export async function driveAuthUrl(env: Env, url: URL): Promise<string> {
  if (!oauthConfigured(env)) {
    throw new HttpError(
      503,
      'Google Drive is not configured (set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET secrets).'
    );
  }
  const state = crypto.randomUUID();
  await setSetting(env, 'drive_oauth_state', state);
  await setSetting(env, 'drive_oauth_state_expires_at', String(Date.now() + STATE_TTL_MS));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(url),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Validate a callback's `state` against the one issued by driveAuthUrl, single-use. */
async function consumeState(env: Env, state: string | null): Promise<void> {
  const expected = await getSetting(env, 'drive_oauth_state');
  const expiresAtRaw = await getSetting(env, 'drive_oauth_state_expires_at');
  // Always invalidate immediately so a state value can never be reused.
  await deleteSetting(env, 'drive_oauth_state');
  await deleteSetting(env, 'drive_oauth_state_expires_at');
  if (!state || !expected || state !== expected) {
    throw new HttpError(400, 'Invalid or missing OAuth state. Please retry connecting.');
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    throw new HttpError(400, 'OAuth state expired. Please retry connecting.');
  }
}

/** Exchange the authorization code for tokens and persist the refresh token. */
export async function driveHandleCallback(
  env: Env,
  url: URL,
  code: string,
  state: string | null
): Promise<void> {
  if (!oauthConfigured(env)) throw new HttpError(503, 'Google Drive is not configured.');
  await consumeState(env, state);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(url),
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new HttpError(502, `Google token exchange failed (${r.status}). ${detail.slice(0, 200)}`);
  }
  const j = (await r.json()) as { refresh_token?: string; access_token?: string };
  if (!j.refresh_token) {
    // Google only returns a refresh_token the first time consent is granted
    // (or when prompt=consent forces a new one, as above). If it's missing
    // and we don't already have one stored, the connect flow must be retried.
    const existing = await getSetting(env, 'drive_refresh_token');
    if (!existing)
      throw new HttpError(502, 'Google did not return a refresh token. Please retry connecting.');
    return;
  }
  await setSetting(env, 'drive_refresh_token', await encryptToken(env, j.refresh_token));
}

export async function driveDisconnect(env: Env): Promise<void> {
  const encrypted = await getSetting(env, 'drive_refresh_token');
  if (encrypted) {
    try {
      const token = await decryptToken(env, encrypted);
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
    } catch (e) {
      // Best-effort: still clear the local credential even if Google's
      // revoke call fails or the token is undecryptable.
      console.error('drive: token revoke failed', e);
    }
  }
  await deleteSetting(env, 'drive_refresh_token');
  await deleteSetting(env, 'drive_backup_file_id');
  await deleteSetting(env, 'drive_last_backup_at');
  await deleteSetting(env, 'drive_last_backup_error');
}

async function getAccessToken(env: Env): Promise<string> {
  const encrypted = await getSetting(env, 'drive_refresh_token');
  if (!encrypted) throw new HttpError(409, 'Google Drive is not connected yet.');
  const refreshToken = await decryptToken(env, encrypted);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) {
      // invalid_grant and similar: the connection is dead, not transient.
      await deleteSetting(env, 'drive_refresh_token');
    }
    throw new HttpError(502, `Drive token refresh failed (${r.status}).`);
  }
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new HttpError(502, 'Drive token refresh returned no access token.');
  return j.access_token;
}

/** Upload the full backup JSON to the user's own Drive (creates the file once, then updates it). */
export async function driveBackup(
  env: Env,
  backup: unknown
): Promise<{ ok: boolean; fileId: string; backedUpAt: string }> {
  const token = await getAccessToken(env);
  const auth = { authorization: 'Bearer ' + token };
  const body = JSON.stringify(backup);
  let fileId = await getSetting(env, 'drive_backup_file_id');

  if (fileId) {
    const r = await fetch(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json; charset=utf-8' },
      body,
    });
    if (r.status === 404) {
      fileId = null; // file was removed on Drive; fall through to re-create it
    } else if (!r.ok) {
      throw new HttpError(502, `Drive upload failed (${r.status}).`);
    }
  }

  if (!fileId) {
    const boundary = 'exp_' + crypto.randomUUID().replace(/-/g, '');
    const meta = JSON.stringify({ name: BACKUP_FILE_NAME, mimeType: 'application/json' });
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await fetch(`${DRIVE_API}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { ...auth, 'content-type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    if (!r.ok) throw new HttpError(502, `Drive create failed (${r.status}).`);
    const j = (await r.json()) as { id?: string };
    if (!j.id) throw new HttpError(502, 'Drive create returned no file id.');
    fileId = j.id;
    await setSetting(env, 'drive_backup_file_id', fileId);
  }

  const backedUpAt = now();
  await setSetting(env, 'drive_last_backup_at', backedUpAt);
  await deleteSetting(env, 'drive_last_backup_error');
  return { ok: true, fileId, backedUpAt };
}

/** Download the full backup JSON currently stored on Drive. */
export async function driveRestore(env: Env): Promise<unknown> {
  const fileId = await getSetting(env, 'drive_backup_file_id');
  if (!fileId) throw new HttpError(404, 'No Drive backup found yet. Run "Backup now" first.');
  const token = await getAccessToken(env);
  const r = await fetch(`${DRIVE_API}/${fileId}?alt=media`, {
    headers: { authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new HttpError(502, `Drive download failed (${r.status}).`);
  return r.json();
}

export async function driveSetAutoBackup(env: Env, enabled: boolean): Promise<void> {
  await setSetting(env, 'drive_auto_backup', enabled ? '1' : '0');
}

/** Persist a durable failure reason for the last (auto or manual) backup attempt. */
export async function setDriveBackupError(env: Env, message: string): Promise<void> {
  await setSetting(env, 'drive_last_backup_error', message.slice(0, 500));
}

/**
 * HTML page returned by /api/drive/callback instead of a bare redirect, so
 * the OAuth round trip can be completed from a popup window (like a native
 * app's "Sign in with Google") without ever navigating the main app tab
 * away. If it detects a `window.opener` (i.e. it really is running in a
 * popup opened by the app), it hands the result back via postMessage and
 * closes itself; otherwise (popup blocked, or the connect link was opened
 * in the same tab) it falls back to the previous behavior of redirecting
 * the current tab back into the app.
 */
export function driveCallbackHtml(status: 'connected' | 'error', back: string): string {
  const safeBack = JSON.stringify(back);
  const safeStatus = JSON.stringify(status);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Google Drive</title></head>
<body>
<p>You can close this window.</p>
<script>
(function () {
  var payload = { source: 'expense-manager-drive-oauth', status: ${safeStatus} };
  try {
    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin);
      window.close();
      return;
    }
  } catch (e) {}
  window.location.replace(${safeBack});
})();
</script>
</body></html>`;
}
