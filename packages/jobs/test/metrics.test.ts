import { METRIC_ATTRIBUTE } from '@repo/observability';
import { describe, expect, it } from 'vitest';
import {
  DEAD_LETTER_WRITE_INSTRUMENT,
  OUTBOX_BACKLOG_INSTRUMENT,
  OUTBOX_RELAY_INSTRUMENT,
  OUTBOX_RUN_INSTRUMENT,
  RECONCILER_ACTION_INSTRUMENT,
  RECONCILER_RUN_INSTRUMENT,
  RETENTION_PURGED_INSTRUMENT,
  RETENTION_RUN_INSTRUMENT,
} from '../src/index.js';

describe('jobs metrics instruments (ADR-0009)', () => {
  describe('outbox instruments', () => {
    it('jobs.outbox.run has correct name and attributes', () => {
      expect(OUTBOX_RUN_INSTRUMENT.name).toBe('jobs.outbox.run');
      expect([...OUTBOX_RUN_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Queue].sort(),
      );
    });

    it('jobs.outbox.relay has correct name and attributes', () => {
      expect(OUTBOX_RELAY_INSTRUMENT.name).toBe('jobs.outbox.relay');
      expect([...OUTBOX_RELAY_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome].sort(),
      );
    });

    it('jobs.outbox.backlog has correct name, unit, and attributes', () => {
      expect(OUTBOX_BACKLOG_INSTRUMENT.name).toBe('jobs.outbox.backlog');
      expect(OUTBOX_BACKLOG_INSTRUMENT.unit).toBe('ms');
      expect([...OUTBOX_BACKLOG_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Queue].sort(),
      );
    });

    it('outbox instruments use queue attribute', () => {
      expect(OUTBOX_RUN_INSTRUMENT.allowedAttributes).toContain(METRIC_ATTRIBUTE.Queue);
      expect(OUTBOX_RELAY_INSTRUMENT.allowedAttributes).toContain(METRIC_ATTRIBUTE.Queue);
      expect(OUTBOX_BACKLOG_INSTRUMENT.allowedAttributes).toContain(METRIC_ATTRIBUTE.Queue);
    });
  });

  describe('reconciler instruments', () => {
    it('jobs.reconciler.run has correct name and attributes', () => {
      expect(RECONCILER_RUN_INSTRUMENT.name).toBe('jobs.reconciler.run');
      expect([...RECONCILER_RUN_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Queue].sort(),
      );
    });

    it('jobs.reconciler.action has correct name and attributes', () => {
      expect(RECONCILER_ACTION_INSTRUMENT.name).toBe('jobs.reconciler.action');
      expect([...RECONCILER_ACTION_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Stage, METRIC_ATTRIBUTE.Outcome].sort(),
      );
    });
  });

  describe('dead-letter instrument', () => {
    it('jobs.dead-letter.write has correct name and attributes', () => {
      expect(DEAD_LETTER_WRITE_INSTRUMENT.name).toBe('jobs.dead-letter.write');
      expect([...DEAD_LETTER_WRITE_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Stage].sort(),
      );
    });
  });

  describe('retention instruments', () => {
    it('jobs.retention.run has correct name and attributes', () => {
      expect(RETENTION_RUN_INSTRUMENT.name).toBe('jobs.retention.run');
      expect([...RETENTION_RUN_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Queue].sort(),
      );
    });

    it('jobs.retention.purged has correct name and attributes', () => {
      expect(RETENTION_PURGED_INSTRUMENT.name).toBe('jobs.retention.purged');
      expect([...RETENTION_PURGED_INSTRUMENT.allowedAttributes].sort()).toEqual(
        [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome].sort(),
      );
    });
  });
});
