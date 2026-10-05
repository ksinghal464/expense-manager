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
3. `/api/health` and `/api/drive/callback` are intentionally exempt from the
   password check. Health checks need to work unauthenticated, and Google
   redirects the Drive popup to the callback, a navigation that doesn't
   reliably carry the session cookie. The callback is still protected:
   a Drive connection can only be started by the logged-in app (`POST
/api/drive/connect` requires the session), the callback only accepts the
   single-use `state` that request issued, and it only accepts the Google
   account set in `DRIVE_ALLOWED_EMAIL`.
4. If `APP_PASSWORD` is ever unset, the Worker fails closed (503) rather than
   silently allowing every request through.

## Google Drive OAuth secrets

```bash
wrangler secret put GOOGLE_OAUTH_CLIENT_ID
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
wrangler secret put DRIVE_TOKEN_ENCRYPTION_KEY   # random 32-byte base64 key, e.g. `openssl rand -base64 32`
wrangler secret put DRIVE_ALLOWED_EMAIL          # the only Google account allowed to connect Drive
wrangler secret put APP_PASSWORD
```

Register the exact callback URL on the OAuth client in Google Cloud Console:
`https://<your-worker-hostname>/api/drive/callback`.

Until `DRIVE_ALLOWED_EMAIL` is set, connecting Drive is refused. The callback
rejects (and revokes) any sign-in whose verified email doesn't match it, or
where the Drive permission was unticked on Google's consent screen.

### Publishing the Google OAuth app

While the app's publishing status is **Testing**, Google expires the Drive
sign-in 7 days after consent, so backups stop. Publish it instead:

1. **Branding**: app name (without "Google"/"Drive"), support and developer
   email, home page `https://<your-worker-hostname>`, privacy policy
   `https://<your-worker-hostname>/privacy.html` (served from `public/`
   without the password), authorized domain e.g. `<you>.workers.dev`. Leave
   the logo empty: uploading one triggers a branding review.
2. **Data access**: `openid`, `.../auth/userinfo.email` and
   `.../auth/drive.file`. None of these are sensitive scopes, so no
   verification is needed.
3. **Audience**: **Publish app**. This only lets any Google account reach the
   consent screen; the checks above still refuse everyone but you.
4. Reconnect Drive in **Manage → Data** and run **Backup now**.

The app only drops the saved Google sign-in when Google reports it is
expired or revoked (`invalid_grant`); it records when, and the Data tab
shows it. Other refresh errors keep the sign-in and are shown as the last
backup error.
