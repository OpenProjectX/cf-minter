/**
 * Collapses concurrent calls for the same key onto one execution.
 *
 * The property that matters here: a solve takes up to ~130s, so twenty fetches
 * hitting a 403 at once must not start twenty browser solves against the same
 * host. Late callers await the in-flight one and share its result.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    // Delete in a `finally` on the promise itself rather than after `await`, so
    // the entry is cleared whether the work resolves or throws — a rejected
    // solve left in the map would pin every later caller to the same failure.
    const started = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  get size(): number {
    return this.inFlight.size;
  }
}
