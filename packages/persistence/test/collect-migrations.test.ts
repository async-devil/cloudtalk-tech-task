import { InternalError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { collectMigrations, listMigrationFiles } from '../src/internal/collect-migrations.js';

function fixtureFolder(relative: string): string {
  return new URL(`./fixtures/${relative}`, import.meta.url).pathname;
}

describe('listMigrationFiles', () => {
  // INV-2
  it('merges folders into one global lexicographic order on file name', async () => {
    const files = await listMigrationFiles([
      fixtureFolder('merge/module-a'),
      fixtureFolder('merge/module-b'),
    ]);
    expect(files.map((file) => file.name)).toEqual([
      '0001-create-alpha',
      '0002-create-beta',
      '0003-add-alpha-index',
    ]);
  });

  // INV-2 (order is a property of names, not of the folder list)
  it('produces the same global order regardless of folder-list order', async () => {
    const files = await listMigrationFiles([
      fixtureFolder('merge/module-b'),
      fixtureFolder('merge/module-a'),
    ]);
    expect(files.map((file) => file.name)).toEqual([
      '0001-create-alpha',
      '0002-create-beta',
      '0003-add-alpha-index',
    ]);
  });

  it('ignores entries that do not match the NNNN-imperative-description.(ts|js) shape', async () => {
    const files = await listMigrationFiles([fixtureFolder('merge/module-a')]);
    expect(files.map((file) => file.name)).toEqual(['0001-create-alpha', '0003-add-alpha-index']);
  });

  // INV-3
  it('throws InternalError on a duplicate file name across folders, naming both folders', async () => {
    let caught: unknown;
    try {
      await listMigrationFiles([
        fixtureFolder('duplicate/folder-one'),
        fixtureFolder('duplicate/folder-two'),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InternalError);
    const internal = caught as InternalError;
    expect(internal.message).toContain('0001-same-name.js');
    expect(internal.message).toContain('folder-one');
    expect(internal.message).toContain('folder-two');
  });
});

describe('collectMigrations', () => {
  it('loads merged migrations keyed by name, with optional down preserved', async () => {
    const migrations = await collectMigrations([
      fixtureFolder('merge/module-a'),
      fixtureFolder('merge/module-b'),
    ]);
    expect(Object.keys(migrations)).toEqual([
      '0001-create-alpha',
      '0002-create-beta',
      '0003-add-alpha-index',
    ]);
    expect(typeof migrations['0001-create-alpha']?.up).toBe('function');
    expect(typeof migrations['0001-create-alpha']?.down).toBe('function');
    expect(migrations['0003-add-alpha-index']?.down).toBeUndefined();
  });

  it('throws InternalError when a migration module exports no up function', async () => {
    await expect(collectMigrations([fixtureFolder('no-up')])).rejects.toBeInstanceOf(InternalError);
  });
});
