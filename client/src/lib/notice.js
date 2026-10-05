// One place for "that did not work" messages.
//
// Buttons used to catch their errors and write them to the browser console,
// which nobody using the app ever sees: a thumbs-up that failed looked exactly
// like one that worked. reportProblem() still logs for debugging, and also puts
// a short message on screen through <NoticeHost>, mounted once at the root.

const listeners = new Set();

export function reportProblem(message, err) {
  if (err) console.error(message, err);
  for (const listener of listeners) listener(message);
}

export function onProblem(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
