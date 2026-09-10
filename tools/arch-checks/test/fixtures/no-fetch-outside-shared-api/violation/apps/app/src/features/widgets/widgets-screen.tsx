// Fixture: a feature slice calling `fetch(` directly — exactly the call site this gate exists to
// catch (ADR-0012: network access goes through `shared/api` only).
export async function loadWidgets(): Promise<unknown> {
  const response = await fetch('/api/widgets');
  return response.json();
}
