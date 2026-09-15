/**
 * Typed lifecycle events (Phase 7 / Issue #8 minimal emitter; Phase 17
 * freezes the full surface).
 *
 * Two events per architecture §10 — intentionally tiny:
 * - `intent:transition` — fired after every persisted store transition the
 *   queue/engine performs.
 * - `intent:settled` — fired when an entry reaches a terminal state
 *   (`SUCCESS`, `FAILED`, `INDETERMINATE`; `EXPIRED` is not terminal — it
 *   may still rebuild or be manually retried).
 *
 * Handlers run synchronously after the state change is durable; a throwing
 * handler is isolated (reported via `onError`) and never breaks the sweep.
 */

import type { QueueEntry } from './store/types.js';

/** The two lifecycle events of V1 (architecture §10). */
export type QueueEventType = 'intent:transition' | 'intent:settled';

/** Handler signature for both events. */
export type QueueEventHandler = (entry: QueueEntry) => void;

/** Called when an event handler throws, so apps can log without crashing sweeps. */
export type QueueErrorHandler = (error: unknown, event: QueueEventType, entry: QueueEntry) => void;

/** One registered handler with its owning event. */
type Subscription = {
  event: QueueEventType;
  handler: QueueEventHandler;
};

/**
 * Minimal typed event emitter. `on` returns an unsubscribe function;
 * handler errors are caught and routed to `onError` (default: ignore) so
 * application observers can never corrupt queue processing.
 */
export class QueueEvents {
  private readonly subscriptions: Subscription[] = [];
  private errorHandler: QueueErrorHandler | undefined;

  /** Subscribe to an event; returns the unsubscribe function. */
  on(event: QueueEventType, handler: QueueEventHandler): () => void {
    const subscription: Subscription = { event, handler };
    this.subscriptions.push(subscription);
    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index !== -1) this.subscriptions.splice(index, 1);
    };
  }

  /** Set the handler-error sink (application logging hook). */
  onError(handler: QueueErrorHandler | undefined): void {
    this.errorHandler = handler;
  }

  /** Fire an event synchronously; handler throws are isolated. */
  emit(event: QueueEventType, entry: QueueEntry): void {
    for (const subscription of this.subscriptions) {
      if (subscription.event !== event) continue;
      try {
        subscription.handler(entry);
      } catch (error: unknown) {
        if (this.errorHandler !== undefined) {
          this.errorHandler(error, event, entry);
        }
      }
    }
  }
}
