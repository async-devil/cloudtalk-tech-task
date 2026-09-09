// Public barrel — the module's entire public contract (ADR-0003: one barrel, no nested barrels).
export { RATING_RECOMPUTE_OP, REVIEWS_OUTBOX } from './outbox.js';
export {
  type CreateProductInput,
  createProduct,
  type ProductRecord,
  type UpdateProductInput,
  updateProduct,
} from './products.js';
export {
  type ProductRatingRecord,
  type RebuildProductRatingOptions,
  type RebuildProductRatingReport,
  rebuildProductRating,
  recomputeProductRating,
} from './rating.js';
export {
  type ReviewRecord,
  type SubmitReviewInput,
  type SubmitReviewResult,
  submitReview,
} from './reviews.js';
