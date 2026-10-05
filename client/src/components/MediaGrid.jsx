import React, { useState, useCallback, useRef, useEffect } from 'react';
import MediaCard from './MediaCard';
import MediaDetailModal from './MediaDetailModal';

const PAGE_SIZE = 60;

function SkeletonCard() {
  return (
    <div className="rounded-xl overflow-hidden bg-surface-850 border border-white/5 animate-pulse">
      <div className="aspect-[2/3] bg-surface-800" />
      <div className="p-2 space-y-2">
        <div className="h-3.5 bg-surface-800 rounded w-3/4" />
        <div className="h-2.5 bg-surface-800 rounded w-1/3" />
      </div>
    </div>
  );
}

export default function MediaGrid({ items, loading, serverKey, onRatingChange, onPlayOnTv}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const sentinelRef = useRef(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Reset visible count when items change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [items]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && visibleCount < items.length) {
          setLoadingMore(true);
          // Small delay to show spinner briefly for smooth feel
          setTimeout(() => {
            setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, items.length));
            setLoadingMore(false);
          }, 150);
        }
      },
      { rootMargin: '400px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, items.length]);

  const handleSelectItem = useCallback((item) => {
    const idx = items.indexOf(item);
    setSelectedItem(item);
    setSelectedIndex(idx);
  }, [items]);

  const handleNavigate = useCallback((newIndex) => {
    if (newIndex >= 0 && newIndex < items.length) {
      setSelectedItem(items[newIndex]);
      setSelectedIndex(newIndex);
      // Load more if navigating near the end of visible items
      if (newIndex >= visibleCount - 5) {
        setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, items.length));
      }
    }
  }, [items, visibleCount]);

  if (loading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 sm:gap-3">
        {Array.from({ length: 20 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <svg className="w-16 h-16 text-gray-700 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
          />
        </svg>
        <h3 className="text-lg font-medium text-gray-400 mb-1">No media found</h3>
        <p className="text-sm text-gray-600">
          Try adjusting your filters or select a different library.
        </p>
      </div>
    );
  }

  const visible = items.slice(0, visibleCount);
  const hasMore = visibleCount < items.length;

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 sm:gap-3">
        {visible.map((item) => (
          <MediaCard key={item.ratingKey || item.key} item={item} onClick={handleSelectItem} serverKey={serverKey} onRatingChange={onRatingChange} />
        ))}
      </div>

      {/* Infinite scroll sentinel */}
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {loadingMore && (
            <div className="flex items-center gap-2 text-gray-500">
              <div className="w-5 h-5 border-2 border-amber-500/50 border-t-amber-500 rounded-full animate-spin" />
              <span className="text-xs">Loading more...</span>
            </div>
          )}
        </div>
      )}

      {selectedItem && (
        <MediaDetailModal
          item={selectedItem}
          onClose={() => { setSelectedItem(null); setSelectedIndex(-1); }}
          items={items}
          currentIndex={selectedIndex}
          onNavigate={handleNavigate}
          serverKey={serverKey}
          onPlayOnTv={onPlayOnTv}
        />
      )}
    </>
  );
}
