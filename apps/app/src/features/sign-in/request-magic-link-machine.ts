import {
  type ApiError,
  errorMessageFor,
  toApiErrorFromAuthResponse,
} from '../../shared/errors/index.js';

/**
 * The sign-in flow's state machine (ADR-0012: "interaction flows are pure `useReducer` machines" —
 * binding on every feature).
 *
 * PURE, AND SEPARATE FROM THE COMPONENT: the rules that matter here — you cannot request two links
 * at once, the address survives a failure, an edit clears the error, a sent link is a terminal
 * state the user can back out of — are testable without rendering anything and without a server.
 *
 * `Sent` is a real state rather than a boolean beside `Idle`. The screen after a successful
 * request shows different copy and no submit button, and modelling that as `status === 'sent'` is
 * what stops "submitted" and "succeeded" drifting apart the way two booleans do.
 */

export const REQUEST_MAGIC_LINK_STATUS = {
  Idle: 'idle',
  Submitting: 'submitting',
  Sent: 'sent',
  Error: 'error',
} as const;
export type RequestMagicLinkStatus =
  (typeof REQUEST_MAGIC_LINK_STATUS)[keyof typeof REQUEST_MAGIC_LINK_STATUS];

export interface RequestMagicLinkState {
  readonly status: RequestMagicLinkStatus;
  readonly email: string;
  readonly errorMessage: string | undefined;
}

export const REQUEST_MAGIC_LINK_INITIAL_STATE: RequestMagicLinkState = {
  status: REQUEST_MAGIC_LINK_STATUS.Idle,
  email: '',
  errorMessage: undefined,
};

export type RequestMagicLinkAction =
  | { readonly type: 'edit'; readonly email: string }
  | { readonly type: 'submit' }
  | { readonly type: 'sent' }
  | { readonly type: 'failed'; readonly error: unknown };

export function requestMagicLinkReducer(
  state: RequestMagicLinkState,
  action: RequestMagicLinkAction,
): RequestMagicLinkState {
  switch (action.type) {
    case 'edit':
      // Editing leaves BOTH the error and the sent state: after "check your inbox", typing a
      // different address is how a user corrects a typo, and leaving the confirmation up while
      // they do it would tell them a link is on its way to an address they just abandoned.
      return {
        status: REQUEST_MAGIC_LINK_STATUS.Idle,
        email: action.email,
        errorMessage: undefined,
      };
    case 'submit':
      // Guarded for the same reason a create flow would be: a double-click otherwise spends two
      // magic-link sends against the per-address bucket, and the second one is the user's own
      // rate-limit rejection.
      if (state.status === REQUEST_MAGIC_LINK_STATUS.Submitting || state.email.trim() === '') {
        return state;
      }
      return {
        status: REQUEST_MAGIC_LINK_STATUS.Submitting,
        email: state.email,
        errorMessage: undefined,
      };
    case 'sent':
      return {
        status: REQUEST_MAGIC_LINK_STATUS.Sent,
        email: state.email,
        errorMessage: undefined,
      };
    case 'failed': {
      const apiError: ApiError = toApiErrorFromAuthResponse(action.error);
      return {
        // The address is KEPT. A rate-limited or transient failure that also cleared the field
        // makes the user retype it, which is the most annoying possible response.
        status: REQUEST_MAGIC_LINK_STATUS.Error,
        email: state.email,
        errorMessage: errorMessageFor(apiError.code),
      };
    }
  }
}
