/**
 * Workspace discovery: reads every `apps/*`, `packages/*`, `tools/*` package's `package.json`
 * and `moon.yml` tags, building the two indexes `extract.ts` needs — package name -> folder,
 * and folder -> its declared `workspace:*` edges. No YAML dependency: `moon.yml`'s `tags:` block
 * is a fixed two-space-indented `- item` list in every file this repo has (verified against all
 * current `moon.yml`s), so a line-scan is exact and avoids adding a YAML parser dependency for a
 * format this narrow.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The workspace roots to walk, DERIVED from the root `package.json`'s `workspaces` globs rather
 * than written down. A hardcoded list is a trap the day a new workspace root is added: this
 * index — and therefore the `workspace:*` dependency closure built from it — would not see the
 * new member at all, and that would surface as a confusing "unresolved workspace dependency"
 * extraction error rather than as "this root was never enumerated".
 *
 * Duplicated from `tools/arch-checks/src/workspace-roots.ts`'s `workspaceFolders` rather than
 * imported, deliberately: a cross-`tools/*` import is a module edge ADR-0001 does not sanction,
 * and this file must stay self-contained because extraction copies it. The two are ~10 lines of
 * the same trivial parse; the alternative is a new sanctioned edge for it.
 */
function workspaceRootDirs(repoRoot: string): readonly string[] {
  const parsed = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    readonly workspaces?: readonly string[];
  };
  if (!parsed.workspaces || parsed.workspaces.length === 0) {
    throw new Error(`${repoRoot}/package.json has no "workspaces" globs — nothing to discover.`);
  }
  const roots: string[] = [];
  for (const glob of parsed.workspaces) {
    if (!glob.endsWith('/*')) {
      throw new Error(
        `unsupported workspace glob "${glob}" — only one-level "<folder>/*" globs are supported.`,
      );
    }
    const folder = glob.slice(0, -2);
    if (!roots.includes(folder)) {
      roots.push(folder);
    }
  }
  return roots;
}

export interface WorkspacePackage {
  /** The `package.json` `name` field, e.g. `@repo/jobs`. */
  readonly name: string;
  /** Folder name under its root dir, e.g. `jobs` (also the `file:../<folderName>` target). */
  readonly folderName: string;
  /** Absolute path to the package directory. */
  readonly dir: string;
  /** Repo-root-relative path (`packages/jobs`), what `git ls-files` addresses. */
  readonly relativeDir: string;
  /** `moon.yml` tags, e.g. `['tier-capability', 'liftable']`. */
  readonly tags: ReadonlySet<string>;
  /** Every `workspace:*` dependency in `dependencies` + `devDependencies`, by package name. */
  readonly workspaceDependencyNames: ReadonlySet<string>;
}

/** Exported for `src/selftest.ts`'s fixture-level proofs (this repo's tier-tooling convention:
 * pure/testable internals get exported for direct unit coverage even when not part of the CLI's
 * own public surface). */
export function parseMoonYamlTags(moonYamlPath: string): ReadonlySet<string> {
  let content: string;
  try {
    content = readFileSync(moonYamlPath, 'utf8');
  } catch {
    return new Set();
  }
  const lines = content.split('\n');
  const tags = new Set<string>();
  let inTagsBlock = false;
  for (const line of lines) {
    if (/^tags:\s*$/.test(line)) {
      inTagsBlock = true;
      continue;
    }
    if (inTagsBlock) {
      const item = /^\s+-\s*(\S+)\s*$/.exec(line);
      if (item?.[1] !== undefined) {
        // Most moon.ymls in this repo write bare tags (`- liftable`); a few quote them
        // (`- 'liftable'`) — both are valid YAML scalars for the same string, so strip a
        // matching pair of single or double quotes rather than trust one convention.
        const raw = item[1];
        const unquoted =
          raw.length >= 2 &&
          ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
            ? raw.slice(1, -1)
            : raw;
        tags.add(unquoted);
        continue;
      }
      // Any non-list-item line ends the block (next top-level key, or a blank line followed by one).
      if (line.trim() !== '') {
        inTagsBlock = false;
      }
    }
  }
  return tags;
}

function workspaceDependencyNamesOf(packageJson: {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}): ReadonlySet<string> {
  const names = new Set<string>();
  for (const deps of [packageJson.dependencies, packageJson.devDependencies]) {
    if (deps === undefined) {
      continue;
    }
    for (const [depName, versionSpecifier] of Object.entries(deps)) {
      if (versionSpecifier === 'workspace:*') {
        names.add(depName);
      }
    }
  }
  return names;
}

/**
 * Scans `apps/*`, `packages/*`, `tools/*` for real packages (a directory with a `package.json`)
 * and returns the full workspace graph. Directories without a `package.json` (e.g. an
 * in-progress scaffold) are skipped, matching `run-depcruise.ts`'s "absent is valid" precedent.
 */
export function discoverWorkspace(repoRoot: string): ReadonlyMap<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();

  for (const rootDir of workspaceRootDirs(repoRoot)) {
    const rootDirPath = path.join(repoRoot, rootDir);
    let entries: readonly string[];
    try {
      entries = readdirSync(rootDirPath);
    } catch {
      continue;
    }
    for (const folderName of entries) {
      const dir = path.join(rootDirPath, folderName);
      if (!statSync(dir).isDirectory()) {
        continue;
      }
      const packageJsonPath = path.join(dir, 'package.json');
      let packageJson: {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      } catch {
        continue;
      }
      if (packageJson.name === undefined) {
        continue;
      }
      const tags = parseMoonYamlTags(path.join(dir, 'moon.yml'));
      packages.set(folderName, {
        name: packageJson.name,
        folderName,
        dir,
        relativeDir: `${rootDir}/${folderName}`,
        tags,
        workspaceDependencyNames: workspaceDependencyNamesOf(packageJson),
      });
    }
  }

  return packages;
}

/** Package-name -> folder-name index, built from {@link discoverWorkspace}'s result. */
export function indexByPackageName(
  packages: ReadonlyMap<string, WorkspacePackage>,
): ReadonlyMap<string, WorkspacePackage> {
  const byName = new Map<string, WorkspacePackage>();
  for (const pkg of packages.values()) {
    byName.set(pkg.name, pkg);
  }
  return byName;
}

/** Every workspace package tagged `liftable` (ADR-0001's autonomy contract; apps are the one
 * named exception and simply never carry this tag — they are deployables, not liftable modules).
 * `styles` DOES carry this tag and IS a normal extraction target: shipping source rather than a
 * build does not make a package unliftable, it only changes what the extraction proof measures
 * once the module is copied out (see `extract.ts`'s `extractionModeOf`). */
export function liftablePackages(
  packages: ReadonlyMap<string, WorkspacePackage>,
): ReadonlyArray<WorkspacePackage> {
  return [...packages.values()].filter((pkg) => pkg.tags.has('liftable'));
}
