export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private valueHead = 0;
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.valueHead < this.values.length) {
          const value = this.values[this.valueHead] as T;
          this.valueHead += 1;
          // Keep dequeue amortized O(1). Array.shift() moved every remaining
          // token event and became quadratic during long streamed answers.
          if (this.valueHead >= 1_024 && this.valueHead * 2 >= this.values.length) {
            this.values.splice(0, this.valueHead);
            this.valueHead = 0;
          }
          return { value, done: false };
        }
        if (this.failure) throw this.failure;
        if (this.closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
