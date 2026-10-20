# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

Developers using sesh-integrator need to see saved session progress across local
repositories, identify blockers, and find or run the next integration step.
The CLI remains the primary interface; the browser dashboard is an optional view
of the same runtime and lifecycle.

## Operating context

Run `seshx dashboard --web` on the machine holding the sessions. The command
opens a loopback URL and stays in the foreground until stopped. No accounts,
remote access service, database, external assets, or installed daemon are needed.

## Capabilities and constraints

Browse and filter sessions, inspect read-only checklists and recovery details,
and explicitly run existing CLI lifecycle actions. Agents maintain checklist
items and statuses through the CLI. Saved status does not establish
agent process liveness. CLI safeguards and retained coordinators remain the
mutation authority. Session/configuration changes invalidate stale confirmations.
Settings edits a fixed set of global and per-repository `config.json` values
with the same validation the CLI applies on load. Its JSON tab edits the whole
file, including commands, under the same validation, locks and stale-edit
checks; repository registrations stay CLI-owned.

## Interface brief

The agreed brief is a compact, calm desktop interface with repository navigation,
searchable sessions, and a detail pane. Provide light/dark themes, keyboard access,
and a dedicated detail view on smaller screens. Use actual saved data; synthetic
content is for tests only.
