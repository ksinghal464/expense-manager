import { Env, HttpError } from './http';

// -----------------------------------------------------------------------
// Defense-in-depth identity check. Cloudflare Access is expected to sit in
// front of this Worker and require login before any request reaches it,
// injecting `Cf-Access-Authenticated-User-Email` once the visitor is
// authenticated. This check makes sure the Worker itself refuses to serve
// data if that header is ever missing or doesn't match the configured
// owner — e.g. if Access is misconfigured, disabled, or bypassed.
//
// The Drive OAuth callback path is intentionally exempt: it's excluded from
// the Access policy (see docs/cloudflare-setup.md) because Google's redirect
// lands there as part of a flow the owner already started from an
// authenticated session.
// -----------------------------------------------------------------------

const BYPASS_PATHS = new Set(['/api/drive/callback', '/api/health']);

export function requireAccess(request: Request, url: URL, env: Env): void {
  if (BYPASS_PATHS.has(url.pathname)) return;
  if (!env.ALLOWED_EMAIL) {
    // Not configured: fail closed rather than silently allowing everyone
    // through, so a missing secret can't accidentally leave the API open.
    throw new HttpError(503, 'Access control is not configured on this deployment.');
  }
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!email || email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
    throw new HttpError(403, 'Forbidden');
  }
}
