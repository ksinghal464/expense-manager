# Cloudflare setup

1. Create a Cloudflare account using your own email/Google account.
2. In the Cloudflare dashboard open **Storage & databases → D1 SQL Database**.
3. Create the database named `expense-manager`.
4. Keep the database ID private only in the sense that it identifies the database; never share account passwords or API tokens.
5. The Worker uses the D1 binding `DB`, exposed to code as `env.DB`.
6. The GitHub repository is intended to be connected to Cloudflare Builds for automatic deployment.
7. Database schema changes are kept in `migrations/` and should be applied through Wrangler/Cloudflare deployment tooling.

For the first deployment, do not manually create tables with ad-hoc SQL. Run the versioned migration so the Git repository remains the source of truth.

## Restricting access with a password (free, no third-party login)

This is a personal, single-user app with no per-user accounts, so the Worker
must not be left open to the public internet. Access is gated by a single
app password — no Cloudflare Access, no identity provider, and no billing or
credit-card requirement of any kind.

1. Pick a strong password and set it as a secret:
   ```bash
   wrangler secret put APP_PASSWORD
   ```
2. That's it. Visiting the app now shows a password prompt (`src/client/Login.tsx`).
   A successful login sets a signed, HttpOnly session cookie (30 days) —
   nothing is stored server-side, so there's no session table to manage.
   The signing key is derived from `APP_PASSWORD` itself, so changing the
   password immediately invalidates every previously-issued session.
3. `/api/health`, `/api/drive/connect`, and `/api/drive/callback` are
   intentionally exempt from the password check (health checks need to work
   unauthenticated; the Drive connect/callback pair needs to work when
   opened as a popup window, which doesn't reliably carry the session
   cookie on that specific top-level navigation in every browser). Note this
   means anyone with the URL can initiate/redirect the Google Drive linking
   flow without the app password — low risk for a personal, unpublicized
   deployment, but worth knowing.
4. If `APP_PASSWORD` is ever unset, the Worker fails closed (503) rather than
   silently allowing every request through.

## Google Drive OAuth secrets

```bash
wrangler secret put GOOGLE_OAUTH_CLIENT_ID
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
wrangler secret put DRIVE_TOKEN_ENCRYPTION_KEY   # random 32-byte base64 key, e.g. `openssl rand -base64 32`
wrangler secret put APP_PASSWORD
```

Register the exact callback URL on the OAuth client in Google Cloud Console:
`https://<your-worker-hostname>/api/drive/callback`.
