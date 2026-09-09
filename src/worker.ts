import { Env, HttpError, json, corsHeaders } from './worker/http';
import { route } from './worker/routes';
import { runRecurring } from './worker/recurring';
import { driveBackup, driveStatus } from './worker/drive';
import { exportJson } from './worker/io';

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
      // Single-user app: surface the real error message (and log the full stack)
      // instead of a bare "Internal server error" that hides the actual cause.
      console.error('Unhandled error handling', request.method, url.pathname, e);
      const message = e instanceof Error ? e.message : 'Internal server error';
      return json({ error: message }, { status: 500 });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const result = await runRecurring(env);
    console.log(
      `recurring: created=${result.created} skipped=${result.skipped} deactivated=${result.deactivated}`
    );
    try {
      const status = await driveStatus(env);
      if (status.configured && status.connected && status.autoBackup) {
        const backup = await exportJson(env);
        await driveBackup(env, backup);
        console.log('drive: automatic backup completed');
      }
    } catch (e) {
      console.error('drive: automatic backup failed', e);
    }
  },
};
