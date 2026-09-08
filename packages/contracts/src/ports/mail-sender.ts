/**
 * The mail-sender port. The auth module consumes this port plus a deterministic stub in tests; a
 * real provider adapter satisfies it in production.
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface MailSenderPort {
  /** Resolves when the provider accepted the message. Throws typed application errors only — the
   * auth module maps an exhausted/terminal send to its own send-failure error (ADR-0004). */
  send(message: MailMessage): Promise<{ readonly providerMessageId?: string }>;
}
