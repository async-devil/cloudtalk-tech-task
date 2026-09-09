// Fixture: an app-side file OUTSIDE the allowed subtrees (src/http/**, src/routes/**,
// src/runtime/**) calling console directly — must be flagged.
export function checkout(): void {
  console.error('checkout failed');
}
