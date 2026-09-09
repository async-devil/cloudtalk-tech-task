# TASK-9999 — Widgets (fixture record)

Status: done (fixture stand-in for a real task record).

## Observability

Spans: `widgets.widget.create`.

| instrument | kind | attributes | semantics |
|---|---|---|---|
| `widgets.widget.create` | counter | Outcome | one tick per create |
| `widgets.widget.retire` | counter | Outcome | retired — superseded by the renamed instrument |
