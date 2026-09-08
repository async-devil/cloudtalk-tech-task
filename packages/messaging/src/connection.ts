/** Connection info passed to {@link createQueue}/{@link createWorker} (frozen). */
export interface MessagingConnection {
  readonly redisUrl: string;
}
