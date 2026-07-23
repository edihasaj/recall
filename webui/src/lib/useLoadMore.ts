import { useEffect, useRef, useState } from "react";

interface PageResult<T> {
  items: T[];
  has_more: boolean;
}

interface Args<T, Q> {
  /**
   * Fetches one page of items. Receives the next offset plus the caller's
   * query object. Must return items + a `has_more` hint from the server.
   */
  fetchPage: (offset: number, query: Q) => Promise<PageResult<T>>;
  /** Page size — same value passed to the server's `limit`. */
  pageSize: number;
  /**
   * Stable serialization of the query that should reset accumulation when
   * it changes (e.g. switching repos or status filters).
   */
  resetKey: string;
  /** Current query value (passed back into fetchPage). */
  query: Q;
  /** Optional poll interval for the *first* page (live refresh of head). */
  refetchInterval?: number;
}

interface Return<T> {
  items: T[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: unknown;
  loadMore: () => void;
  refresh: () => void;
}

/** Identity for de-duplicating appended rows: prefer a stable id field. */
function itemKey(item: unknown): string {
  if (item && typeof item === "object") {
    const rec = item as Record<string, unknown>;
    for (const field of ["id", "session_id", "memory_id"]) {
      const value = rec[field];
      if (typeof value === "string" || typeof value === "number") return `${field}:${value}`;
    }
  }
  return JSON.stringify(item);
}

/**
 * Tiny load-more helper. Accumulates pages in state; resets when `resetKey`
 * changes (filter change). Polls only the *head* page on `refetchInterval` so
 * we never re-pull the whole accumulated tail.
 */
export function useLoadMore<T, Q>({
  fetchPage,
  pageSize,
  resetKey,
  query,
  refetchInterval,
}: Args<T, Q>): Return<T> {
  const [items, setItems] = useState<T[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Latest query in a ref so the polling effect always reads fresh filters
  // without re-binding the interval every render.
  const queryRef = useRef(query);
  queryRef.current = query;
  const resetKeyRef = useRef(resetKey);
  // In-flight guard as a ref, not state: the LoadMore sentinel can fire
  // onLoadMore twice in the same tick (IntersectionObserver batching, or
  // StrictMode double-mounting the observer). `isLoadingMore` state has not
  // propagated yet at that point, so a state-based guard lets both calls
  // through and each appends the same page — duplicating every row.
  const inFlightRef = useRef(false);

  const loadHead = async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const { items: head, has_more } = await fetchPage(0, queryRef.current);
      if (signal?.aborted) return;
      setItems(head);
      setHasMore(has_more);
      setError(null);
    } catch (e) {
      if (!signal?.aborted) setError(e);
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  };

  // Reset whenever resetKey changes.
  useEffect(() => {
    resetKeyRef.current = resetKey;
    inFlightRef.current = false;
    const ctrl = new AbortController();
    loadHead(ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Poll only the head page.
  useEffect(() => {
    if (!refetchInterval) return;
    const id = setInterval(() => {
      // Refresh only the first window; preserves any loaded-more tail by
      // splicing the fresh head in.
      fetchPage(0, queryRef.current)
        .then(({ items: head, has_more }) => {
          if (resetKeyRef.current !== resetKey) return;
          setItems((prev) => {
            if (prev.length <= pageSize) return head;
            // Stitch: replace the first pageSize entries with the fresh head,
            // keep the loaded-more tail intact. Items past head stay as-is.
            return [...head, ...prev.slice(pageSize)];
          });
          if (head.length < pageSize) setHasMore(has_more);
        })
        .catch(() => {});
    }, refetchInterval);
    return () => clearInterval(id);
  }, [refetchInterval, resetKey, pageSize, fetchPage]);

  const loadMore = () => {
    if (inFlightRef.current || !hasMore) return;
    inFlightRef.current = true;
    setIsLoadingMore(true);
    fetchPage(items.length, queryRef.current)
      .then(({ items: more, has_more }) => {
        // Append only rows we don't already hold — belt-and-braces against a
        // page being fetched twice for the same offset.
        setItems((prev) => {
          const seen = new Set(prev.map((item) => itemKey(item)));
          return [...prev, ...more.filter((item) => !seen.has(itemKey(item)))];
        });
        setHasMore(has_more);
      })
      .catch((e) => setError(e))
      .finally(() => {
        inFlightRef.current = false;
        setIsLoadingMore(false);
      });
  };

  const refresh = () => loadHead();

  return { items, hasMore, isLoading, isLoadingMore, error, loadMore, refresh };
}
