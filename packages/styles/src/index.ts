/**
 * `@repo/styles` — the design system.
 *
 * SOURCE-SHIPPING PACKAGE (ADR-0001's named exception): this barrel is raw TypeScript, and
 * `package.json`'s `exports` map points at `src/`, not `dist/`. Two reasons, both structural —
 * Tailwind v4 has to *scan* the class strings the primitives emit to generate the CSS for them,
 * and the stylesheet has to reach the consumer's Tailwind pipeline as CSS rather than as a build
 * artifact. `tsc` still builds `dist/` so the type surface and the extraction proof stay honest.
 *
 * The stylesheet is a separate, registered export entry: `@import '@repo/styles/styles.css'`.
 *
 * PRIMITIVES ARE VENDORED, NOT WRITTEN (ADR-0012). Every file in `primitives/` opens with a
 * five-field PROVENANCE header naming its upstream and pin, or `upstream: none` where this repo
 * genuinely authored it. Upstream is a starting point, never an authority — where it disagrees
 * with this repo's accessibility floor, the floor wins, and the divergence is named in the
 * header's `changed:` line. Radix stops here: no app and no other module may import it.
 *
 * Compose these; do not reach past them. A product concept — a rating control, a review card — is
 * built OUT OF these primitives in the feature slice that owns it, never added here.
 */
export { cn } from './class-names.js';
export {
  Button,
  type ButtonProps,
  type ButtonVariants,
  buttonVariants,
} from './primitives/button.js';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  type CardProps,
  CardTitle,
  cardVariants,
} from './primitives/card.js';
export {
  Dialog,
  DialogClose,
  type DialogCloseProps,
  DialogContent,
  type DialogContentProps,
  DialogDescription,
  type DialogDescriptionProps,
  DialogFooter,
  DialogHeader,
  type DialogProps,
  DialogTitle,
  type DialogTitleProps,
  DialogTrigger,
  type DialogTriggerProps,
} from './primitives/dialog.js';
export { FieldError, type FieldErrorProps, fieldErrorVariants } from './primitives/field-error.js';
export { Input, type InputProps, type InputVariants, inputVariants } from './primitives/input.js';
export { Label, type LabelProps, labelVariants } from './primitives/label.js';
export {
  Spinner,
  type SpinnerProps,
  type SpinnerVariants,
  spinnerVariants,
} from './primitives/spinner.js';
export { StarRating, type StarRatingProps } from './primitives/star-rating.js';
