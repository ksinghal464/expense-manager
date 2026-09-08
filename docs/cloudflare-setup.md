# Cloudflare setup

1. Create a Cloudflare account using your own email/Google account.
2. In the Cloudflare dashboard open **Storage & databases → D1 SQL Database**.
3. Create the database named `expense-manager`.
4. Keep the database ID private only in the sense that it identifies the database; never share account passwords or API tokens.
5. The Worker uses the D1 binding `DB`, exposed to code as `env.DB`.
6. The GitHub repository is intended to be connected to Cloudflare Builds for automatic deployment.
7. Database schema changes are kept in `migrations/` and should be applied through Wrangler/Cloudflare deployment tooling.

For the first deployment, do not manually create tables with ad-hoc SQL. Run the versioned migration so the Git repository remains the source of truth.
