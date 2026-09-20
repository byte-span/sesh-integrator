---
name: sesh-integrator local dashboard
description: Compact, calm views of saved session progress.
rounded:
  control: "7px"
  panel: "10px"
typography:
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
---

# Design System: sesh-integrator

## Overview

A compact, calm desktop workspace for scanning saved progress and finding the
next action. The implemented source of truth is `src/dashboard-web-assets.ts`;
`PRODUCT.md` records the agreed product brief. Use restrained typography, clear
boundaries, and actual session content. All assets ship locally: system fonts,
CSS, and a text wordmark; no external imagery, icon packs, or font requests.

## Colors

Use the existing CSS variables for both themes; never introduce fixed light-only
colors into components.

| Token        | Light     | Dark      | Role                                    |
| ------------ | --------- | --------- | --------------------------------------- |
| `--bg`       | `#f6f7f9` | `#131922` | Canvas and next-action inset            |
| `--surface`  | `#fff`    | `#19212d` | Navigation, panels, controls            |
| `--ink`      | `#202936` | `#e6edf7` | Main text                               |
| `--muted`    | `#596579` | `#a5b3c7` | Metadata and labels                     |
| `--line`     | `#d9dfe7` | `#354257` | Dividers and borders                    |
| `--accent`   | `#2154bd` | `#9ebeff` | Selection, links, focus, primary action |
| `--selected` | `#edf3ff` | `#253957` | Selected repository/session             |
| `--hover`    | `#f1f4f8` | `#222d3d` | Hovered controls                        |
| `--success`  | `#216847` | `#88d6ac` | Finished status and connection          |
| `--warning`  | `#885008` | `#f0c27e` | Attention required                      |
| `--danger`   | `#ab3030` | `#ffa3a3` | Errors                                  |
| `--code`     | `#edf0f5` | `#111823` | Saved records and output                |

Theme defaults to the system preference and remembers an explicit choice locally.
Status always has a text label alongside its color.

## Typography

Use the system sans-serif stack above. Page titles are 28px; detail titles 19px;
section headings 13–16px; metadata 11–12px. Session titles use 14px semibold with
1.5 line height. Body paragraphs use 1.55 line height. Counts and timestamps use
tabular numerals. Long titles and paths wrap rather than widen the workspace.

## Layout

Desktop uses a 70px header, a resizable repository sidebar (210px by default),
and main content with 32px
padding and a maximum width of 1800px. Search and filters precede a bordered
list/detail split with independently scrolling panes. Session rows use 18px
padding; details use 24px. At 1600px and above, increase main and row spacing.

The sidebar divider supports pointer dragging, arrow keys (10px; Shift: 40px),
Home/End, and double-click reset. Its width is 170–440px, further clamped to
leave 600px for the main content, and remembered in browser storage per origin.
At 1100px and below, default the sidebar to 170px and place search above filters.
At 800px and below, hide the resize divider; repository navigation becomes a horizontal strip and the
session detail replaces the list, with “Back to sessions” restoring selection
and focus. Mobile uses 16px horizontal main padding and a 26px page title.

## Elevation & Depth

Use flat surfaces, thin borders, and tonal insets. Selection adds a 2px inset
accent at the row's left edge. Reserve overlays for native confirmation dialogs;
do not turn routine session content into floating cards.

## Shapes

Controls and next-action insets use the control radius; the main split uses the
panel radius. Rows remain rectangular and share horizontal dividers.

## Components

- Repository buttons show active-session counts. Session rows show repository,
  status, title, current task, checklist progress, and update time.
- Detail orders status and title before next action, lifecycle controls,
  follow-ups, checklist, saved milestones, and expandable recovery records.
- Native labelled inputs and selects support search, filtering, and sorting.
  Checklist items and statuses are read-only in the web interface. Lifecycle actions open an explicit confirmation dialog; blocked
  actions remain disabled with visible reasons.
- Keep the skip link, semantic buttons, selected-state attributes, status/error
  announcements, and 2px accent focus outline with 3px offset. `/` focuses search
  outside forms and dialogs. Preserve focus and detail scroll during updates.
- Empty, disconnected, and error states explain what happened and the next step.
  Command output remains selectable and keyboard-scrollable. No decorative
  animation is required.

## Do's and Don'ts

- Keep saved progress distinct from agent liveness in labels and supporting copy.
- Keep actions and recovery details readable in both themes and narrow layouts.
- Preserve the quiet list/detail hierarchy; avoid decorative charts, gradients,
  oversized headings, and repetitive status cards.
- Do not add external asset dependencies or replace status words with color alone.
