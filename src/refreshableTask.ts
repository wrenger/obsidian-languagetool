export interface RefreshableTaskOptions {
    /** Returns true for transient failures; false blocks further attempts until invalidation. */
    shouldRetry: (error: unknown) => boolean;
    /** Reports the first current-run failure since creation or invalidation, not every retry. */
    onError?: (error: unknown) => void;
}

const MAX_DELAY = 300_000; // Cap at 5min

/** A task that can be run asynchronously, with retry, invalidation and rejection logic. */
export class RefreshableTask {
    /** Incremented on invalidation so in-flight runs can reject obsolete results via isCurrent(). */
    private generation = 0;
    /** Work is needed, only a successful current run clears this. */
    private stale = true;
    /** Permanently stops execution after plugin cleanup. */
    private disposed = false;
    /** A non-retryable failure pauses work until invalidation. */
    private blocked = false;
    /** Limits onError to one notification per invalidation, rather than one per retry attempt. */
    private notified = false;
    /** Base backoff in milliseconds. */
    private retryDelay = 1000;
    /** Scheduled retry handle. */
    private retryTimer?: number;
    /** Promise for serializing runs and letting concurrent callers await the same refresh cycle. */
    private pending?: Promise<void>;

    /** Creates a task whose run callback must check isCurrent() before committing results. */
    constructor(
        private readonly run: (isCurrent: () => boolean) => Promise<void>,
        private readonly options: RefreshableTaskOptions,
    ) {}

    /** Runs stale work when allowed, sharing pending work and respecting retry backoff. */
    ensure(): Promise<void> {
        if (this.pending) return this.pending;
        if (this.disposed || !this.stale || this.blocked || this.retryTimer !== undefined) {
            return Promise.resolve();
        }

        // Defer execution so even synchronous callbacks see the shared pending promise.
        this.pending = Promise.resolve().then(() => this.refresh());
        return this.pending;
    }

    /** Marks results obsolete and resets failure state. */
    invalidate(): void {
        if (this.disposed) return;
        this.generation++;
        this.stale = true;
        this.blocked = false;
        this.notified = false;
        this.retryDelay = 1000;
        this.clearRetry();
    }

    /** Bypasses backoff for stale, retryable work, for example after reconnecting. */
    retry(): void {
        if (this.disposed || this.blocked) return;
        this.clearRetry();
        void this.ensure();
    }

    /** Cancels scheduled retries and prevents further runs or valid in-flight results. */
    dispose(): void {
        this.disposed = true;
        this.clearRetry();
    }

    /** Serializes refreshes, reruns invalidated work, and schedules retries after transient failures. */
    private async refresh(): Promise<void> {
        try {
            while (!this.disposed && this.stale && !this.blocked) {
                const generation = this.generation;
                const isCurrent = () => !this.disposed && generation === this.generation;
                try {
                    await this.run(isCurrent);
                    // Invalidation during the run requires another pass.
                    if (!isCurrent()) continue;
                    this.stale = false;
                    this.retryDelay = 1000;
                } catch (error) {
                    // Obsolete failures must not block newer work.
                    if (!isCurrent()) continue;
                    this.blocked = !this.options.shouldRetry(error);
                    if (!this.blocked) {
                        this.retryDelay = Math.min(MAX_DELAY, this.retryDelay * 3);
                        // Jitter spreads reconnect retries.
                        const delay = this.retryDelay * (0.9 + Math.random() * 0.2);
                        this.retryTimer = window.setTimeout(() => {
                            this.retryTimer = undefined;
                            void this.ensure();
                        }, delay);
                    }
                    if (!this.notified) {
                        this.notified = true;
                        this.options.onError?.(error);
                    }
                    // Wait for retry/invalidation unless onError invalidated this run.
                    if (isCurrent()) break;
                }
            }
        } finally {
            this.pending = undefined;
        }
    }

    private clearRetry(): void {
        if (this.retryTimer === undefined) return;
        window.clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
    }
}
