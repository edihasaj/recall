import { useEffect, useRef } from "react";

/**
 * Footer for paginated lists. Shows a "load more" button users can click,
 * but also auto-triggers via IntersectionObserver when the user scrolls
 * the sentinel into view — so paging feels infinite-scroll-y without us
 * keeping the whole tail in memory across navigations.
 */
export function LoadMore({
  hasMore,
  isLoading,
  onLoadMore,
  total,
}: {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  total: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || isLoading) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onLoadMore();
        }
      },
      { rootMargin: "320px 0px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMore, isLoading, onLoadMore]);

  if (!hasMore && total === 0) return null;

  return (
    <div
      ref={ref}
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "16px 0 32px",
        gap: 10,
        color: "var(--muted)",
        fontSize: 12,
      }}
    >
      {hasMore ? (
        <button
          className="btn"
          onClick={onLoadMore}
          disabled={isLoading}
          style={{ minWidth: 140 }}
        >
          {isLoading ? "loading…" : `load more (showing ${total})`}
        </button>
      ) : (
        <span>{total} total · end of list</span>
      )}
    </div>
  );
}
