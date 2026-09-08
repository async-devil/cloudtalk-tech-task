import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../src/internal/dotenv.js';

describe('parseDotenv', () => {
  it('parses KEY=VALUE lines, skipping blank lines and whole-line comments', () => {
    const parsed = parseDotenv('FOO=bar\n\n# a comment\nBAZ=qux\n');
    expect(parsed).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips matching outer double or single quotes, preserving inner content verbatim', () => {
    const parsed = parseDotenv('A="hello world"\nB=\'hello single\'\n');
    expect(parsed).toEqual({ A: 'hello world', B: 'hello single' });
  });

  it('does not interpolate a dollar-brace variable reference', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${A} proves no interpolation happens, not a forgotten template string.
    const parsed = parseDotenv('A=one\nB=${A}/two\n');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same — literal, not a template.
    expect(parsed).toEqual({ A: 'one', B: '${A}/two' });
  });

  it('trims surrounding whitespace around key and unquoted value', () => {
    const parsed = parseDotenv('  SPACED_KEY = value with spaces  \n');
    expect(parsed).toEqual({ SPACED_KEY: 'value with spaces' });
  });

  it('keeps an empty value as an empty string (composeConfig handles the ⇒undefined step)', () => {
    const parsed = parseDotenv('EMPTY=\n');
    expect(parsed).toEqual({ EMPTY: '' });
  });

  it('skips a malformed line with no "=" rather than throwing', () => {
    const parsed = parseDotenv('FOO=bar\nnot a valid line\nBAZ=qux\n');
    expect(parsed).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles CRLF and bare-CR line endings', () => {
    const parsed = parseDotenv('A=1\r\nB=2\rC=3\n');
    expect(parsed).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('parses the checked-in fixture end to end', () => {
    const parsed = parseDotenv(
      [
        '# a whole-line comment is ignored',
        'FOO=bar',
        '',
        'QUOTED="hello world"',
        "SINGLE_QUOTED='hello single'",
        'EMPTY=',
        '  SPACED_KEY = value with spaces',
        'malformed line with no equals sign',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      FOO: 'bar',
      QUOTED: 'hello world',
      SINGLE_QUOTED: 'hello single',
      EMPTY: '',
      SPACED_KEY: 'value with spaces',
    });
  });
});
