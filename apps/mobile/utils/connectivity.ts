// Whether the server is reachable, inferred from what the app already does.
//
// There is deliberately no NetInfo here. It is a native module, so adding it
// forces an `expo prebuild` and a native rebuild on every developer and every
// CI runner — and it answers the wrong question anyway. "The Wi-Fi is
// associated" is not "api.fridgie.ca answers": a supermarket captive portal
// reports a perfectly healthy connection and swallows every request.
//
// What the app already knows is better evidence:
//
//   every fetch          success => reachable, ApiError(status 0) => not
//   the list websocket   already reconnects on a capped backoff, so `onopen`
//                        is a free liveness probe that fires on its own
//
// That last part matters: without it, a phone that goes offline and is then
// left alone has no way to notice it came back, because nothing would be
// making requests to fail or succeed. The websocket's existing retry loop is
// the heartbeat, so being offline costs no extra timers.

type Listener = (online: boolean) => void;

/**
 * Optimistic. At startup nothing has failed yet, and assuming offline would
 * flash "Offline" on every cold launch before the first request returns.
 */
let online = true;
let lastChangeAt = Date.now();

const listeners = new Set<Listener>();

export function isOnline(): boolean {
  return online;
}

/** When the state last flipped — used to avoid flashing a status that just changed. */
export function connectivityChangedAt(): number {
  return lastChangeAt;
}

function set(next: boolean) {
  if (online === next) return;
  online = next;
  lastChangeAt = Date.now();
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (err) {
      console.warn('[connectivity] listener threw', err);
    }
  }
}

/** The server answered. Called from any successful request or websocket open. */
export function reportReachable(): void {
  set(true);
}

/**
 * The server could not be reached — a transport failure, NOT an HTTP error.
 * A 403 or a 500 means we are very much online and something else is wrong;
 * treating those as offline would park unsaved edits behind a retry loop that
 * can never succeed.
 */
export function reportUnreachable(): void {
  set(false);
}

export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
