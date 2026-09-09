import { Env, HttpError, json } from './worker/http';
import { route } from './worker/routes';
import { runRecurring } from './worker/recurring';
import { driveBackup, driveStatus, setDriveBackupError } from './worker/drive';
import { exportJson } from './worker/io';
import { requireAuth, handleLogin, handleLogout } from './worker/auth';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve the built SPA (and its assets) for anything that is not an API route.
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (request.method === 'POST' && url.pathname === '/api/login')
        return await handleLogin(request, env);
      if (request.method === 'POST' && url.pathname === '/api/logout') return handleLogout();
      await requireAuth(request, url, env);
      return await route(request, url, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
      // Log the full detail server-side only; never return internal exception
      // messages (SQL errors, provider responses, etc.) to the client.
      console.error('Unhandled error handling', request.method, url.pathname, e);
      return json({ error: 'Internal server error' }, { status: 500 });
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
      try {
        await setDriveBackupError(env, e instanceof Error ? e.message : 'Automatic backup failed');
      } catch (e2) {
        console.error('drive: failed to persist backup error', e2);
      }
    }
  },
};
