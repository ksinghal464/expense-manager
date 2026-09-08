export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        return json({ ok: result?.ok === 1 });
      }

      if (request.method === 'GET' && url.pathname === '/api/transactions') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
        const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
        const rows = await env.DB.prepare(`
          SELECT t.*, a.name AS account_name, c.name AS category_name,
                 p.name AS payee_name, pm.name AS payment_method_name
          FROM transactions t
          JOIN accounts a ON a.id = t.account_id
          LEFT JOIN categories c ON c.id = t.category_id
          LEFT JOIN payees p ON p.id = t.payee_id
          LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
          WHERE t.deleted_at IS NULL
          ORDER BY t.occurred_at DESC
          LIMIT ? OFFSET ?
        `).bind(limit, offset).all();
        return json(rows.results);
      }

      return json({ error: 'Not found' }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
