import { useEffect, useState } from 'react';

const PAGE_SIZE = 50;
type Cursor = Record<string, string>;

/** Keeps only the current page. Every navigation fetches fresh data. */
export function useFreshPage<T>(
  fetchPage: (params: Cursor, signal?: AbortSignal) => Promise<T[]>,
  cursorFor: (row: T) => Cursor,
  revision?: unknown
) {
  const [request, setRequest] = useState({ revision, cursors: [{} as Cursor], attempt: 0 });
  const [result, setResult] = useState<{
    request: typeof request;
    rows: T[];
    error: string;
  } | null>(null);

  // A mutation invalidates the current pagination position, not just its rows.
  if (request.revision !== revision) {
    setRequest({ revision, cursors: [{}], attempt: 0 });
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchPage(
      { ...request.cursors[request.cursors.length - 1], limit: String(PAGE_SIZE + 1) },
      controller.signal
    )
      .then((rows) => {
        if (!controller.signal.aborted) setResult({ request, rows, error: '' });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setResult({
            request,
            rows: [],
            error: e instanceof Error ? e.message : 'Unable to load data',
          });
      });
    return () => controller.abort();
  }, [fetchPage, request]);

  const current = result?.request === request ? result : null;
  const rows = current?.rows.slice(0, PAGE_SIZE) ?? [];
  const hasNext = (current?.rows.length ?? 0) > PAGE_SIZE;
  return {
    rows,
    loading: !current,
    error: current?.error ?? '',
    page: request.cursors.length,
    hasNext,
    retry: () => setRequest((r) => ({ ...r, attempt: r.attempt + 1 })),
    reload: () => setRequest((r) => ({ ...r, cursors: [{}], attempt: r.attempt + 1 })),
    next: () => {
      if (hasNext)
        setRequest((r) => ({ ...r, cursors: [...r.cursors, cursorFor(rows[rows.length - 1])] }));
    },
    previous: () => setRequest((r) => ({ ...r, cursors: r.cursors.slice(0, -1) })),
  };
}
