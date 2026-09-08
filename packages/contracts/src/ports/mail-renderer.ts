/**
 * The mail-renderer port. Renders a template element to all three of the caller's mail fields.
 * `template` is deliberately `unknown`: contracts must not depend on React; a renderer adapter
 * narrows it to {@link MailTemplateData} and throws a typed validation error on anything else.
 * Rendering owns the subject too — the caller never restates template copy.
 *
 * The auth module wires this as an optional dependency: a magic-link body can be built inline
 * when no renderer is configured, or rendered through this port when one is.
 */
export interface RenderedMailBody {
  readonly html: string;
  readonly text: string;
  readonly subject: string;
}

/**
 * The closed set of mail templates a `MailRendererPort` implementation must recognize. Adding a
 * template means adding a member here, its component in the renderer implementation, and a
 * subject line there — never a bare string scattered at call sites (ADR-0002).
 */
export const MAIL_TEMPLATE = {
  MagicLink: 'magic-link',
  Welcome: 'welcome',
} as const;
export type MailTemplateKind = (typeof MAIL_TEMPLATE)[keyof typeof MAIL_TEMPLATE];

export interface MagicLinkTemplateData {
  readonly kind: typeof MAIL_TEMPLATE.MagicLink;
  readonly url: string;
}
export interface WelcomeTemplateData {
  readonly kind: typeof MAIL_TEMPLATE.Welcome;
  readonly name?: string;
}
/** The discriminated union `MailRendererPort#render`'s `unknown` parameter narrows to. Producers
 * (e.g. the auth module) import only this — never a renderer's concrete template components. */
export type MailTemplateData = MagicLinkTemplateData | WelcomeTemplateData;

export interface MailRendererPort {
  render(template: unknown): Promise<RenderedMailBody>;
}
