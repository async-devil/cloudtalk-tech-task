// The deep-import rule is dep-cruiser's own `no-cross-module-internals`; this proves it fires for
// a PRIMITIVE path too, not just a plain internal/ file.
//
// Reaching past the barrel into a primitive's file is what breaks re-copy: the vendored file's
// path is an implementation detail that changes when upstream reorganises, while the barrel is the
// contract. `@repo/styles/styles.css` is the only sanctioned subpath.
import { Button } from '@repo/widgets/src/primitives/button';

export const screen = Button;
