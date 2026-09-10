import { z } from 'zod';

/**
 * J3's draft persistence (SPEC-0001): "the draft is held in `sessionStorage` under a product-scoped
 * key, written on change and cleared on successful submission or explicit cancel." A NEW review
 * only — an edit's starting point is the existing review itself (already on the server), so there
 * is nothing J3's sign-in round trip needs to preserve for it (edit is only reachable already
 * signed in).
 *
 * `sessionStorage`, not `localStorage`: a draft surviving a browser restart is not what J3 asks
 * for, and `sessionStorage`'s own per-tab scoping is a better match for "the tab I was filling this
 * in on".
 */
const reviewDraftSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  title: z.string(),
  body: z.string(),
});
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

function draftKey(productSlug: string): string {
  return `review-draft:${productSlug}`;
}

/** `undefined` covers every reason a draft might not come back — never written, a different
 * browser/private window, storage disabled — so a caller always has a real fallback to render
 * rather than a thrown error over what is, at most, a lost convenience. */
export function readReviewDraft(productSlug: string): ReviewDraft | undefined {
  try {
    const raw = sessionStorage.getItem(draftKey(productSlug));
    if (raw === null) {
      return undefined;
    }
    const parsed = reviewDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort: a storage write that fails (quota, a browser blocking storage) degrades to "the
 * draft is not preserved this time", never a thrown error interrupting the person typing. */
export function writeReviewDraft(productSlug: string, draft: ReviewDraft): void {
  try {
    sessionStorage.setItem(draftKey(productSlug), JSON.stringify(draft));
  } catch {
    // See this file's header — a lost write is not a crash.
  }
}

export function clearReviewDraft(productSlug: string): void {
  try {
    sessionStorage.removeItem(draftKey(productSlug));
  } catch {
    // See this file's header — same reasoning as writeReviewDraft.
  }
}
