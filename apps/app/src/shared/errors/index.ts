/** `shared/errors` — the one client-side error shape and the one 401 handler. */
export { ApiError, toApiError, toApiErrorFromAuthResponse } from './api-error.js';
export { errorMessageFor } from './error-message.js';
export {
  type CurrentLocationReader,
  installUnauthorizedRedirect,
  type UnauthorizedHandler,
} from './unauthorized-redirect.js';
