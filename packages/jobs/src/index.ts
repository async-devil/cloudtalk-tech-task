// Public barrel — the module's entire public contract (ADR-0003: one barrel, no nested barrels).
export {
  type BranchIdentity,
  type BranchKind,
  type BranchRunOptions,
  completeBranch,
  type FailBranchOptions,
  failBranch,
  JOIN_DECISION,
  type JoinDecision,
  type RegisterBranchesOptions,
  registerBranches,
  runPipelineBranch,
} from './branch.js';
export {
  createPipelineTableContract,
  type PipelineTableContract,
} from './contract.js';
export {
  DEAD_LETTER_WRITE_INSTRUMENT,
  type DeadLetterRecord,
  type OutboxDeadLetterRecord,
  writeDeadLetter,
  writeOutboxDeadLetter,
} from './dead-letter.js';
export {
  computeOldestPendingAgeMs,
  insertOutboxRows,
  OUTBOX_BACKLOG_INSTRUMENT,
  OUTBOX_RELAY_INSTRUMENT,
  OUTBOX_ROW_OUTCOME,
  OUTBOX_RUN_INSTRUMENT,
  type OutboxInsert,
  type OutboxRelayOptions,
  type OutboxRelayReport,
  type OutboxRow,
  type OutboxRowOutcome,
  type OutboxTableRef,
  relayOutboxBatch,
  startOutboxRelay,
} from './outbox.js';
export {
  RECONCILE_ACTION,
  RECONCILER_ACTION_INSTRUMENT,
  RECONCILER_RUN_INSTRUMENT,
  type ReconcileAction,
  type ReconcileReport,
  type ReconcilerOptions,
  type ReconcilerStageBinding,
  reconcilePipeline,
  startReconciler,
} from './reconciler.js';
export {
  type PurgeDeadLettersOptions,
  purgeDeadLetters,
  purgePipelineData,
  RETENTION_PURGE_TARGET,
  RETENTION_PURGED_INSTRUMENT,
  RETENTION_RUN_INSTRUMENT,
  type RetentionOptions,
  type RetentionPurgeTarget,
  type RetentionReport,
  startRetention,
} from './retention.js';
export type { ScheduledWorkerHandle } from './scheduled-worker.js';
export {
  type ClaimStageOptions,
  type ClaimStageResult,
  type CompleteStageOptions,
  type CompleteStageResult,
  claimStage,
  completeStage,
  type ReadStageResultOptions,
  readStageResult,
  runPipelineStage,
  STAGE_RUN_OUTCOME,
  type StageRunOptions,
  type StageRunOutcome,
  type WriteStageResultOptions,
  writeStageResult,
} from './stage.js';
