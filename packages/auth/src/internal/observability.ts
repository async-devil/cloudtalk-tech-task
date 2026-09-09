import { createModuleObservability, METRIC_ATTRIBUTE } from '@repo/observability';

/** The module facade: every span, log and instrument in this package rides it (ADR-0009). Email
 * addresses, tokens and magic-link URLs never appear in logs — the central redaction list covers
 * `email` and `token`, and this module never logs a magic-link URL at all. Both halves are README
 * invariants with tests behind them, because a redaction list is only as good as the fields
 * somebody remembered to name. */
export const observability = createModuleObservability('auth');

/** Route groups for `auth.request.handle`: a closed set, bounded by construction, mapped from the
 * request path so per-endpoint ids never reach the metric (ADR-0009's cardinality rule). */
export const AUTH_ROUTE_GROUP = {
  SignIn: 'sign-in',
  Callback: 'callback',
  Session: 'session',
  Other: 'other',
} as const;
export type AuthRouteGroup = (typeof AUTH_ROUTE_GROUP)[keyof typeof AUTH_ROUTE_GROUP];

/** `auth.request.handle` and `auth.retention.purged` outcomes. For the request counter,
 * `completed` = a <400 response, `terminal` = a >=400 one; for retention, the outcome names which
 * evidence table the purged rows came from. */
export const AUTH_OUTCOME = {
  Completed: 'completed',
  Terminal: 'terminal',
  Session: 'session',
  Verification: 'verification',
} as const;
export type AuthOutcome = (typeof AUTH_OUTCOME)[keyof typeof AUTH_OUTCOME];

/** Counter incremented once per route group handled. */
export const requestCounter = observability.createCounter({
  name: 'auth.request.handle',
  description: 'better-auth route-group outcomes',
  allowedAttributes: [METRIC_ATTRIBUTE.Route, METRIC_ATTRIBUTE.Outcome],
});

/** Counter incremented per retention pass, once per evidence table purged. */
export const retentionPurgedCounter = observability.createCounter({
  name: 'auth.retention.purged',
  description: 'Auth evidence-table retention purges',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome],
});

/** Maps a request URL path to its {@link AUTH_ROUTE_GROUP}. Bounded output by construction. */
export function routeGroupOf(pathname: string): AuthRouteGroup {
  if (pathname.includes('/callback')) {
    return AUTH_ROUTE_GROUP.Callback;
  }
  if (
    pathname.includes('/sign-in') ||
    pathname.includes('/sign-up') ||
    pathname.includes('/magic-link')
  ) {
    return AUTH_ROUTE_GROUP.SignIn;
  }
  if (pathname.includes('session')) {
    return AUTH_ROUTE_GROUP.Session;
  }
  return AUTH_ROUTE_GROUP.Other;
}
