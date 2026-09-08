import { Env, HttpError, json, corsHeaders } from './worker/http';
import { route } from './worker/routes';
import { runRecurring } from './worker/recurring';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve the built SPA (and its assets) for anything that is not an API route.
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // Handle CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      return await route(request, url, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
      console.error(e);
      return json({ error: 'Internal server error' }, { status: 500 });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const result = await runRecurring(env);
    console.log(
      `recurring: created=${result.created} skipped=${result.skipped} deactivated=${result.deactivated}`
    );
  },
};
