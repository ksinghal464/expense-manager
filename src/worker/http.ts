export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_DRIVE_SA_KEY?: string;
  DRIVE_BACKUP_FILE_ID?: string;
}

/** Raised for expected client/server errors; message is safe to return. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function textBody(body: string, type: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', type);
  return new Response(body, { ...init, headers });
}

/** Read the request body as text, enforcing a byte cap. */
export async function readBody(request: Request, maxBytes = 2_000_000): Promise<string> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'Payload too large');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Payload too large');
  return text;
}

/** Read a JSON object body, enforcing a byte cap. Empty body -> {}. */
export async function readJson(request: Request, maxBytes = 2_000_000): Promise<Record<string, unknown>> {
  const text = await readBody(request, maxBytes);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error('not an object');
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}
