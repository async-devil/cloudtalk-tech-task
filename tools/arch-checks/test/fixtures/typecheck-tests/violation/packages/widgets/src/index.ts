// The module under test. Identical in both fixture trees: what differs is the TEST file, because
// this gate exists to catch a type error the package's own `include: ["src"]` cannot see.
export function widgetName(id: number): string {
  return `widget-${id}`;
}
