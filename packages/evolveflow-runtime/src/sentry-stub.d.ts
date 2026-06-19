// Type stub for optional @sentry/node dependency.
// Sentry is only activated when EVOLVEFLOW_SENTRY_DSN is set.
declare module '@sentry/node' {
  export function init(opts: Record<string, unknown>): void;
  export function captureException(err: unknown, opts?: Record<string, unknown>): string;
}
