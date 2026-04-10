type Handler<T> = [T] extends [undefined] ? () => void : (data: T) => void;

export class TypedEmitter<TEventMap extends Record<string, unknown>> {
  private handlers = new Map<string, Set<(data?: unknown) => void>>();

  on<K extends string & keyof TEventMap>(event: K, handler: Handler<TEventMap[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(event);
    };
  }

  emit(event: string, data?: unknown): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (data?: unknown) => void)(data);
      } catch {
        // Event handler errors must not break the emitter loop
      }
    }
  }

  hasListeners(event?: string): boolean {
    if (event != null) return this.handlers.has(event);
    return this.handlers.size > 0;
  }
}
