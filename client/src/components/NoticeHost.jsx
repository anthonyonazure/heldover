import { useEffect, useState } from 'react';
import { onProblem } from '../lib/notice';

const SHOW_FOR_MS = 4000;

/** Shows messages from reportProblem() for a few seconds, newest on top. */
export default function NoticeHost() {
  const [notices, setNotices] = useState([]);

  useEffect(
    () =>
      onProblem((message) => {
        const id = `${Date.now()}-${Math.random()}`;
        // The same failure from several cards at once reads as one message.
        setNotices((prev) => (prev.some((n) => n.message === message) ? prev : [{ id, message }, ...prev].slice(0, 3)));
        setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== id)), SHOW_FOR_MS);
      }),
    []
  );

  if (notices.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[80] flex flex-col gap-2 w-[min(92vw,26rem)]">
      {notices.map((n) => (
        <div key={n.id} className="px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium bg-red-500/20 border border-red-500/30 text-red-300 backdrop-blur">
          {n.message}
        </div>
      ))}
    </div>
  );
}
