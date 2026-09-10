import { createFileRoute, redirect } from '@tanstack/react-router';
import { ProductForm } from '../../features/catalogue-authoring/product-form.js';
import { loadSessionBootstrap } from '../../shared/session/index.js';

/**
 * S7 — new product (SPEC-0001, TASK-0008). `/products/new` is NOT in `__root.tsx`'s
 * `PUBLIC_ROUTES`, so an anonymous visitor is already bounced to `/sign-in` by the root guard
 * before this file's own `beforeLoad` ever runs. This `beforeLoad` is the SECOND, ADDITIVE check
 * the root guard cannot make on its own (it has no notion of capabilities): a signed-in session
 * that lacks `canManageCatalogue` is redirected to the catalogue, mirroring SPEC-0001's own words
 * — "a visitor who types the URL gets the same answer the server gives… the route redirects."
 *
 * This is a COURTESY gate only. `products.create`'s own `requireCatalogueManager` guard
 * (`@repo/auth`, enforced at the HTTP boundary) is what actually refuses the write regardless of
 * what this redirect does or does not do — see `product-form.tsx`'s own submit handler, which
 * never second-guesses a 403 it might receive anyway.
 */
export const Route = createFileRoute('/products/new')({
  beforeLoad: async ({ context }) => {
    const bootstrap = await loadSessionBootstrap(context.queryClient);
    if (bootstrap === undefined || bootstrap.canManageCatalogue !== true) {
      throw redirect({ to: '/' });
    }
  },
  component: NewProductRoute,
});

/**
 * A ROUTE MODULE, the `sign-in.tsx`/`review-submit`-composing-routes convention: owns navigation
 * only, the `catalogue-authoring` slice owns everything else.
 */
function NewProductRoute() {
  const navigate = Route.useNavigate();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-display">New product</h1>
      <ProductForm
        mode="create"
        onSuccess={(product) => {
          // Lands on the new product's detail page with `created: true` so that route's own
          // effect (`routes/products/$productSlug.tsx`) can focus its heading — "on success focus
          // lands on the new product's heading" (SPEC-0001 S7).
          void navigate({
            to: '/products/$productSlug',
            params: { productSlug: product.slug },
            search: { created: true },
          });
        }}
        onCancel={() => {
          void navigate({ to: '/' });
        }}
      />
    </main>
  );
}
