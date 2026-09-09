import { describe, it, expect } from 'vitest';
import { requireAccess } from '../worker/access';
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

describe('requireAccess', () => {
  it('fails closed when ALLOWED_EMAIL is not configured', () => {
    const env = makeEnv();
    const { request, url } = req();
    expect(() => requireAccess(request, url, env)).toThrow(HttpError);
  });

  it('rejects a request with no Access identity header', () => {
    const env = makeEnv({ ALLOWED_EMAIL: 'owner@example.com' });
    const { request, url } = req();
    expect(() => requireAccess(request, url, env)).toThrow(HttpError);
  });

  it('rejects a request from a different authenticated email', () => {
    const env = makeEnv({ ALLOWED_EMAIL: 'owner@example.com' });
    const { request, url } = req({ 'Cf-Access-Authenticated-User-Email': 'attacker@evil.com' });
    expect(() => requireAccess(request, url, env)).toThrow(HttpError);
  });

  it('allows the configured owner email (case-insensitive)', () => {
    const env = makeEnv({ ALLOWED_EMAIL: 'Owner@Example.com' });
    const { request, url } = req({ 'Cf-Access-Authenticated-User-Email': 'owner@example.com' });
    expect(() => requireAccess(request, url, env)).not.toThrow();
  });

  it('always allows the Drive OAuth callback path, even unauthenticated', () => {
    const env = makeEnv({ ALLOWED_EMAIL: 'owner@example.com' });
    const url = new URL('https://expense-manager.example.com/api/drive/callback?code=abc');
    const request = new Request(url);
    expect(() => requireAccess(request, url, env)).not.toThrow();
  });

  it('always allows the health check path', () => {
    const env = makeEnv({ ALLOWED_EMAIL: 'owner@example.com' });
    const url = new URL('https://expense-manager.example.com/api/health');
    const request = new Request(url);
    expect(() => requireAccess(request, url, env)).not.toThrow();
  });
});
