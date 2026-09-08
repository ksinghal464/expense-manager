import { Env, HttpError } from './http';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(sa: any): Promise<string> {
  const pem: string = sa.private_key || '';
  const b64 = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    enc.encode(JSON.stringify({ iss: sa.client_email, scope: SCOPES.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600 })),
  );
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(header + '.' + payload))));
  return `${header}.${payload}.${sig}`;
}

async function getToken(sa: any): Promise<string> {
  const jwt = await signJwt(sa);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok) throw new HttpError(502, `Drive token exchange failed (${r.status}).`);
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new HttpError(502, 'Drive token exchange returned no token.');
  return j.access_token;
}

/** Upload the backup JSON to Google Drive (service account). Creates the file if no id is configured. */
export async function driveSync(env: Env, backup: unknown): Promise<{ ok: boolean; fileId: string; url?: string }> {
  if (!env.GOOGLE_DRIVE_SA_KEY) {
    throw new HttpError(503, 'Google Drive is not configured (set the GOOGLE_DRIVE_SA_KEY secret).');
  }
  let sa: any;
  try {
    sa = JSON.parse(env.GOOGLE_DRIVE_SA_KEY);
  } catch {
    throw new HttpError(500, 'GOOGLE_DRIVE_SA_KEY is not valid JSON.');
  }
  const token = await getToken(sa);
  const body = JSON.stringify(backup);
  const auth = { authorization: 'Bearer ' + token };

  if (env.DRIVE_BACKUP_FILE_ID) {
    const r = await fetch(`${DRIVE_API}/${env.DRIVE_BACKUP_FILE_ID}?uploadType=media&fields=id,webContentLink`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json; charset=utf-8' },
      body,
    });
    if (!r.ok) throw new HttpError(502, `Drive upload failed (${r.status}).`);
    const j = (await r.json()) as { id?: string; webContentLink?: string };
    return { ok: true, fileId: j.id || env.DRIVE_BACKUP_FILE_ID, url: j.webContentLink };
  }

  const boundary = 'exp_' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: 'expense-manager-backup.json', mimeType: 'application/json' });
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await fetch(`${DRIVE_API}?uploadType=multipart&fields=id,webContentLink`, {
    method: 'POST',
    headers: { ...auth, 'content-type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  if (!r.ok) throw new HttpError(502, `Drive create failed (${r.status}).`);
  const j = (await r.json()) as { id?: string; webContentLink?: string };
  return { ok: true, fileId: j.id || '', url: j.webContentLink };
}

export function driveConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_DRIVE_SA_KEY);
}
