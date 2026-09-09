# @repo/widgets

Fixture module: the telemetry-map gate's green case.

## Telemetry

Source record: [TASK-9999](../../docs/tasks/TASK-9999-widgets-spec.md).

**Spans:**

- `widgets.widget.create` — one span per create call.

**Instruments:**

| instrument | kind | attributes | values / semantics |
|---|---|---|---|
| `widgets.widget.create` | counter | Outcome | one tick per create |
| `widgets.widget.purge` | counter | Outcome | one tick per purge. (amends [TASK-9999](../../docs/tasks/TASK-9999-widgets-spec.md), 2026-07-24: renamed from `widgets.widget.retire` after the freeze) |
