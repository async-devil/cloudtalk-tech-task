import { MAIL_TEMPLATE, type MailRendererPort, type RenderedMailBody } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';

/**
 * The concrete `MailRendererPort` adapter (ADR-0005: concrete adapters and provider SDKs live
 * only in `apps/*​/src/runtime/**`). This repository carries no rich-templating mailing module, so
 * this renderer is deliberately plain: a hand-written text/HTML pair for the one template
 * `@repo/auth` actually sends, `MAIL_TEMPLATE.MagicLink` — no React, no template engine, nothing
 * to configure.
 */

interface MagicLinkTemplate {
  readonly kind: typeof MAIL_TEMPLATE.MagicLink;
  readonly url: string;
}

/** Narrows the port's `unknown` parameter (`@repo/contracts`'s `MailTemplateData` union) down to
 * the one shape this renderer supports, without importing the union itself — the port's own
 * contract is "an adapter narrows it and throws on anything else", so this check IS the contract,
 * not a convenience. */
function isMagicLinkTemplate(template: unknown): template is MagicLinkTemplate {
  return (
    typeof template === 'object' &&
    template !== null &&
    (template as { kind?: unknown }).kind === MAIL_TEMPLATE.MagicLink &&
    typeof (template as { url?: unknown }).url === 'string'
  );
}

/** Minimal HTML-attribute/text escaping — the URL is the only untrusted-shaped input this
 * template interpolates, and it is both the link target and the visible text. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Builds the `MailRendererPort` this repository wires. `render` recognizes
 * `MAIL_TEMPLATE.MagicLink` only — this codebase sends no other mail — and throws a
 * `ValidationError` for anything else, per the port's own documented contract.
 */
export function createPlainTextMailRenderer(): MailRendererPort {
  return {
    render(template: unknown): Promise<RenderedMailBody> {
      if (!isMagicLinkTemplate(template)) {
        throw new ValidationError(
          'createPlainTextMailRenderer: unsupported mail template — this renderer implements ' +
            `MAIL_TEMPLATE.MagicLink only, got ${JSON.stringify(template)}`,
        );
      }
      const { url } = template;
      const text =
        'Sign in\n\n' +
        'Use the link below to finish signing in. This link is single-use and expires shortly.\n\n' +
        `${url}\n\n` +
        'If you did not request this, you can safely ignore this email.\n';
      const html =
        `<p>Use the link below to finish signing in. This link is single-use and expires ` +
        `shortly.</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` +
        '<p>If you did not request this, you can safely ignore this email.</p>';
      return Promise.resolve({ subject: 'Your sign-in link', html, text });
    },
  };
}
