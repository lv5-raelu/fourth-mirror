// Track complete event handlers, including Discord delivery and history writes.
export class PendingWork {
  readonly #active = new Set<Promise<void>>();
  #stopping = false;

  run(task: () => Promise<void>): Promise<void> {
    if (this.#stopping) return Promise.resolve();

    const pending = Promise.resolve().then(task);
    this.#active.add(pending);
    void pending.then(
      () => this.#active.delete(pending),
      () => this.#active.delete(pending),
    );
    return pending;
  }

  async drain(): Promise<void> {
    // Close admission before taking the snapshot, so new events cannot extend it.
    this.#stopping = true;
    await Promise.allSettled(this.#active);
  }
}
