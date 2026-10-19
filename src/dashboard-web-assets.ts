// Embedded assets ship with the TypeScript build; no CDN, bundler or network fonts.
export const webHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Sessions · sesh-integrator</title>
    <link rel="stylesheet" href="/app.css" />
    <script src="/app.js" defer></script>
  </head>
  <body>
    <a class="skip" href="#sessions">Skip to sessions</a>
    <header>
      <a class="brand" href="/">sesh<span> / </span>integrator</a>
      <div class="header-actions">
        <span id="connection" role="status" tabindex="0" title="Connecting…">
          <!-- Artwork: user-supplied satellite-radar-svgrepo-com.svg (SVG Repo). -->
          <svg class="satellite" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
            <path class="satellite-dish" d="M16,28V24.96a9.9124,9.9124,0,0,0,7.3179-2.208,1.8482,1.8482,0,0,0,.6777-1.3344,1.8,1.8,0,0,0-.5239-1.36L18.4141,15,21,12.4141,19.5859,11,17,13.5859,11.9419,8.5273a1.8145,1.8145,0,0,0-1.36-.5229,1.845,1.845,0,0,0-1.3339.6782,9.9566,9.9566,0,0,0-.5127,11.95L6.2793,28H2v2H30V28ZM10.68,10.0938,21.9058,21.32A8.0011,8.0011,0,0,1,10.68,10.0938ZM14,28H8.3875l1.8757-5.627A9.9894,9.9894,0,0,0,14,24.5435Z" />
            <g class="satellite-signals">
              <path class="signal signal-near" d="M26,14H24a6.0067,6.0067,0,0,0-6-6V6A8.0092,8.0092,0,0,1,26,14Z" />
              <path class="signal signal-far" d="M30,14H28A10.0113,10.0113,0,0,0,18,4V2A12.0137,12.0137,0,0,1,30,14Z" />
            </g>
          </svg>
          <span id="connection-label">Connecting…</span>
        </span
        ><button id="theme" type="button">Dark theme</button>
      </div>
    </header>
    <div id="error" role="alert" hidden></div>
    <div class="workspace">
      <aside id="repository-panel" class="repositories">
        <h2>Repositories</h2>
        <nav id="repositories" aria-label="Repositories"></nav>
        <div
          id="repository-resizer"
          role="separator"
          tabindex="0"
          aria-label="Repository panel width"
          aria-controls="repository-panel"
          aria-orientation="vertical"
          aria-valuemin="170"
          aria-valuemax="440"
          aria-valuenow="210"
          title="Drag to resize. Arrow keys adjust width; double-click to reset."
        ></div>
      </aside>
      <main id="sessions" tabindex="-1">
        <div class="page-heading">
          <div class="page-title">
            <h1>Sessions</h1>
            <span id="count" class="count" title="Loading sessions…">…</span>
          </div>
          <div class="toolbar">
            <label class="search"
              ><span class="visually-hidden">Search sessions</span
              ><svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" /></svg
              ><input
                id="search"
                type="search"
                placeholder="Search sessions…"
                title="Search by task, branch or repository. Press / to focus."
                autocomplete="off" /></label
            ><label
              ><span class="visually-hidden">Show</span
              ><select id="filter">
                <option value="active">Active</option>
                <option value="attention">Needs attention</option>
                <option value="finished">Finished</option>
                <option value="all">All sessions</option>
              </select></label
            ><label
              ><span class="visually-hidden">Sort</span
              ><select id="sort">
                <option value="updated">Latest update</option>
                <option value="priority">Needs attention first</option>
                <option value="repository">Repository</option>
              </select></label
            >
          </div>
          <button
            id="refresh"
            class="icon-button"
            type="button"
            aria-label="Refresh"
            title="Refresh sessions"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
              <path d="M4 4v4h4" />
              <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
              <path d="M20 20v-4h-4" />
            </svg>
          </button>
        </div>
        <div class="split">
          <section class="session-list" aria-label="Session list">
            <table id="session-table" class="session-table">
              <thead>
                <tr>
                  <th scope="col" class="col-title">Session</th>
                  <th scope="col" class="col-repository">Repository</th>
                  <th scope="col" class="col-task">Current task</th>
                  <th scope="col" class="col-progress">Tasks</th>
                  <th scope="col" class="col-status">Status</th>
                  <th scope="col" class="col-updated">Updated</th>
                </tr>
              </thead>
              <tbody id="rows"></tbody>
            </table>
            <div id="empty" class="empty" hidden>
              <h2>No active sessions</h2>
              <p>Choose All sessions to browse your history.</p>
            </div>
          </section>
          <div
            id="detail-resizer"
            role="separator"
            tabindex="0"
            aria-label="Session details panel width"
            aria-controls="detail"
            aria-orientation="vertical"
            aria-valuemin="240"
            aria-valuemax="800"
            aria-valuenow="320"
            title="Drag to resize. Arrow keys move divider; double-click to reset."
          ></div>
          <section id="detail" class="detail" aria-label="Session details">
            <div class="empty">
              <h2>Your work, in view</h2>
              <p>
                Select a session to see its checklist, saved progress, and next
                action.
              </p>
            </div>
          </section>
        </div>
        <section
          id="command"
          class="command"
          hidden
          aria-label="Command output"
        >
          <div class="section-heading">
            <h2 id="command-title">Command output</h2>
            <span id="command-status" role="status"></span>
          </div>
          <p id="command-session"></p>
          <pre id="output" tabindex="0"></pre>
        </section>
        <footer><span id="refreshed"></span></footer>
      </main>
    </div>
    <dialog
      id="confirm"
      aria-labelledby="form-title"
      aria-describedby="form-description"
    >
      <form id="action-form">
        <h2 id="form-title">Confirm action</h2>
        <p id="form-description"></p>
        <div id="form-fields"></div>
        <p id="form-error" role="alert"></p>
        <div class="form-actions">
          <button id="cancel" type="button">Cancel</button
          ><button id="submit" class="primary" type="submit">
            Run command
          </button>
        </div>
      </form>
    </dialog>
  </body>
