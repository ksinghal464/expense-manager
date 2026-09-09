import { Env, HttpError } from './http';
import { now } from './db';

// -----------------------------------------------------------------------
// Google Drive backup, using OAuth to the *user's own* Google account
// (Authorization Code + refresh token), not a service account. D1 remains
// the live database; Drive only ever holds an independent backup copy.
// -----------------------------------------------------------------------

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FILE_NAME = 'expense-manager-backup.json';

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
  autoBackup: boolean;
}> {
  const refreshToken = await getSetting(env, 'drive_refresh_token');
  const lastBackupAt = await getSetting(env, 'drive_last_backup_at');
  const autoBackup = (await getSetting(env, 'drive_auto_backup')) === '1';
  return {
    configured: oauthConfigured(env),
    connected: Boolean(refreshToken),
    lastBackupAt,
    autoBackup,
  };
}

/** Build the Google consent-screen URL the browser should be sent to. */
export function driveAuthUrl(env: Env, url: URL): string {
  if (!oauthConfigured(env)) {
    throw new HttpError(
      503,
      'Google Drive is not configured (set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET secrets).'
    );
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(url),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Exchange the authorization code for tokens and persist the refresh token. */
export async function driveHandleCallback(env: Env, url: URL, code: string): Promise<void> {
  if (!oauthConfigured(env)) throw new HttpError(503, 'Google Drive is not configured.');
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
  await setSetting(env, 'drive_refresh_token', j.refresh_token);
}

export async function driveDisconnect(env: Env): Promise<void> {
  await deleteSetting(env, 'drive_refresh_token');
  await deleteSetting(env, 'drive_backup_file_id');
  await deleteSetting(env, 'drive_last_backup_at');
}

async function getAccessToken(env: Env): Promise<string> {
  const refreshToken = await getSetting(env, 'drive_refresh_token');
  if (!refreshToken) throw new HttpError(409, 'Google Drive is not connected yet.');
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
  if (!r.ok) throw new HttpError(502, `Drive token refresh failed (${r.status}).`);
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
    const boundary = 'exp_' + Math.random().toString(36).slice(2);
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
