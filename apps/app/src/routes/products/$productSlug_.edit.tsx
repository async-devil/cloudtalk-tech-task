import { ERROR_CODE } from '@repo/kernel';
import { Card, CardContent } from '@repo/styles';
import { createFileRoute, type ErrorComponentProps, Link, redirect } from '@tanstack/react-router';
import { ProductForm } from '../../features/catalogue-authoring/product-form.js';
import {
  productDetailQueryOptions,
  useProductDetail,
} from '../../features/product-detail/use-product-detail.js';
import { toApiError } from '../../shared/errors/index.js';
import { loadSessionBootstrap } from '../../shared/session/index.js';

/**
 * S7 — edit product (SPEC-0001, TASK-0008), `/products/$productSlug/edit`.
 *
 * FILE NAME NOTE: `$productSlug_` (trailing underscore) rather than `$productSlug`, deliberately —
 * TanStack Router's file-based routing resolves a route's parent by walking its RAW path (before
 * the underscore is stripped) up the already-registered route paths; without the underscore this
 * file's raw path (`/products/$productSlug/edit`) would match `products/$productSlug.tsx`'s
 * registered `/products/$productSlug` as a prefix and this route would be auto-nested INSIDE that
 * route's component tree — which renders no `<Outlet/>` (it is a full leaf, not a layout), so the
 * edit screen would simply never appear. The trailing underscore ("non-nested routes") makes this
 * file's raw path `/products/$productSlug_/edit`, which matches no registered parent, so it
 * attaches directly under root instead — while the CLEANED path (what actually resolves at
 * runtime, and what `useParams()` sees) still has the underscore stripped:
 * `/products/$productSlug/edit`, param name `productSlug`. Verified by reading
 * `@tanstack/router-generator`'s `RoutePrefixMap`/`removeUnderscoresFromSegment` directly, and by
 * inspecting the regenerated `routeTree.gen.ts` after `tsr generate` (this route parents under
 * `rootRouteImport`, not `ProductsProductSlugRoute`).
 */
export const Route = createFileRoute('/products/$productSlug_/edit')({
  beforeLoad: async ({ context, params }) => {
    const bootstrap = await loadSessionBootstrap(context.queryClient);
    if (bootstrap === undefined || bootstrap.canManageCatalogue !== true) {
      // "redirects to the product or the catalogue" (SPEC-0001) — the product is the more useful
      // landing spot here since it is already known to exist and is one click away either way.
      throw redirect({ to: '/products/$productSlug', params: { productSlug: params.productSlug } });
    }
  },
  // Reuses `product-detail`'s own query options — routes composing two slices is sanctioned
  // (`products/$productSlug.tsx` already composes `product-detail` + `review-submit` the same
  // way), a feature slice importing another is not.
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(productDetailQueryOptions(params.productSlug));
  },
  errorComponent: EditProductErrorComponent,
  component: EditProductRoute,
});

/** Mirrors `products/$productSlug.tsx`'s `ProductDetailErrorComponent` — small enough that
 * duplicating it beats inventing a shared route-level helper for two call sites (CLAUDE.md bans a
 * `utils/`/`helpers/` folder, and a two-consumer abstraction this thin is not worth a new file). */
function EditProductErrorComponent({ error }: ErrorComponentProps) {
  const apiError = toApiError(error);
  if (apiError.code !== ERROR_CODE.NotFound) {
    throw error;
  }
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <p role="alert">This product doesn't exist.</p>
          <Link to="/">Back to the catalogue</Link>
        </CardContent>
      </Card>
    </main>
  );
}

function EditProductRoute() {
  const { productSlug } = Route.useParams();
  const navigate = Route.useNavigate();
  // The loader already `ensureQueryData`d this — a cache hit in the common case, same precedent
  // `products/$productSlug.tsx`'s own `useProductDetail` call documents.
  const query = useProductDetail(productSlug);

  function backToProduct(): void {
    void navigate({ to: '/products/$productSlug', params: { productSlug } });
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-display">Edit product</h1>
      {query.data !== undefined && (
        <ProductForm
          mode="edit"
          product={query.data}
          onSuccess={backToProduct}
          onCancel={backToProduct}
        />
      )}
    </main>
  );
}