</html>
`;

export const webCss = String.raw`:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --surface: #fff;
  --ink: #202936;
  --muted: #596579;
  --line: #d9dfe7;
  --control-border-width: 1px;
  --accent: #2154bd;
  --selected: #edf3ff;
  --hover: #f1f4f8;
  --success: #216847;
  --warning: #885008;
  --danger: #ab3030;
  --code: #edf0f5;
  --radius: 7px;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  font-size: 14px;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #131922;
  --surface: #19212d;
  --ink: #e6edf7;
  --muted: #a5b3c7;
  --line: #354257;
  --accent: #9ebeff;
  --selected: #253957;
  --hover: #222d3d;
  --success: #88d6ac;
  --warning: #f0c27e;
  --danger: #ffa3a3;
  --code: #111823;
}
* {
  box-sizing: border-box;
}
/* Fixed app shell: the page never scrolls. Only the repository nav, session
   list and detail pane scroll (main scrolls only when the window is too short
   to fit the split at its minimum height). */
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}
button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
}
button,
input,
select,
textarea {
  border: var(--control-border-width) solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
button {
  padding: 8px 12px;
  cursor: pointer;
  font-weight: 550;
}
button:hover:not(:disabled) {
  background: var(--hover);
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
input,
select,
textarea {
  padding: 9px 10px;
  min-height: 38px;
  max-width: 100%;
  caret-color: var(--accent);
}
textarea {
  width: 100%;
  min-height: 95px;
  resize: vertical;
}
a {
  color: var(--accent);
  text-underline-offset: 3px;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
::selection {
  background: var(--accent);
  color: var(--surface);
}
* {
  scrollbar-color: var(--line) var(--surface);
  scrollbar-width: thin;
}
[hidden] {
  display: none !important;
}
h1,
h2,
h3,
p {
  margin-top: 0;
}
h1 {
  font-size: 28px;
  letter-spacing: -0.025em;
  margin-bottom: 6px;
}
h2 {
  font-size: 16px;
  letter-spacing: -0.01em;
}
h3 {
  font-size: 13px;
  margin: 24px 0 12px;
}
p {
  line-height: 1.55;
}
header {
  flex-shrink: 0;
  height: 70px;
  padding: 0 28px;
  display: flex;
  align-items: center;
  gap: 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.brand {
  text-decoration: none;
  color: var(--ink);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.025em;
  white-space: nowrap;
}
.brand span {
  color: var(--muted);
  font-weight: 400;
}
.header-actions {
  margin-left: auto;
  display: flex;
  gap: 18px;
  align-items: center;
}
#connection {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
#connection.connected {
  color: var(--success);
}
.satellite {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  color: var(--muted);
  transform: scaleX(-1);
}
.satellite path {
  /* Filled outlines are 2 SVG units wide. At 36px / 32 units, trim them
     to twice the control border width in screen pixels. */
  stroke: var(--surface);
  stroke-width: calc(2px - var(--control-border-width) * 2 * 32 / 36);
  stroke-linejoin: round;
}
.satellite-dish {
  opacity: 0.5;
}
.satellite-signals {
  color: var(--success);
}
.signal {
  opacity: 0.16;
  transform-origin: 18px 14px;
}
#connection:not(.connected) .satellite-signals {
  color: var(--muted);
}
#connection.connected .signal {
  animation: satellite-signal 2.8s ease-out infinite;
}
#connection.connected .signal-far {
  animation-delay: 0.3s;
}
html.page-hidden #connection.connected .signal {
  animation-play-state: paused;
}
#connection.connected #connection-label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@keyframes satellite-signal {
  0%, 70%, 100% { opacity: 0.16; transform: scale(0.94); }
  18% { opacity: 1; transform: scale(1); }
  48% { opacity: 0.16; transform: scale(1.06); }
}
@media (prefers-reduced-motion: reduce) {
  #connection.connected .signal { animation: none; opacity: 1; }
}
.workspace {
  display: grid;
  grid-template-columns: var(--repository-width, 210px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.repositories {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding: 32px 16px;
  background: var(--surface);
  border-right: 1px solid var(--line);
}
#repository-resizer {
  position: absolute;
  inset: 0 -6px 0 auto;
  width: 12px;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
}
#repository-resizer:focus {
  outline: none;
}
#repository-resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 5px;
  width: 1px;
  background: var(--line);
}
#repository-resizer:hover::after,
#repository-resizer:focus-visible::after,
.resizing-repository #repository-resizer::after {
  left: 4px;
  width: 3px;
  background: color-mix(in srgb, var(--line) 35%, var(--muted));
}
.resizing-repository,
.resizing-repository *,
.resizing-detail,
.resizing-detail * {
  cursor: col-resize !important;
  user-select: none;
}
#detail-resizer {
  position: relative;
  width: 12px;
  margin-left: -6px;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
}
#detail-resizer:focus {
  outline: none;
}
#detail-resizer::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 6px;
  width: 1px;
  background: var(--line);
}
#detail-resizer:hover::after,
#detail-resizer:focus-visible::after,
.resizing-detail #detail-resizer::after {
  left: 5px;
  width: 3px;
  background: color-mix(in srgb, var(--line) 35%, var(--muted));
}
.repositories h2 {
  padding-left: 12px;
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}
.repositories nav {
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.repo {
  border-color: transparent;
  background: transparent;
  text-align: left;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  font-size: 13px;
}
.repo span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repo span:last-child {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.repo[aria-current="true"] {
  background: var(--selected);
  color: var(--accent);
}
main {
  display: flex;
  flex-direction: column;
  padding: 20px 32px 12px;
  min-width: 0;
  min-height: 0;
  max-width: 1800px;
  width: 100%;
  margin: 0 auto;
  overflow-y: auto;
}
main > * {
  flex-shrink: 0;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.page-heading {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}
.page-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-right: 16px;
}
.page-title h1 {
  margin: 0;
  line-height: 1.2;
}
.count {
  min-width: 26px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--selected);
  color: var(--accent);
  font-size: 13px;
  font-weight: 650;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.toolbar {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 14px;
  align-items: center;
}
.toolbar input,
.toolbar select {
  font-size: 14px;
  color: var(--ink);
}
.search {
  flex: 1;
  min-width: 0;
  position: relative;
}
.search svg {
  position: absolute;
  left: 11px;
  top: 50%;
  width: 17px;
  height: 17px;
  transform: translateY(-50%);
  pointer-events: none;
}
.search input {
  width: 100%;
  padding-left: 36px;
}
.page-heading svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--muted);
}
.icon-button {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 38px;
  padding: 0;
}
.icon-button svg {
  width: 18px;
  height: 18px;
  color: var(--ink);
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 0 var(--detail-width, minmax(0, 0.95fr));
  grid-template-rows: minmax(0, 1fr);
  flex: 1 1 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  overflow: hidden;
  min-height: 240px;
}
.session-list {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  container-type: inline-size;
}
.session-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}
.session-table th,
.session-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.session-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-block: 9px;
  background: var(--surface);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
}
.session-table td {
  color: var(--muted);
}
.col-repository {
  width: 108px;
}
.col-task {
  width: 24%;
}
.col-progress {
  width: 56px;
}
.col-status {
  width: 124px;
}
.col-updated {
  width: 76px;
}
.col-progress,
.col-updated {
  font-variant-numeric: tabular-nums;
}
.single-repository .col-repository {
  display: none;
}
@container (max-width: 700px) {
  .col-task {
    display: none;
  }
}
@container (max-width: 460px) {
  .col-repository,
  .col-progress {
    display: none;
  }
}
.session-row {
  cursor: pointer;
}
.session-row:hover td {
  background: var(--hover);
}
.session-row.selected td {
  background: var(--selected);
}
.session-row.selected td:first-child {
  box-shadow: inset 2px 0 var(--accent);
}
.session-row:has(.row-select:focus-visible) td {
  box-shadow:
    inset 0 2px var(--accent),
    inset 0 -2px var(--accent);
}
.session-row:has(.row-select:focus-visible) td:first-child {
  box-shadow:
    inset 2px 0 var(--accent),
    inset 0 2px var(--accent),
    inset 0 -2px var(--accent);
}
.session-row:has(.row-select:focus-visible) td:last-child {
  box-shadow:
    inset -2px 0 var(--accent),
    inset 0 2px var(--accent),
    inset 0 -2px var(--accent);
}
.row-select,
.row-select:hover:not(:disabled) {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  color: var(--ink);
  font-weight: 600;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-select:focus-visible {
  outline: none;
}
.session-table .status {
  font-size: 12px;
}
.status {
  font-size: 11px;
  white-space: nowrap;
  color: var(--muted);
}
.status.attention {
  color: var(--warning);
}
.status.finished {
  color: var(--success);
}
.status.active {
  color: var(--accent);
}
.detail {
  padding: 24px;
  border-left: 1px solid var(--line);
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.detail h2 {
  font-size: 19px;
  line-height: 1.4;
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.detail .meta {
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.next {
  background: var(--bg);
  padding: 16px;
  border-radius: var(--radius);
  margin: 22px 0;
}
.next h3 {
  margin: 0 0 6px;
}
.next p {
  font-size: 13px;
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.primary {
  background: var(--accent);
  color: var(--surface);
  border-color: var(--accent);
}
.primary:hover:not(:disabled) {
  background: var(--accent);
  filter: brightness(0.92);
}
.action-reasons {
  font-size: 11px;
  color: var(--muted);
  margin: 12px 0;
  line-height: 1.6;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-top: 26px;
  margin-bottom: 12px;
}
.section-heading h2,
.section-heading h3 {
  margin: 0;
}

.tasks {
  list-style: none;
  padding: 0;
  margin: 0;
}
.task {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.task-head {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: start;
}
.task-title {
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.task p {
  color: var(--muted);
  font-size: 12px;
  margin: 6px 0 0;
}

.task-state {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 5px;
}
.task-state.completed {
  color: var(--success);
}
.task-state.blocked {
  color: var(--warning);
}
.task-state.in_progress {
  color: var(--accent);
}
.activity {
  padding-left: 18px;
  font-size: 12px;
  color: var(--muted);
}
.activity li {
  padding: 6px 0;
  line-height: 1.5;
}
.activity time {
  display: block;
  font-variant-numeric: tabular-nums;
}
details {
  margin-top: 24px;
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}
.record {
  margin: 16px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  line-height: 1.8;
  color: var(--muted);
}
.empty {
  padding: 48px 24px;
  color: var(--muted);
  text-align: center;
}
.empty h2 {
  color: var(--ink);
  font-size: 17px;
}
.empty p {
  font-size: 13px;
  margin: 0;
  max-width: 36ch;
  margin-inline: auto;
}
.follow-ups {
  font-size: 13px;
  line-height: 1.6;
  padding-left: 20px;
  overflow-wrap: anywhere;
}
.command {
  margin-top: 24px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 20px;
  background: var(--surface);
}
.command .section-heading {
  margin-top: 0;
}
.command p {
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.command pre {
  background: var(--code);
  padding: 16px;
  max-height: min(320px, 22vh);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
}
.command #command-status {
  font-size: 12px;
}
footer {
  min-height: 18px;
  margin-top: 8px;
  text-align: right;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
#error {
  flex-shrink: 0;
  padding: 14px 28px;
  background: var(--surface);
  color: var(--danger);
  border-bottom: 1px solid var(--line);
}
dialog {
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  width: min(540px, calc(100vw - 32px));
  padding: 28px;
  max-height: 90vh;
  overflow: auto;
}
dialog::backdrop {
  background: rgb(0 0 0 / 0.45);
}
dialog h2 {
  font-size: 21px;
}
dialog p {
  font-size: 13px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
#form-fields label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0;
  font-size: 13px;
}
#form-error {
  color: var(--danger);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}
.skip {
  position: absolute;
  left: 12px;
  top: -100px;
  background: var(--surface);
  padding: 12px;
  z-index: 5;
}
.skip:focus {
  top: 12px;
}
.back {
  display: none;
}
@media (min-width: 1600px) {
  main {
    padding: 24px 48px 14px;
  }
  .detail {
    padding: 30px;
  }
}
@media (max-width: 1100px) {
  .workspace {
    grid-template-columns: var(--repository-width, 170px) minmax(0, 1fr);
  }
  main {
    padding: 20px 20px 12px;
  }
  .split {
    grid-template-columns: minmax(0, 1fr) 0 var(--detail-width, minmax(0, 1fr));
  }
  .page-heading {
    flex-wrap: wrap;
    row-gap: 12px;
  }
  .page-title {
    margin-right: auto;
  }
  .toolbar {
    order: 1;
    flex-basis: 100%;
  }
}
@media (max-width: 800px) {
  #repository-resizer,
  #detail-resizer {
    display: none;
  }
  header {
    padding: 0 16px;
    gap: 12px;
    height: 62px;
  }
  .header-actions {
    gap: 8px;
  }
  #connection {
    max-width: 100px;
    font-size: 11px;
  }
  .brand {
    font-size: 16px;
  }
  .workspace {
    display: flex;
    flex-direction: column;
  }
  .repositories {
    flex-shrink: 0;
    display: block;
    padding: 14px 16px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .repositories h2 {
    display: none;
  }
  .repositories nav {
    flex-direction: row;
    overflow: auto;
  }
  .repo {
    width: auto;
    flex-shrink: 0;
  }
  .repo span:first-child {
    max-width: 180px;
  }
  main {
    flex: 1;
    padding: 16px 16px 10px;
  }
  .split {
    display: flex;
    flex-direction: column;
  }
  .session-list,
  .detail {
    flex: 1;
  }
  .detail {
    display: none;
    border-left: 0;
  }
  .split.show-detail .session-list {
    display: none;
  }
  .split.show-detail .detail {
    display: block;
  }
  .back {
    display: block;
    margin-bottom: 16px;
  }
  .toolbar {
    flex-wrap: wrap;
    gap: 10px;
  }
  .search {
    flex-basis: 100%;
  }
  .toolbar > label:not(.search) {
    flex: 1;
    min-width: 0;
  }
  .toolbar select {
    width: 100%;
  }
  h1 {
    font-size: 24px;
  }
  .header-actions button {
    font-size: 11px;
    padding: 7px;
  }
  .detail {
    padding: 20px;
  }
}
`;

export const webScript = String.raw`"use strict";
function syncPageVisibility() {
  document.documentElement.classList.toggle("page-hidden", document.hidden);
}
document.addEventListener("visibilitychange", syncPageVisibility);
syncPageVisibility();
const $ = (id) => document.getElementById(id);
let state = { rows: [], job: null },
  selected = "",
  repository = "",
  pending = null,
  fetching = false,
  again = false;
const finished = (r) => ["succeeded", "no_changes"].includes(r.status);
const labels = {
  active: "In progress",
  ready: "Ready",
  needs_review: "Needs review",
  validation_pending: "Validation pending",
  promotion_pending: "Promotion pending",
  succeeded: "Integrated",
  no_changes: "No changes",
  empty: "No sessions",
};
const el = (tag, text, className) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
};
const button = (text, fn, cls) => {
  const n = el("button", text, cls);
  n.type = "button";
  n.addEventListener("click", fn);
  return n;
};
const time = (value) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "No saved events";
const shortTime = (value) => {
  if (!value) return "–";
  const d = new Date(value);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const status = (r) =>
  el(
    "span",
    labels[r.status] || r.status.replaceAll("_", " "),
    "status " +
      (r.attention ? "attention" : finished(r) ? "finished" : "active"),
  );
let theme;
try {
  theme = localStorage.getItem("sesh-theme");
} catch {}
if (!["light", "dark"].includes(theme))
  theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
function setTheme() {
  document.documentElement.dataset.theme = theme;
  $("theme").textContent = theme === "dark" ? "Light theme" : "Dark theme";
}
setTheme();
$("theme").onclick = () => {
  theme = theme === "dark" ? "light" : "dark";
  setTheme();
  try {
    localStorage.setItem("sesh-theme", theme);
  } catch {}
};
const repositoryResizer = $("repository-resizer");
const repositoryWidthKey = "sesh-repository-width";
let preferredRepositoryWidth;
let repositoryDrag;
try {
  const saved = Number(localStorage.getItem(repositoryWidthKey));
  if (Number.isFinite(saved) && saved >= 170 && saved <= 440)
    preferredRepositoryWidth = saved;
} catch {}
function repositoryWidthLimit() {
  // Leave enough room for both session panes at intermediate window sizes.
  return Math.max(170, Math.min(440, window.innerWidth - 600));
}
function applyRepositoryWidth() {
  const fallback = window.innerWidth <= 1100 ? 170 : 210;
  const width = Math.round(
    Math.max(
      170,
      Math.min(repositoryWidthLimit(), preferredRepositoryWidth ?? fallback),
    ),
  );
  document.documentElement.style.setProperty(
    "--repository-width",
    width + "px",
  );
  repositoryResizer.setAttribute("aria-valuenow", String(width));
  repositoryResizer.setAttribute(
    "aria-valuemax",
    String(repositoryWidthLimit()),
  );
  repositoryResizer.setAttribute("aria-valuetext", width + " pixels");
  return width;
}
function saveRepositoryWidth() {
  try {
    if (preferredRepositoryWidth === undefined)
      localStorage.removeItem(repositoryWidthKey);
    else
      localStorage.setItem(
        repositoryWidthKey,
        String(preferredRepositoryWidth),
      );
  } catch {}
}
function finishRepositoryDrag(cancel = false) {
  if (!repositoryDrag) return;
  const drag = repositoryDrag;
  repositoryDrag = undefined;
  if (cancel) preferredRepositoryWidth = drag.previous;
  document.documentElement.classList.remove("resizing-repository");
  if (repositoryResizer.hasPointerCapture(drag.id))
    repositoryResizer.releasePointerCapture(drag.id);
  applyRepositoryWidth();
  saveRepositoryWidth();
}
repositoryResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || window.innerWidth <= 800 || repositoryDrag) return;
  event.preventDefault();
  repositoryResizer.focus({ preventScroll: true });
  repositoryDrag = {
    id: event.pointerId,
    x: event.clientX,
    width: applyRepositoryWidth(),
    previous: preferredRepositoryWidth,
  };
  repositoryResizer.setPointerCapture(event.pointerId);
  document.documentElement.classList.add("resizing-repository");
});
repositoryResizer.addEventListener("pointermove", (event) => {
  if (event.pointerId !== repositoryDrag?.id) return;
  preferredRepositoryWidth = Math.max(
    170,
    Math.min(
      repositoryWidthLimit(),
      repositoryDrag.width + event.clientX - repositoryDrag.x,
    ),
  );
  applyRepositoryWidth();
});
repositoryResizer.addEventListener("pointerup", (event) => {
  if (event.pointerId === repositoryDrag?.id) finishRepositoryDrag();
});
repositoryResizer.addEventListener("pointercancel", () =>
  finishRepositoryDrag(true),
);
repositoryResizer.addEventListener("lostpointercapture", () =>
  finishRepositoryDrag(true),
);
repositoryResizer.addEventListener("dblclick", () => {
  finishRepositoryDrag(true);
  preferredRepositoryWidth = undefined;
  applyRepositoryWidth();
  saveRepositoryWidth();
});
repositoryResizer.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    finishRepositoryDrag(true);
    return;
  }
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  finishRepositoryDrag();
  const step = event.shiftKey ? 40 : 10;
  preferredRepositoryWidth =
    event.key === "Home"
      ? 170
      : event.key === "End"
        ? repositoryWidthLimit()
        : applyRepositoryWidth() + (event.key === "ArrowLeft" ? -step : step);
  preferredRepositoryWidth = applyRepositoryWidth();
  saveRepositoryWidth();
});
window.addEventListener("resize", () => {
  finishRepositoryDrag(true);
  applyRepositoryWidth();
});
applyRepositoryWidth();
const detailResizer = $("detail-resizer");
const split = document.querySelector(".split");
const detailWidthKey = "sesh-detail-width";
let preferredDetailWidth;
let detailDrag;
try {
  const saved = Number(localStorage.getItem(detailWidthKey));
  if (Number.isFinite(saved) && saved >= 240)
    preferredDetailWidth = saved;
} catch {}
function detailWidthBounds() {
  const available = split.clientWidth;
  const min = Math.min(240, available / 2);
  return { min, max: Math.max(min, available - 240), available };
}
function applyDetailWidth() {
  if (window.innerWidth <= 800) return 0;
  const { min, max, available } = detailWidthBounds();
  const fallback = available * (window.innerWidth <= 1100 ? 0.5 : 0.95 / 1.95);
  const width = Math.round(Math.max(min, Math.min(max, preferredDetailWidth ?? fallback)));
  split.style.setProperty("--detail-width", width + "px");
  detailResizer.setAttribute("aria-valuemin", String(Math.round(min)));
  detailResizer.setAttribute("aria-valuemax", String(Math.round(max)));
  detailResizer.setAttribute("aria-valuenow", String(width));
  detailResizer.setAttribute("aria-valuetext", width + " pixels");
  return width;
}
function saveDetailWidth() {
  try {
    if (preferredDetailWidth === undefined) localStorage.removeItem(detailWidthKey);
    else localStorage.setItem(detailWidthKey, String(preferredDetailWidth));
  } catch {}
}
function finishDetailDrag(cancel = false) {
  if (!detailDrag) return;
  const drag = detailDrag;
  detailDrag = undefined;
  if (cancel) preferredDetailWidth = drag.previous;
  document.documentElement.classList.remove("resizing-detail");
  if (detailResizer.hasPointerCapture(drag.id)) detailResizer.releasePointerCapture(drag.id);
  applyDetailWidth();
  saveDetailWidth();
}
detailResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || window.innerWidth <= 800 || detailDrag) return;
  event.preventDefault();
  detailResizer.focus({ preventScroll: true });
  detailDrag = { id: event.pointerId, x: event.clientX, width: applyDetailWidth(), previous: preferredDetailWidth };
  detailResizer.setPointerCapture(event.pointerId);
  document.documentElement.classList.add("resizing-detail");
});
detailResizer.addEventListener("pointermove", (event) => {
  if (event.pointerId !== detailDrag?.id) return;
  const { min, max } = detailWidthBounds();
  preferredDetailWidth = Math.max(min, Math.min(max, detailDrag.width + detailDrag.x - event.clientX));
  applyDetailWidth();
});
detailResizer.addEventListener("pointerup", (event) => {
  if (event.pointerId === detailDrag?.id) finishDetailDrag();
});
detailResizer.addEventListener("pointercancel", () => finishDetailDrag(true));
detailResizer.addEventListener("lostpointercapture", () => finishDetailDrag(true));
detailResizer.addEventListener("dblclick", () => {
  finishDetailDrag(true);
  preferredDetailWidth = undefined;
  applyDetailWidth();
  saveDetailWidth();
});
detailResizer.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { finishDetailDrag(true); return; }
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  finishDetailDrag();
  const { min, max } = detailWidthBounds();
  const step = event.shiftKey ? 40 : 10;
  preferredDetailWidth = event.key === "Home" ? min : event.key === "End" ? max : applyDetailWidth() + (event.key === "ArrowLeft" ? step : -step);
  preferredDetailWidth = applyDetailWidth();
  saveDetailWidth();
});
window.addEventListener("resize", () => {
  finishDetailDrag(true);
  applyDetailWidth();
});
// Sidebar resizing also changes the space available to the session panes.
new ResizeObserver(() => applyDetailWidth()).observe(split);
applyDetailWidth();
function visible() {
  const q = $("search").value.toLocaleLowerCase(),
    filter = $("filter").value;
  return state.rows
    .filter(
      (r) =>
        (!repository || r.repository === repository) &&
        (filter === "all" ||
          (filter === "active" && r.status !== "empty" && !finished(r)) ||
          (filter === "finished" && finished(r)) ||
          (filter === "attention" && r.attention)) &&
        [
          r.title,
          r.repository,
          r.branch,
          r.id,
          ...r.tasks.flatMap((t) => [t.title, t.description, t.reason]),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q),
    )
    .sort(
      (a, b) =>
        ($("sort").value === "priority"
          ? Number(b.attention) - Number(a.attention)
          : $("sort").value === "repository"
            ? a.repository.localeCompare(b.repository)
            : 0) || b.updated - a.updated,
    );
}
function renderRepositories() {
  const nav = $("repositories"),
    focused = document.activeElement?.dataset.repo;
  nav.replaceChildren();
  const paths = [...new Set(state.rows.map((r) => r.repository))].sort();
  for (const path of ["", ...paths]) {
    const count = state.rows.filter(
      (r) =>
        (!path || r.repository === path) &&
        r.status !== "empty" &&
        !finished(r),
    ).length;
    const b = button("", () => {
      repository = path;
      render();
    });
    b.className = "repo";
    b.dataset.repo = path;
    b.title = path || "All repositories";
    b.setAttribute("aria-current", String(repository === path));
    b.append(
      el("span", path ? path.split(/[\\/]/).pop() : "All repositories"),
      el("span", String(count)),
    );
    nav.append(b);
    if (focused === path) b.focus();
  }
}
function render() {
  renderRepositories();
  const rows = visible();
  if (!rows.some((r) => r.id === selected)) selected = rows[0]?.id || "";
  const summary =
    (rows.length === 1 ? " session" : " sessions") +
    (repository ? " in " + repository : " across your local repositories");
  $("count").replaceChildren(
    String(rows.length),
    el("span", summary, "visually-hidden"),
  );
  $("count").title = rows.length + summary;
  $("refreshed").replaceChildren(
    ...(state.refreshedAt
      ? ["Updated ", time(state.refreshedAt)]
      : []),
  );
  $("session-table").classList.toggle("single-repository", !!repository);
  const list = $("rows"),
    focusId = document.activeElement?.dataset.session;
  list.replaceChildren();
  for (const r of rows) {
    const tr = el("tr", undefined, "session-row");
    tr.classList.toggle("selected", r.id === selected);
    tr.addEventListener("click", () => {
      selected = r.id;
      render();
      document.querySelector(".split").classList.add("show-detail");
      if (matchMedia("(max-width:800px)").matches) {
        $("detail").tabIndex = -1;
        $("detail").focus();
      }
    });
    const b = el("button", r.title, "row-select");
    b.type = "button";
    b.dataset.session = r.id;
    b.setAttribute("aria-pressed", String(r.id === selected));
    b.title = r.branch ? r.title + "\n" + r.branch : r.title;
    const cell = (className, ...content) => {
      const td = el("td", undefined, className);
      td.append(...content);
      return td;
    };
    const done = r.tasks.filter((t) => t.status === "completed").length;
    const repositoryCell = cell("col-repository", r.repositoryName),
      taskCell = cell("col-task", r.current),
      progressCell = cell(
        "col-progress",
        r.tasks.length ? done + "/" + r.tasks.length : "–",
      ),
      updatedCell = cell("col-updated", shortTime(r.updated));
    repositoryCell.title = r.repository;
    taskCell.title = r.current;
    progressCell.title = r.progress;
    updatedCell.title = time(r.updated);
    tr.append(
      cell("col-title", b),
      repositoryCell,
      taskCell,
      progressCell,
      cell("col-status", status(r)),
      updatedCell,
    );
    list.append(tr);
    if (focusId === r.id) b.focus();
  }
  $("empty").hidden = rows.length > 0;
  if (!rows.length) {
    const noData = !state.rows.length;
    $("empty").replaceChildren(
      el("h2", noData ? "No sessions yet" : "No matching sessions"),
      el(
        "p",
        noData
          ? "Run seshx register --auto-config, then seshx begin in your repository."
          : "Try another filter or clear your search.",
      ),
    );
  }
  renderDetail(rows.find((r) => r.id === selected));
  renderJob();
}
let detailKey = "";
function renderDetail(r) {
  const pane = $("detail");
  const key = JSON.stringify([r, !!state.job?.running]);
  if (detailKey === key) return;
  const oldId = pane.dataset.session,
    scroll = pane.scrollTop,
    focus = document.activeElement?.dataset.control,
    expanded = pane.querySelector("details")?.open;
  detailKey = key;
  pane.dataset.session = r?.id || "";
  pane.replaceChildren();
  pane.append(
    button(
      "Back to sessions",
      () => {
        document.querySelector(".split").classList.remove("show-detail");
        Array.from(document.querySelectorAll(".row-select"))
          .find((n) => n.dataset.session === selected)
          ?.focus();
      },
      "back",
    ),
  );
  if (!r) {
    const empty = el("div", undefined, "empty");
    empty.append(
      el("h2", "Your work, in view"),
      el(
        "p",
        "Select a session to see its checklist, saved progress, and next action.",
      ),
    );
    pane.append(empty);
    return;
  }
  pane.append(
    status(r),
    el("h2", r.title),
    el("p", r.repositoryName + (r.branch ? " / " + r.branch : ""), "meta"),
  );
  const next = el("div", undefined, "next");
  next.append(el("h3", "Next action"), el("p", r.next));
  pane.append(next);
  const actions = el("div", undefined, "actions"),
    reasons = [];
  for (const a of ["validate", "integrate", "resume"]) {
    const label = a[0].toUpperCase() + a.slice(1),
      b = button(
        label,
        () => actionForm(r, a),
        a === "integrate" && !r.actions[a] ? "primary" : "",
      );
    b.dataset.control = a;
    b.disabled = !!r.actions[a] || !!state.job?.running;
    b.title =
      r.actions[a] ||
      (state.job?.running
        ? "A dashboard command is running"
        : label + " this session");
    actions.append(b);
    if (r.actions[a]) reasons.push(label + ": " + r.actions[a]);
  }
  pane.append(actions, el("p", reasons.join(" · "), "action-reasons"));
  if (r.pullRequestUrl) {
    const p = el("p");
    const link = el("a", "Open pull request");
    link.href = r.pullRequestUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    p.append(link);
    pane.append(p);
  }
  if (r.followUps.length) {
    pane.append(el("h3", "Outstanding follow-ups"));
    const ul = el("ul", undefined, "follow-ups");
    r.followUps.forEach((f) => ul.append(el("li", f)));
    pane.append(ul);
  }
  const heading = el("div", undefined, "section-heading");
  heading.append(el("h3", "Checklist · " + r.progress));
  pane.append(heading);
  const tasks = el("ol", undefined, "tasks");
  for (const task of r.tasks) {
    const li = el("li", undefined, "task");
    li.append(
      el("div", task.status.replaceAll("_", " "), "task-state " + task.status),
    );
    const head = el("div", undefined, "task-head");
    head.append(el("span", task.title, "task-title"));
    li.append(head);
    if (task.description) li.append(el("p", task.description));
    if (task.reason) li.append(el("p", "Reason: " + task.reason));
    tasks.append(li);
  }
  pane.append(tasks);
  if (!r.tasks.length)
    pane.append(el("p", "No checklist recorded yet.", "meta"));
  pane.append(el("h3", "Saved milestones"));
  if (!r.activity.length)
    pane.append(
      el("p", "No validation or promotion milestones recorded yet.", "meta"),
    );
  else {
    const ul = el("ul", undefined, "activity");
    for (const item of r.activity) {
      const li = el("li", item.text.split(" | ")[0]);
      const t = el("time", time(item.at));
      t.dateTime = item.at;
      li.append(t);
      ul.append(li);
    }
    pane.append(ul);
  }
  const details = el("details");
  details.open = oldId === r.id && expanded;
  details.append(
    el("summary", "Session record & recovery details"),
    el("pre", r.details.join("\n"), "record"),
  );
  pane.append(details);
  pane.scrollTop = oldId === r.id ? scroll : 0;
  if (focus && oldId === r.id)
    pane.querySelector('[data-control="' + focus + '"]')?.focus();
}
function renderJob() {
  const job = state.job;
  $("command").hidden = !job;
  if (!job) return;
  $("command-title").textContent =
    job.action.replaceAll("-", " ") + " · command output";
  $("command-session").textContent = job.session;
  $("command-status").textContent = job.running
    ? "Running…"
    : job.code === 0
      ? "Completed"
      : "Failed · exit " + job.code;
  const output = $("output"),
    atEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
  output.textContent = job.output || "Waiting for command output…";
  if (atEnd) output.scrollTop = output.scrollHeight;
}
function field(label, kind, value, id) {
  const l = el("label", label);
  const input = el(kind);
  input.id = id;
  input.value = value || "";
  l.append(input);
  $("form-fields").append(l);
  return input;
}
function startForm(r, title, description) {
  pending = { session: r.id, revision: r.revision };
  $("form-title").textContent = title;
  $("form-description").textContent = description;
  $("form-fields").replaceChildren();
  $("form-error").textContent = "";
  $("submit").disabled = false;
}
function showForm() {
  $("confirm").showModal();
  $("form-fields").querySelector("input,textarea,select")?.focus();
}
function actionForm(r, action) {
  startForm(
    r,
    "Confirm " + action,
    r.title +
      " — runs in " +
      r.repository +
      ". The CLI checks the current Git state and session prerequisites.",
  );
  pending.action = action;
  $("submit").textContent = "Run " + action;
  if (action === "integrate") {
    $("form-description").textContent +=
      " Integration can promote the target branch and publish its configured pull request.";
    field("Completion summary", "textarea", r.summary, "summary").required =
      true;
    const rollout = field("External rollout", "select", "", "rollout");
    for (const [value, label] of [
      ["none", "None — no external changes"],
      ["applied", "Applied — already completed"],
      ["automated", "Automated — delegated"],
      ["manual", "Manual — follow-ups required"],
    ]) {
      const option = el("option", label);
      option.value = value;
      rollout.append(option);
    }
    rollout.value = r.rollout;
    const follow = field(
      "Manual follow-ups (one per line, each starting with its TASKS.json ID)",
      "textarea",
      r.followUps.join("\n"),
      "followups",
    );
    const update = () => {
      follow.parentElement.hidden = rollout.value !== "manual";
      follow.required = rollout.value === "manual";
    };
    rollout.onchange = update;
    update();
  }
  showForm();
}
$("cancel").onclick = () => {
  $("confirm").close();
};
$("confirm").addEventListener("close", () => {
  pending = null;
});
$("action-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!pending) return;
  const request = structuredClone(pending);
  if (request.action === "integrate")
    request.input = {
      summary: $("summary").value,
      rollout: $("rollout").value,
      followUps:
        $("rollout").value === "manual"
          ? $("followups")
              .value.split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
    };
  $("submit").disabled = true;
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sesh-Dashboard": "1" },
      body: JSON.stringify(request),
    });
    const result = await res.json();
    if (!res.ok) throw Error(result.error);
    $("confirm").close();
    await refresh();
    $("command").scrollIntoView({ block: "nearest" });
  } catch (error) {
    $("form-error").textContent = error.message;
    $("submit").disabled = false;
  }
};
async function refresh() {
  if (fetching) {
    again = true;
    return;
  }
  fetching = true;
  try {
    const res = await fetch("/api/state");
    const result = await res.json();
    if (!res.ok) throw Error(result.error);
    state = result;
    $("error").hidden = true;
    render();
  } catch (error) {
    $("error").textContent =
      "Could not refresh sessions: " +
      error.message +
      ". Check the terminal and choose Refresh to retry.";
    $("error").hidden = false;
  } finally {
    fetching = false;
    if (again) {
      again = false;
      void refresh();
    }
  }
}
for (const id of ["filter", "sort"]) $(id).onchange = render;
$("search").oninput = render;
$("refresh").onclick = refresh;
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !$("confirm").open &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
  ) {
    event.preventDefault();
    $("search").focus();
  }
});
const events = new EventSource("/api/events");
events.addEventListener("change", refresh);
events.onopen = () => {
  $("connection-label").textContent = "Receiving live updates";
  $("connection").title = "Receiving live updates";
  $("connection").className = "connected";
};
events.onerror = () => {
  $("connection-label").textContent = "Disconnected · retrying";
  $("connection").title = "Disconnected · retrying";
  $("connection").className = "";
};
void refresh();
`;
