import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker';
import { handleLogin } from '../worker/auth';
import type { Env } from '../worker/http';
import { sqliteEnv } from './sqliteEnv';

const ORIGIN = 'https://expense-manager.example.com';
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const OWNER = 'owner@gmail.com';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

let db: DatabaseSync;
let env: Env;
let cookie: string;
/** Next response from Google's token endpoint; tests overwrite parts of it. */
let tokenResponse: { status: number; body: Record<string, unknown> };
let revoked: string[];

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}

function grant(claims: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      access_token: 'access',
      refresh_token: 'new-refresh',
      scope: `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE}`,
      id_token: idToken({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        email: 'Owner@Gmail.com',
        email_verified: true,
        ...claims,
      }),
      ...extra,
    },
  };
}

function setting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

async function call(path: string, method = 'GET', withSession = true): Promise<Response> {
  const headers: Record<string, string> = withSession ? { cookie } : {};
  if (method === 'POST') headers['content-type'] = 'application/json';
  return worker.fetch(
    new Request(ORIGIN + path, { method, headers, body: method === 'POST' ? '{}' : undefined }),
    env
  );
}

/** Start a connection as the logged-in owner; returns the Google consent URL. */
async function connect(): Promise<URL> {
  const r = await call('/api/drive/connect', 'POST');
  expect(r.status).toBe(200);
  return new URL(((await r.json()) as { url: string }).url);
}

async function callback(state: string | null): Promise<string> {
  const qs = new URLSearchParams({ code: 'auth-code', ...(state ? { state } : {}) });
  const r = await call(`/api/drive/callback?${qs}`, 'GET', false);
  return r.text();
}

