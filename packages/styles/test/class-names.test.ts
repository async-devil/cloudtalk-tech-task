import { describe, expect, it } from 'vitest';
import { cn } from '../src/class-names.js';

describe('cn', () => {
  it('drops the losing utility when two classes target the same built-in Tailwind group', () => {
    // The property that makes `className` overridable at all: a plain template string would keep
    // both and let CSS source order decide.
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('keeps utilities from different groups', () => {
    expect(cn('rounded-control', 'text-body')).toBe('rounded-control text-body');
  });

  it('accepts the conditional shapes clsx supports', () => {
    expect(cn('a', undefined, null, false, ['b', { c: true, d: false }])).toBe('a b c');
  });

  /**
   * The custom-scale half. Without `extendTailwindMerge` (see `src/internal/token-scales.ts`)
   * every one of these is wrong in a DIFFERENT way — `rounded-*` and `shadow-*` stop conflicting
   * at all, and `text-caption` is classified as a COLOUR, so a colour override silently deletes
   * the size. Verified at by running these against an unextended `twMerge`.
   */
  describe('this design system’s own token scales', () => {
    it('treats two radius tokens as one group', () => {
      expect(cn('rounded-surface', 'rounded-pill')).toBe('rounded-pill');
    });

    it('treats two type-scale tokens as one group', () => {
      expect(cn('text-caption', 'text-body')).toBe('text-body');
    });

    it('keeps a type-scale token and a colour token side by side', () => {
      expect(cn('text-caption', 'text-danger')).toBe('text-caption text-danger');
    });

    it('treats two elevation tokens as one group', () => {
      expect(cn('shadow-raised', 'shadow-overlay')).toBe('shadow-overlay');
    });

    it('treats a custom easing token and a built-in one as one group', () => {
      expect(cn('ease-standard', 'ease-linear')).toBe('ease-linear');
    });

    it('treats two colour tokens on the same property as one group', () => {
      expect(cn('bg-surface', 'bg-danger')).toBe('bg-danger');
    });
  });
});
