// Wakes open streams when their session gets a new event. Writers in this process wake readers at
// once; each reader also polls (DbSessionsApi's pollMs), so an event written by another API
// instance, or by the domain-event worker, still arrives within a second. Polling is one indexed
// query per open stream per second: fine for a demo's handful of streams, and it needs no
// dedicated LISTEN connection, which Neon's pooler would break (env.ts).

export class SessionFeed {
  private readonly watchers = new Map<string, Set<() => void>>();

  /** Calls `onWake` whenever `wake(sessionId)` runs. Returns a function that stops watching. */
  watch(sessionId: string, onWake: () => void): () => void {
    let set = this.watchers.get(sessionId);
    if (!set) {
      set = new Set();
      this.watchers.set(sessionId, set);
    }
    set.add(onWake);
    return () => {
      set.delete(onWake);
      if (set.size === 0) this.watchers.delete(sessionId);
    };
  }

  wake(sessionId: string): void {
    for (const onWake of this.watchers.get(sessionId) ?? []) onWake();
  }
}
