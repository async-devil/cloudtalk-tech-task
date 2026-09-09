import { type AppMode, isFailClosed } from '@repo/config';
import type { MailMessage, MailSenderPort } from '@repo/contracts';
import { createModuleObservability } from '@repo/observability';

/**
 * The development `MailSenderPort` adapter (ADR-0005: concrete adapters live only in
 * `apps/*​/src/runtime/**`) — and ADR-0013's stated limitation made concrete: there is no
 * production mail transport in this repository. This sender logs the magic-link URL through the
 * observability facade at info level so a developer can complete sign-in locally, and it never
 * pretends to be more than that.
 */

const obs = createModuleObservability('api');

/** Pulls the first http(s) URL out of a rendered plain-text body. */
function extractUrl(text: string): string | undefined {
  return /https?:\/\/\S+/.exec(text)?.[0];
}

/** The dev sender's surface: a `MailSenderPort`, plus a bounded in-process capture used by the
 * `test`-mode-only session-mock route (`test-session-route.ts`) — the one caller that needs to
 * read a "sent" mail back out rather than just have it logged. There is no real inbox to poll in
 * this repository, so the sender that logged the message is also the only place that can hand it
 * back. */
export interface DevMailSender extends MailSenderPort {
  /** The plain-text body of the most recently captured mail sent TO `email`, or `undefined` if
   * none. Most-recent-for-that-address rather than "the last one sent": a caller that requests a
   * second link for the same address wants the live token, and an earlier one may already be
   * consumed; scoping by address also means two addresses sending concurrently can never hand
   * either caller the other's link. */
  readLastSentTextFor(email: string): string | undefined;
}

/**
 * Builds the dev mail sender. **Refuses to construct in a fail-closed tier** (`isFailClosed`):
 * staging and production must not boot with a mail adapter that only logs, so this throws at
 * construction time rather than quietly shipping a sender that cannot actually deliver mail.
 * Wiring a real provider is a composition-root change (ADR-0005) and was left undone
 * deliberately, per ADR-0013 — the port, the renderer and the rate limit are all in place and
 * tested; only the transport is missing.
 *
 * @throws Error when `mode` is a fail-closed tier.
 */
export function createDevMailSender(mode: AppMode): DevMailSender {
  if (isFailClosed(mode)) {
    throw new Error(
      `createDevMailSender: refusing to construct for APP_MODE=${mode} — this sender only logs ` +
        'the magic-link URL and cannot deliver real mail. A fail-closed tier (staging/production) ' +
        'must be given a real MailSenderPort adapter instead (ADR-0013).',
    );
  }

  const sentMessages: MailMessage[] = [];

  return {
    send(message: MailMessage): Promise<{ readonly providerMessageId?: string }> {
      sentMessages.push(message);
      const url = extractUrl(message.text);
      obs.logger.info(
        { to: message.to, subject: message.subject, url },
        'api.mail.dev-sender: magic-link mail captured — no real transport is configured, ' +
          'open the URL above to complete sign-in',
      );
      return Promise.resolve({});
    },
    readLastSentTextFor(email: string): string | undefined {
      return sentMessages.filter((message) => message.to === email).at(-1)?.text;
    },
  };
}
