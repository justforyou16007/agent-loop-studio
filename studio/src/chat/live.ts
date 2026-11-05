/**
 * The sessions as they change, from the Studio's server: one connection for the
 * page, however many parts of it follow, and it comes back by itself when it
 * drops. What it says is only a nudge and the words being written; what a session
 * did is read from its timeline, so a missed message costs nothing.
 */
import type { LiveEvent } from "../../../src/tools/studio-types.js";

type Listener = (event: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

export function followSessions(listener: Listener): () => void {
  listeners.add(listener);
  if (!source || source.readyState === EventSource.CLOSED) {
    source = new EventSource("/api/events");
    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as LiveEvent;
      for (const known of listeners) known(event);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      source?.close();
      source = null;
    }
  };
}
