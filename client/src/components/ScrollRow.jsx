import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One horizontal row of posters, with the scrolling behaviour every row in the
 * app should share.
 *
 * Before this existed, four different components each rolled their own version:
 * tiny header chevrons in one, hover-only arrows in another, glass overlay
 * circles in two more, and arrows that stayed on screen with nothing left to
 * scroll to. This is the single place that behaviour lives now.
 *
 * Two rules it enforces:
 *
 *   - Arrows are for pointers, not fingers. A phone already scrolls by swiping,
 *     so arrows there are dead weight sitting on top of the posters. The
 *     `(hover: hover)` query asks the real question — "does this person have a
 *     mouse?" — rather than guessing from screen width, which gets tablets and
 *     touchscreen laptops wrong.
 *   - An arrow only appears when there is somewhere to go. A left arrow at the
 *     start of a row is a button that lies.
 *
 * `onReachEnd` fires when the row is scrolled near its right edge, so a caller
 * can hand over more posters before the swipe runs out of track.
 */
export default function ScrollRow({ children, onReachEnd, className = '', ariaLabel = 'row' }) {
  const scrollRef = useRef(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [hasPointer, setHasPointer] = useState(false);
  const reachedEndRef = useRef(false);

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const apply = () => setHasPointer(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A one-pixel slack: browsers round fractional scroll widths, so an exact
    // comparison leaves a phantom right arrow on a row that is fully scrolled.
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < maxScroll - 1);

    if (!onReachEnd) return;
    const nearEnd = maxScroll - el.scrollLeft < el.clientWidth;
    if (nearEnd && !reachedEndRef.current) {
      reachedEndRef.current = true;
      onReachEnd();
    } else if (!nearEnd) {
      reachedEndRef.current = false;
    }
  }, [onReachEnd]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Cards arriving later change the scroll width without a resize or a
    // scroll, so watch the row's contents too.
    const mutations = new MutationObserver(measure);
    mutations.observe(el, { childList: true, subtree: false });
    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [measure]);

  const nudge = (direction) => {
    const el = scrollRef.current;
    if (!el) return;
    // Just under a full screen, so the poster at the edge stays visible and you
    // keep your place instead of jumping blind.
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: 'smooth' });
  };

  // The arrow sits inside the row's own edge rather than outside it: several
  // rows live in collapsible wrappers with `overflow-hidden`, which silently
  // clips anything hanging past the boundary.
  const arrow = (direction) => (
    <button
      onClick={() => nudge(direction)}
      aria-label={`Scroll ${ariaLabel} ${direction < 0 ? 'left' : 'right'}`}
      className={`flex items-center justify-center absolute ${
        direction < 0 ? 'left-1' : 'right-1'
      } top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-black/70 backdrop-blur border border-white/10 text-white shadow-lg shadow-black/40 hover:bg-black/90 hover:border-amber-400/40 transition-all`}
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <polyline points={direction < 0 ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
      </svg>
    </button>
  );

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className={`flex overflow-x-auto scroll-smooth no-scrollbar ${className}`}
      >
        {children}
      </div>
      {hasPointer && canLeft && arrow(-1)}
      {hasPointer && canRight && arrow(1)}
    </div>
  );
}


