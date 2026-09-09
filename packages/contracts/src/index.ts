// Public barrel — the module's entire public contract (ADR-0003: one barrel, no nested barrels).
// Domain concerns live one-per-folder (contracts/<domain>/); the public surface still flows only
// through this single package entry (ADR-0001).
export { appContract } from './contracts/app-contract.js';
export { emptyContract } from './contracts/empty-contract.js';
export { type ApiErrorShape, apiErrorShape } from './contracts/error-shape.js';
export {
  type SessionBootstrap,
  sessionBootstrapSchema,
  sessionContract,
} from './contracts/session/session.js';
export {
  MAIL_TEMPLATE,
  type MagicLinkTemplateData,
  type MailRendererPort,
  type MailTemplateData,
  type MailTemplateKind,
  type RenderedMailBody,
  type WelcomeTemplateData,
} from './ports/mail-renderer.js';
export type { MailMessage, MailSenderPort } from './ports/mail-sender.js';
