# Cloudflare setup

1. Create a Cloudflare account using your own email/Google account.
2. In the Cloudflare dashboard open **Storage & databases → D1 SQL Database**.
3. Create the database named `expense-manager`.
4. Keep the database ID private only in the sense that it identifies the database; never share account passwords or API tokens.
5. The Worker uses the D1 binding `DB`, exposed to code as `env.DB`.
6. The GitHub repository is intended to be connected to Cloudflare Builds for automatic deployment.
7. Database schema changes are kept in `migrations/` and should be applied through Wrangler/Cloudflare deployment tooling.

For the first deployment, do not manually create tables with ad-hoc SQL. Run the versioned migration so the Git repository remains the source of truth.

## Restricting access with Cloudflare Access

This is a personal, single-user app with no application-level login, so the Worker
must not be left open to the public internet. Put it behind Cloudflare Access:

1. In the Cloudflare dashboard, open **Zero Trust → Access → Applications** and
   **Add an application** of type **Self-hosted**.
2. Set the application domain to the Worker's hostname (the `workers.dev` URL or
   your custom domain).
3. Add a policy that allows only your own email (via One-time PIN, Google, or
   GitHub login) — no public access.
4. Add a second, higher-priority **Bypass** policy scoped to the path
   `/api/drive/callback` only. Google's OAuth redirect lands on this path in
   your browser after you've already authenticated the Drive connection
   yourself; excluding it from Access avoids an extra login prompt breaking
   the redirect chain. Every other path stays behind the login policy.
5. As defense-in-depth, the Worker also checks the `Cf-Access-Authenticated-User-Email`
   header against the `ALLOWED_EMAIL` secret (see below) for every request except
   `/api/drive/callback`. This means even if Access is ever misconfigured or the
   raw Worker URL leaks, the application still rejects unrecognized callers.
6. Set the secret:
   ```bash
   wrangler secret put ALLOWED_EMAIL
   ```
   with the value of the email address you use to log in through Access.

## Google Drive OAuth secrets

```bash
wrangler secret put GOOGLE_OAUTH_CLIENT_ID
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
wrangler secret put DRIVE_TOKEN_ENCRYPTION_KEY   # random 32-byte base64 key, e.g. `openssl rand -base64 32`
wrangler secret put ALLOWED_EMAIL
```

Register the exact callback URL on the OAuth client in Google Cloud Console:
`https://<your-worker-hostname>/api/drive/callback`.
