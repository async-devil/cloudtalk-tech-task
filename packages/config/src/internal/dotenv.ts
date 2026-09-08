/**
 * Hand-rolled dotenv-format parser: `KEY=VALUE` lines, `#` whole-line comments, optional
 * single/double-quoted values, **no interpolation** (no `${VAR}` expansion, no escape
 * processing). Zero new npm deps beyond zod (a YAML/dotenv library would need its own registry
 * entry for a format this small). Malformed lines (no `=`) are skipped rather than thrown on —
 * `.env` files are hand-edited local dev artifacts, not a validated input surface; the composed
 * schema is what enforces correctness (a stray malformed line simply contributes nothing).
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    if (key === '') {
      continue;
    }
    const rawValue = line.slice(eq + 1).trim();
    result[key] = unquote(rawValue);
  }

  return result;
}

function unquote(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
  if (isDoubleQuoted || isSingleQuoted) {
    return value.slice(1, -1);
  }
  return value;
}