beforeEach(async () => {
  ({ db, env } = sqliteEnv({
    APP_PASSWORD: 'pw',
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    DRIVE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DRIVE_ALLOWED_EMAIL: OWNER,
  }));
  const login = await handleLogin(
    new Request(ORIGIN + '/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'pw' }),
    }),
    env
  );
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  tokenResponse = grant();
  revoked = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      revoked.push(new URLSearchParams(String(init?.body)).get('token') || '');
      return new Response('{}');
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json(tokenResponse.body, { status: tokenResponse.status });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('starting a Drive connection', () => {
  it('requires the app session', async () => {
    const r = await call('/api/drive/connect', 'POST', false);
    expect(r.status).toBe(401);
    expect(setting('drive_oauth_state')).toBeNull();
  });

  it('is no longer reachable as an unauthenticated GET redirect', async () => {
    expect((await call('/api/drive/connect', 'GET', false)).status).toBe(401);
  });

  it('returns a consent URL with Drive + email scopes and the owner as login hint', async () => {
    const url = await connect();
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(['openid', 'email', DRIVE]);
    expect(url.searchParams.get('login_hint')).toBe(OWNER);
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/drive/callback`);
    expect(url.searchParams.get('state')).toBe(setting('drive_oauth_state'));
  });

  it('is refused until DRIVE_ALLOWED_EMAIL is set', async () => {
    env.DRIVE_ALLOWED_EMAIL = '';
    const r = await call('/api/drive/connect', 'POST');
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toContain('DRIVE_ALLOWED_EMAIL');
  });
});

describe('Drive callback', () => {
  it('connects the owner account and clears the old disconnect record', async () => {
    db.prepare(
      "INSERT INTO settings (key,value,updated_at) VALUES ('drive_disconnected_at','x','x'), ('drive_disconnect_reason','expired','x'), ('drive_last_backup_error','old','x')"
    ).run();
    const state = (await connect()).searchParams.get('state');
    expect(await callback(state)).toContain('"connected"');
    expect(setting('drive_refresh_token')).not.toBeNull();
    expect(setting('drive_refresh_token')).not.toContain('new-refresh'); // stored encrypted
    expect(setting('drive_disconnected_at')).toBeNull();
    expect(setting('drive_disconnect_reason')).toBeNull();
    expect(setting('drive_last_backup_error')).toBeNull();
    expect(setting('drive_oauth_state')).toBeNull(); // single use
    expect(await callback(state)).toContain('"error"');
  });

  it('ignores a forged state without cancelling the owner’s pending connection', async () => {
    const state = (await connect()).searchParams.get('state');
    const html = await callback('forged');
    expect(html).toContain('not started from your logged-in app');
    expect(setting('drive_refresh_token')).toBeNull();
    expect(await callback(state)).toContain('"connected"');
  });

  it('rejects a missing or expired state', async () => {
    expect(await callback(null)).toContain('"error"');
    const state = (await connect()).searchParams.get('state');
    db.prepare("UPDATE settings SET value='1' WHERE key='drive_oauth_state_expires_at'").run();
    expect(await callback(state)).toContain('took too long');
    expect(setting('drive_refresh_token')).toBeNull();
  });

  it.each([
    ['another account', grant({ email: 'someone@gmail.com' }), 'not allowed'],
    ['an unverified email', grant({ email_verified: false }), 'not allowed'],
    ['a token for another app', grant({ aud: 'other-client' }), 'did not confirm'],
    ['an untrusted issuer', grant({ iss: 'https://evil.example' }), 'did not confirm'],
    ['an expired ID token', grant({ exp: 1 }), 'did not confirm'],
    ['no ID token', grant({}, { id_token: undefined }), 'did not confirm'],
    ['the Drive permission unticked', grant({}, { scope: 'openid email' }), 'was not granted'],
  ])('rejects %s, revokes it, and keeps the existing connection', async (_, response, msg) => {
    db.prepare(
      "INSERT INTO settings (key,value,updated_at) VALUES ('drive_refresh_token','existing','x')"
    ).run();
    tokenResponse = response;
    const html = await callback((await connect()).searchParams.get('state'));
    expect(html).toContain('"error"');
    expect(html).toContain(msg);
    expect(setting('drive_refresh_token')).toBe('existing');
    expect(revoked).toEqual(['new-refresh']);
  });

  it('escapes the message so it cannot break out of the script tag', async () => {
    tokenResponse = { status: 400, body: { error: '</script><script>alert(1)</script>' } };
    const html = await callback((await connect()).searchParams.get('state'));
    expect(html).not.toContain('</script><script>');
  });
});

describe('Drive disconnects', () => {
  beforeEach(async () => {
    await callback((await connect()).searchParams.get('state'));
    db.prepare(
      "INSERT INTO settings (key,value,updated_at) VALUES ('drive_last_backup_at','2026-09-17T00:30:38.774Z','x')"
    ).run();
  });

  it('drops the sign-in only when Google says it is expired or revoked', async () => {
    tokenResponse = { status: 400, body: { error: 'invalid_grant' } };
    expect((await call('/api/drive/backup', 'POST')).status).toBe(502);
    expect(setting('drive_refresh_token')).toBeNull();
    expect(setting('drive_disconnect_reason')).toBe('expired');
    const status = (await (await call('/api/drive/status')).json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      connected: false,
      disconnectReason: 'expired',
      lastBackupAt: '2026-09-17T00:30:38.774Z',
    });
    expect(status.disconnectedAt).toBeTruthy();
  });

  it.each([
    [401, 'invalid_client'],
    [500, 'internal_failure'],
  ])('keeps the sign-in for a %s %s error', async (code, error) => {
    tokenResponse = { status: code, body: { error } };
    expect((await call('/api/drive/backup', 'POST')).status).toBe(502);
    expect(setting('drive_refresh_token')).not.toBeNull();
    expect(setting('drive_disconnect_reason')).toBeNull();
    expect(setting('drive_last_backup_error')).toContain(error);
  });

  it('records a manual disconnect, revokes the token and keeps the last backup date', async () => {
    expect((await call('/api/drive/disconnect', 'POST')).status).toBe(200);
    expect(revoked).toEqual(['new-refresh']);
    expect(setting('drive_refresh_token')).toBeNull();
    expect(setting('drive_disconnect_reason')).toBe('manual');
    expect(setting('drive_last_backup_at')).toBe('2026-09-17T00:30:38.774Z');
  });
});
