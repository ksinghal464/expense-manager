import { describe, it, expect } from 'vitest';
import { requireAuth, handleLogin, handleLogout } from '../worker/auth';
import { HttpError, type Env } from '../worker/http';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env['DB'],
    ASSETS: {} as unknown as Env['ASSETS'],
    ...overrides,
  };
}

function req(headers: Record<string, string> = {}): { request: Request; url: URL } {
  const url = new URL('https://expense-manager.example.com/api/transactions');
  return { request: new Request(url, { headers }), url };
}

function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

describe('requireAuth', () => {
  it('fails closed when APP_PASSWORD is not configured', async () => {
    const env = makeEnv();
    const { request, url } = req();
    await expect(requireAuth(request, url, env)).rejects.toThrow(HttpError);
  });

  it('rejects a request with no session cookie', async () => {
    const env = makeEnv({ APP_PASSWORD: 'hunter2' });
    const { request, url } = req();
    await expect(requireAuth(request, url, env)).rejects.toThrow(HttpError);
  });

  it('rejects a forged/garbage cookie', async () => {
    const env = makeEnv({ APP_PASSWORD: 'hunter2' });
    const { request, url } = req({ cookie: 'em_session=garbage.notasignature' });
    await expect(requireAuth(request, url, env)).rejects.toThrow(HttpError);
  });

  it('accepts the cookie issued by a successful login', async () => {
    const env = makeEnv({ APP_PASSWORD: 'hunter2' });
    const loginRes = await handleLogin(
      new Request('https://x/api/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'hunter2' }),
      }),
      env
    );
    expect(loginRes.status).toBe(200);
    const cookie = cookieFromResponse(loginRes);
    const { request, url } = req({ cookie });
    await expect(requireAuth(request, url, env)).resolves.not.toThrow();
  });

  it('rejects an incorrect password at login', async () => {
    const env = makeEnv({ APP_PASSWORD: 'hunter2' });
    await expect(
      handleLogin(
        new Request('https://x/api/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'wrong' }),
        }),
        env
      )
    ).rejects.toThrow(HttpError);
  });

  it('a cookie signed with a different password is rejected', async () => {
    const envA = makeEnv({ APP_PASSWORD: 'hunter2' });
    const envB = makeEnv({ APP_PASSWORD: 'different' });
    const loginRes = await handleLogin(
      new Request('https://x/api/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'hunter2' }),
      }),
      envA
    );
    const cookie = cookieFromResponse(loginRes);
    const { request, url } = req({ cookie });
    await expect(requireAuth(request, url, envB)).rejects.toThrow(HttpError);
  });

  it('logout clears the cookie', () => {
    const res = handleLogout();
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('always allows the Drive OAuth callback path, even unauthenticated', async () => {
    const env = makeEnv({ APP_PASSWORD: 'hunter2' });
    const url = new URL('https://expense-manager.example.com/api/drive/callback?code=abc');
    const request = new Request(url);
    await expect(requireAuth(request, url, env)).resolves.not.toThrow();
  });

  it('always allows the Drive OAuth connect path, even unauthenticated (popup navigations do not reliably carry the session cookie)', async () => {
    const env = makeEnv({ APP_PASSWORD: 'hunter2' });
    const url = new URL('https://expense-manager.example.com/api/drive/connect');
    const request = new Request(url);
    await expect(requireAuth(request, url, env)).resolves.not.toThrow();
  });

  it('always allows the health check path', async () => {
    const env = makeEnv({ APP_PASSWORD: 'hunter2' });
    const url = new URL('https://expense-manager.example.com/api/health');
    const request = new Request(url);
    await expect(requireAuth(request, url, env)).resolves.not.toThrow();
  });
});
