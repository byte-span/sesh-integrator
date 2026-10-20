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
    <a id="skip" class="skip" href="#sessions">Skip to sessions</a>
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
        <label class="repository-search"
          ><span class="visually-hidden">Filter repositories</span
          ><svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" /></svg
          ><input
            id="repository-search"
            type="search"
            placeholder="Filter repositories…"
            title="Filter by repository name, or by path when the text contains /. Enter opens the first match; Escape clears."
            aria-controls="repositories"
            autocomplete="off" /></label>
        <nav id="repositories" aria-label="Repositories"></nav>
        <p id="repository-empty" class="repository-empty" role="status" hidden>
          No matching repositories
        </p>
        <div class="sidebar-footer">
          <button
            id="settings-button"
            class="sidebar-link"
            type="button"
            aria-current="false"
            title="Global and repository settings"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
              <circle cx="15" cy="6" r="2" />
              <circle cx="9" cy="12" r="2" />
              <circle cx="17" cy="18" r="2" />
            </svg>
            <span>Settings</span>
          </button>
        </div>
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
                <option value="abandoned">Abandoned</option>
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
          <section id="detail" class="detail" aria-labelledby="detail-heading">
            <h2 id="detail-heading" class="detail-heading">Selected session</h2>
            <div id="detail-body" class="detail-body">
              <div class="empty">
                <h2>Your work, in view</h2>
                <p>
                  Select a session to see its checklist, saved progress, and
                  next action.
                </p>
              </div>
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
      <main
        id="settings"
        class="settings"
        tabindex="-1"
        aria-labelledby="settings-title"
        hidden
      >
        <div class="page-heading">
          <div class="page-title">
            <h1 id="settings-title">Settings</h1>
          </div>
        </div>
        <p id="settings-source" class="settings-source"></p>
        <div class="tabs" role="tablist" aria-label="Settings scope">
          <button
            id="tab-global"
            class="tab"
            role="tab"
            type="button"
            aria-selected="true"
            aria-controls="panel-global"
          >
            Global</button
          ><button
            id="tab-repository"
            class="tab"
            role="tab"
            type="button"
            aria-selected="false"
            aria-controls="panel-repository"
            tabindex="-1"
          >
            Repository</button
          ><button
            id="tab-json"
            class="tab"
            role="tab"
            type="button"
            aria-selected="false"
            aria-controls="panel-json"
            tabindex="-1"
          >
            JSON
          </button>
        </div>
        <div id="settings-error" class="settings-error" role="alert" hidden></div>
        <p id="settings-live" class="visually-hidden" role="status"></p>
        <section
          id="panel-global"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="tab-global"
          tabindex="-1"
        ></section>
        <section
          id="panel-repository"
          class="settings-panel"
          role="tabpanel"
          aria-labelledby="tab-repository"
          tabindex="-1"
          hidden
        ></section>
        <section
          id="panel-json"
          class="settings-panel json-panel"
          role="tabpanel"
          aria-labelledby="tab-json"
          tabindex="-1"
          hidden
        ></section>
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
    <dialog
      id="json-confirm"
      class="wide-dialog"
      aria-labelledby="json-confirm-title"
      aria-describedby="json-confirm-description"
    >
      <form id="json-confirm-form">
        <h2 id="json-confirm-title">Save config.json?</h2>
        <p id="json-confirm-description">
          This replaces the configuration every seshx command on this machine
          reads. New commands use it right away; running commands keep the
          values they loaded. The current file is kept in History, so you can
          restore it.
        </p>
        <p id="json-confirm-warning" class="warning" hidden></p>
        <ul id="json-confirm-changes" class="change-list"></ul>
        <pre id="json-confirm-diff" class="diff" tabindex="0"></pre>
        <div class="form-actions">
          <button id="json-confirm-cancel" type="button">Cancel</button
          ><button id="json-confirm-save" class="primary" type="submit">
            Save config.json
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
/* Fixed app shell: the page and main never scroll, so the page heading and
   footer stay in view. Only the repository nav, session list, detail pane and
   command output scroll. */
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
  background: transparent;
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
.repository-search {
  flex-shrink: 0;
  position: relative;
  display: block;
  margin-bottom: 10px;
}
.repository-search svg {
  position: absolute;
  left: 10px;
  top: 50%;
  width: 15px;
  height: 15px;
  transform: translateY(-50%);
  pointer-events: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--muted);
}
.repository-search input {
  width: 100%;
  min-height: 34px;
  padding: 7px 8px 7px 31px;
  font-size: 13px;
}
.repository-empty {
  margin: 6px 0 0;
  padding-left: 12px;
  color: var(--muted);
  font-size: 13px;
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
/* Settings stays pinned below the scrolling repository list. */
.sidebar-footer {
  flex-shrink: 0;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.sidebar-link {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  border-color: transparent;
  background: transparent;
  text-align: left;
  font-size: 13px;
}
.sidebar-link svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  color: var(--muted);
}
.sidebar-link[aria-current="page"] {
  background: var(--selected);
  color: var(--accent);
}
.sidebar-link[aria-current="page"] svg {
  color: var(--accent);
}
.settings-source {
  margin: -6px 0 18px;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 24px;
}
.tab,
.tab:hover:not(:disabled) {
  margin-bottom: -1px;
  padding: 10px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: var(--radius) var(--radius) 0 0;
  background: transparent;
  color: var(--muted);
}
.tab:hover:not(:disabled) {
  background: var(--hover);
}
.tab[aria-selected="true"],
.tab[aria-selected="true"]:hover:not(:disabled) {
  border-bottom-color: var(--accent);
  color: var(--accent);
}
.settings-error {
  max-width: 760px;
  margin-bottom: 18px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--danger);
  font-size: 13px;
}
.settings-panel {
  max-width: 760px;
}
/* Panels take focus only programmatically, after a save replaces the form. */
.settings-panel:focus,
.settings-panel:focus-visible {
  outline: none;
}
.settings-group {
  margin-bottom: 28px;
  padding: 20px 22px 6px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
.settings-group h2 {
  margin-bottom: 4px;
  font-size: 15px;
}
.settings-group > p {
  margin-bottom: 0;
  font-size: 13px;
  color: var(--muted);
}
.setting {
  display: grid;
  gap: 6px;
  margin: 18px 0;
}
.setting label {
  font-size: 13px;
  font-weight: 600;
}
.setting input:not([type="checkbox"]),
.setting select {
  width: min(100%, 440px);
}
.setting .hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.setting.check {
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 10px;
  align-items: center;
}
.setting.check input {
  width: 18px;
  height: 18px;
  min-height: 0;
  margin: 0;
  accent-color: var(--accent);
}
.setting.check .hint {
  grid-column: 2;
}
.repository-picker {
  margin-top: 0;
}
.settings-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 18px;
  margin: 16px 0 18px;
  font-size: 13px;
}
.settings-facts dt {
  color: var(--muted);
}
.settings-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.settings-facts code,
.settings-group pre {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
}
.settings-group h3 {
  margin: 18px 0 8px;
}
.settings-group pre {
  margin: 0 0 14px;
  padding: 12px;
  border-radius: var(--radius);
  background: var(--code);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.settings-actions {
  position: sticky;
  bottom: -12px;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  max-width: 760px;
  padding: 14px 0 16px;
  border-top: 1px solid var(--line);
  background: var(--bg);
}
.settings-status {
  font-size: 13px;
  color: var(--muted);
}
.settings-status.error {
  color: var(--danger);
}
.settings-status.saved {
  color: var(--success);
}
/* Long command lines scroll inside the editor instead of wrapping. */
.json-panel,
.json-panel .settings-actions {
  max-width: 1100px;
}
.setting textarea.json-editor {
  height: calc(100vh - 400px);
  min-height: 320px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
  overflow: auto;
}
.json-check.error {
  color: var(--danger);
}
.settings-group .group-action {
  margin: 12px 0 18px;
}
.history-list {
  margin: 14px 0 18px;
  padding: 0;
  list-style: none;
}
.history-list li {
  padding: 10px 0;
  border-top: 1px solid var(--line);
}
.history-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.history-row span {
  flex: 1 1 260px;
  font-size: 13px;
}
.history-row time {
  font-weight: 600;
}
.history-list .diff {
  margin-top: 10px;
}
/* Line diffs: + and - prefixes carry the meaning; color only reinforces it. */
pre.diff,
.settings-group pre.diff {
  max-height: 50vh;
  margin: 0;
  padding: 10px 0;
  overflow: auto;
  border-radius: var(--radius);
  background: var(--code);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
  overflow-wrap: normal;
}
.diff span {
  display: block;
  padding: 0 12px;
}
.diff .add {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}
.diff .remove {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.diff .gap {
  color: var(--muted);
  font-style: italic;
}
dialog.wide-dialog {
  width: min(900px, calc(100vw - 32px));
}
dialog .warning {
  color: var(--warning);
  font-weight: 600;
}
.change-list {
  margin: 0 0 14px;
  padding-left: 20px;
  font-size: 13px;
  overflow-wrap: anywhere;
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
  overflow: hidden;
}
/* Settings is one long form, so unlike the session view it scrolls. */
main.settings {
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
  grid-template-columns: minmax(0, 1fr) 12px var(--detail-width, minmax(0, 0.95fr));
  grid-template-rows: minmax(0, 1fr);
  flex: 1 1 0;
  min-height: 0;
}
.session-list,
.detail {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
.session-list {
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
/* The detail heading shares these metrics so both panel headers line up. */
.session-table th,
.detail-heading {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-block: 9px;
  background: var(--surface);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
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
.detail-heading {
  margin: 0;
  padding-inline: 24px;
  border-bottom: 1px solid var(--line);
}
.detail-body {
  padding: 24px;
}
.detail-body h2 {
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
  .detail-body {
    padding: 30px;
  }
  .detail-heading {
    padding-inline: 30px;
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
    grid-template-columns: minmax(0, 1fr) 12px var(--detail-width, minmax(0, 1fr));
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
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .repositories nav {
    flex: 1;
    min-width: 0;
  }
  .repository-search {
    flex-basis: 100%;
    margin-bottom: 0;
  }
  .repository-empty {
    order: 1;
    flex-basis: 100%;
  }
  .sidebar-footer {
    margin: 0;
    padding: 0 0 0 8px;
    border-top: 0;
    border-left: 1px solid var(--line);
  }
  .sidebar-link {
    width: auto;
  }
  .settings-group {
    padding: 16px 16px 4px;
  }
  .settings-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .settings-facts dd {
    margin-bottom: 8px;
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
  .detail-body {
    padding: 20px;
  }
  .detail-heading {
    padding-inline: 20px;
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
// Abandoned sessions are listed only under their own filter.
const abandoned = (r) => r.status === "abandoned";
const labels = {
  active: "In progress",
  ready: "Ready",
  needs_review: "Needs review",
  validation_pending: "Validation pending",
  promotion_pending: "Promotion pending",
  succeeded: "Integrated",
  no_changes: "No changes",
  abandoned: "Abandoned",
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
    r.idle || labels[r.status] || r.status.replaceAll("_", " "),
    "status " +
      (r.attention
        ? "attention"
        : finished(r)
          ? "finished"
          : abandoned(r)
            ? "abandoned"
            : "active"),
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
  const available = split.clientWidth - detailResizer.offsetWidth;
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
        (filter === "abandoned"
          ? abandoned(r)
          : !abandoned(r) &&
            (filter === "all" ||
              (filter === "active" && r.status !== "empty" && !finished(r)) ||
              (filter === "finished" && finished(r)) ||
              (filter === "attention" && r.attention))) &&
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
const repositoryName = (path) => path.split(/[\\/]/).pop();
const repositoryPaths = () =>
  [...new Set(state.rows.map((r) => r.repository))].sort();
const repositoryQuery = () =>
  $("repository-search").value.trim().toLocaleLowerCase();
// Names are matched by default because every path shares its parent folders;
// typing a separator searches full paths instead.
function repositoryMatches(path, query) {
  return (/[\\/]/.test(query) ? path : repositoryName(path))
    .toLocaleLowerCase()
    .includes(query);
}
function renderRepositories() {
  const nav = $("repositories"),
    focused = document.activeElement?.dataset.repo,
    query = repositoryQuery();
  nav.replaceChildren();
  const all = repositoryPaths(),
    matches = all.filter((path) => repositoryMatches(path, query)),
    // Keep the chosen repository visible so the active filter is never hidden.
    paths = all.filter((path) => path === repository || matches.includes(path));
  $("repository-empty").hidden = !query || matches.length > 0;
  for (const path of ["", ...paths]) {
    const count = state.rows.filter(
      (r) =>
        (!path || r.repository === path) &&
        r.status !== "empty" &&
        !finished(r) &&
        !abandoned(r),
    ).length;
    const b = button("", () => {
      if (settingsOpen && !closeSettings()) return;
      repository = path;
      render();
    });
    b.className = "repo";
    b.dataset.repo = path;
    b.title = path || "All repositories";
    b.setAttribute(
      "aria-current",
      String(!settingsOpen && repository === path),
    );
    b.append(
      el("span", path ? repositoryName(path) : "All repositories"),
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
  const pane = $("detail"),
    body = $("detail-body");
  const key = JSON.stringify([r, !!state.job?.running]);
  if (detailKey === key) return;
  const oldId = pane.dataset.session,
    scroll = pane.scrollTop,
    focus = document.activeElement?.dataset.control,
    expanded = pane.querySelector("details")?.open;
  detailKey = key;
  pane.dataset.session = r?.id || "";
  body.replaceChildren();
  body.append(
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
    body.append(empty);
    return;
  }
  body.append(
    status(r),
    el("h2", r.title),
    el("p", r.repositoryName + (r.branch ? " / " + r.branch : ""), "meta"),
  );
  const next = el("div", undefined, "next");
  next.append(el("h3", "Next action"), el("p", r.next));
  body.append(next);
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
  body.append(actions, el("p", reasons.join(" · "), "action-reasons"));
  if (r.pullRequestUrl) {
    const p = el("p");
    const link = el("a", "Open pull request");
    link.href = r.pullRequestUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    p.append(link);
    body.append(p);
  }
  if (r.followUps.length) {
    body.append(el("h3", "Outstanding follow-ups"));
    const ul = el("ul", undefined, "follow-ups");
    r.followUps.forEach((f) => ul.append(el("li", f)));
    body.append(ul);
  }
  const heading = el("div", undefined, "section-heading");
  heading.append(el("h3", "Checklist · " + r.progress));
  body.append(heading);
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
  body.append(tasks);
  if (!r.tasks.length)
    body.append(el("p", "No checklist recorded yet.", "meta"));
  body.append(el("h3", "Saved milestones"));
  if (!r.activity.length)
    body.append(
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
    body.append(ul);
  }
  const details = el("details");
  details.open = oldId === r.id && expanded;
  details.append(
    el("summary", "Session record & recovery details"),
    el("pre", r.details.join("\n"), "record"),
  );
  body.append(details);
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
// Settings view: Global and Repository tabs edit the central config.json.
let settingsOpen = false,
  settingsTab = "global",
  settingsRepository = "",
  settingsData = null,
  settingsJson = null,
  settingsHistory = null,
  settingsFetching = false,
  settingsAgain = false;
const settingsTabs = ["global", "repository", "json"];
const settingsForms = { global: null, repository: null, json: null };
try {
  const saved = localStorage.getItem("sesh-settings-tab");
  if (settingsTabs.includes(saved)) settingsTab = saved;
} catch {}
const listText = (values) => (values || []).join(", ");
const parseList = (value) =>
  value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
const targetSources = {
  override: "repository setting",
  "global default": "global default",
  defaultBranch: "default branch",
};
function unsavedSettings() {
  return Object.values(settingsForms).some((f) => f?.dataset.dirty === "true");
}
function showSettingsView(open) {
  settingsOpen = open;
  $("sessions").hidden = open;
  $("settings").hidden = !open;
  $("settings-button").setAttribute("aria-current", open ? "page" : "false");
  $("skip").href = open ? "#settings" : "#sessions";
  $("skip").textContent = open ? "Skip to settings" : "Skip to sessions";
  renderRepositories();
}
function openSettings() {
  if (repository) settingsRepository = repository;
  showSettingsView(true);
  renderSettings();
  void loadSettings();
  $("tab-" + settingsTab).focus();
}
function closeSettings() {
  if (unsavedSettings() && !confirm("Discard unsaved settings changes?"))
    return false;
  settingsForms.global = settingsForms.repository = settingsForms.json = null;
  showSettingsView(false);
  render();
  return true;
}
$("settings-button").onclick = () => {
  if (!settingsOpen) openSettings();
  else if (closeSettings()) $("sessions").focus();
};
function selectSettingsTab(tab, focus) {
  settingsTab = tab;
  try {
    localStorage.setItem("sesh-settings-tab", tab);
  } catch {}
  for (const name of settingsTabs) {
    const selected = name === tab;
    $("tab-" + name).setAttribute("aria-selected", String(selected));
    $("tab-" + name).tabIndex = selected ? 0 : -1;
    $("panel-" + name).hidden = !selected;
  }
  if (focus) $("tab-" + tab).focus();
}
for (const name of settingsTabs)
  $("tab-" + name).onclick = () => selectSettingsTab(name);
document
  .querySelector('#settings [role="tablist"]')
  .addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const n = settingsTabs.length,
      i = settingsTabs.indexOf(settingsTab);
    selectSettingsTab(
      settingsTabs[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? n - 1
            : (i + (event.key === "ArrowRight" ? 1 : n - 1)) % n
      ],
      true,
    );
  });
async function getJson(url) {
  const res = await fetch(url);
  const result = await res.json();
  if (!res.ok) throw Error(result.error);
  return result;
}
async function loadSettings() {
  if (settingsFetching) {
    settingsAgain = true;
    return;
  }
  settingsFetching = true;
  try {
    // The JSON tab reads the raw file, so it still opens to repair an
    // invalid config.json that the other tabs cannot load.
    const [view, raw, history] = await Promise.allSettled([
      getJson("/api/settings"),
      getJson("/api/settings/json"),
      getJson("/api/settings/history"),
    ]);
    if (view.status === "fulfilled") settingsData = view.value;
    if (raw.status === "fulfilled") settingsJson = raw.value;
    // History is optional: the editor still works without it.
    settingsHistory = history.status === "fulfilled" ? history.value : null;
    const failed = [view, raw].find((r) => r.status === "rejected");
    $("settings-error").textContent = failed
      ? "Could not load settings: " +
        failed.reason.message +
        (raw.status === "fulfilled"
          ? ". Fix config.json in the JSON tab; this page reloads it when it changes."
          : ". Fix config.json if it is invalid; this page reloads it when it changes.")
      : "";
    $("settings-error").hidden = !failed;
    renderSettings();
  } finally {
    settingsFetching = false;
    if (settingsAgain) {
      settingsAgain = false;
      void loadSettings();
    }
  }
}
function renderSettings() {
  selectSettingsTab(settingsTab);
  const data = settingsData,
    source = data || settingsJson;
  $("settings-source").textContent = source
    ? "Saved in " +
      source.configPath +
      (source.exists ? "" : " · created when you first save")
    : "Loading settings…";
  if (settingsJson) {
    renderSettingsForm("json", settingsJson.revision, () =>
      jsonSettingsForm(settingsJson),
    );
    renderSettingsHistory();
  }
  if (!data) return;
  if (!data.repositories.some((r) => r.path === settingsRepository))
    settingsRepository = data.repositories[0]?.path || "";
  renderSettingsForm("global", data.revision, () => globalSettingsForm(data));
  renderSettingsForm("repository", data.revision + "\n" + settingsRepository, () =>
    repositorySettingsForm(
      data,
      data.repositories.find((r) => r.path === settingsRepository),
    ),
  );
}
function renderSettingsForm(scope, key, build) {
  const panel = $("panel-" + scope),
    current = settingsForms[scope];
  if (current?.dataset.key === key) return;
  if (current?.dataset.dirty === "true") {
    // Keep unsaved edits; the server refuses stale saves.
    setSettingsStatus(
      current,
      "Settings changed elsewhere. Choose Discard changes to load them before saving.",
      "error",
    );
    return;
  }
  const focus = document.activeElement?.id,
    scroll = $("settings").scrollTop;
  const form = build();
  form.dataset.key = key;
  form.dataset.dirty = "false";
  panel.replaceChildren(form);
  settingsForms[scope] = form;
  const node = focus && document.getElementById(focus);
  if (node && panel.contains(node)) node.focus({ preventScroll: true });
  $("settings").scrollTop = scroll;
}
function settingsGroup(parent, title, description) {
  const group = el("section", undefined, "settings-group");
  group.append(el("h2", title));
  if (description) group.append(el("p", description));
  parent.append(group);
  return group;
}
function settingField(parent, o) {
  const id = "setting-" + o.name,
    check = o.type === "checkbox",
    wrap = el("div", undefined, "setting" + (check ? " check" : ""));
  let input;
  if (o.options) {
    input = el("select");
    for (const [value, label] of o.options) {
      const option = el("option", label);
      option.value = value;
      input.append(option);
    }
  } else if (o.type === "textarea") input = el("textarea");
  else {
    input = el("input");
    input.type = o.type || "text";
    input.autocomplete = "off";
    input.spellcheck = false;
  }
  input.id = id;
  input.name = o.name;
  if (check) input.checked = !!o.value;
  else input.value = o.value ?? "";
  for (const key of ["placeholder", "min", "max", "step"])
    if (o[key] !== undefined) input.setAttribute(key, o[key]);
  if (o.required) input.required = true;
  if (o.track === false) input.dataset.track = "false";
  const label = el("label", o.label);
  label.htmlFor = id;
  wrap.append(...(check ? [input, label] : [label, input]));
  if (o.hint) {
    const hint = el("p", o.hint, "hint");
    hint.id = id + "-hint";
    input.setAttribute("aria-describedby", hint.id);
    wrap.append(hint);
  }
  parent.append(wrap);
  return input;
}
function settingsFacts(parent, entries) {
  const dl = el("dl", undefined, "settings-facts");
  for (const [term, value] of entries) {
    const dd = el("dd");
    dd.append(el("code", value));
    dl.append(el("dt", term), dd);
  }
  parent.append(dl);
}
function setSettingsStatus(form, text, kind) {
  const node = form?.querySelector(".settings-status");
  if (!node) return;
  node.textContent = text;
  node.className = "settings-status" + (kind ? " " + kind : "");
  $("settings-live").textContent = text;
}
function settingsActions(form, scope, extra = []) {
  const bar = el("div", undefined, "settings-actions"),
    save = el("button", "Save changes", "primary"),
    discard = button("Discard changes", () => {
      settingsForms[scope] = null;
      renderSettings();
      void loadSettings();
      $("tab-" + scope).focus();
    });
  save.type = "submit";
  save.disabled = discard.disabled = true;
  bar.append(save, ...extra, discard, el("span", "", "settings-status"));
  form.append(bar);
  const changed = (event) => {
    if (event.target.dataset?.track === "false") return;
    if (form.dataset.dirty !== "true")
      setSettingsStatus(form, "Unsaved changes");
    form.dataset.dirty = "true";
    save.disabled = discard.disabled = false;
  };
  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  return changed;
}
async function submitSettings(form, request) {
  const buttons = form.querySelectorAll(".settings-actions button");
  buttons.forEach((b) => (b.disabled = true));
  setSettingsStatus(form, "Saving…");
  const { scope, ...fields } = request,
    raw = scope === "json";
  try {
    const res = await fetch(raw ? "/api/settings/json" : "/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sesh-Dashboard": "1" },
      body: JSON.stringify({
        ...(raw ? fields : request),
        revision: form.dataset.revision,
      }),
    });
    const result = await res.json();
    if (!res.ok) throw Error(result.error);
    if (raw) settingsJson = result;
    else settingsData = result;
    settingsForms[request.scope] = null;
    renderSettings();
    setSettingsStatus(settingsForms[request.scope], "Saved", "saved");
    $("panel-" + request.scope).focus({ preventScroll: true });
    void refresh();
  } catch (error) {
    setSettingsStatus(form, error.message, "error");
    buttons.forEach((b) => (b.disabled = false));
  }
}
function globalSettingsForm(data) {
  const g = data.global,
    form = el("form");
  form.dataset.revision = data.revision;
  let group = settingsGroup(
    form,
    "Branches and pull requests",
    "Defaults for every registered repository. A repository's own setting takes precedence.",
  );
  const target = settingField(group, {
    name: "global-target",
    label: "Default target branch",
    value: g.defaultTargetBranch,
    placeholder: "Each repository's default branch",
    hint: "Validated work is promoted here, for example dev. Leave empty to promote to each repository's default branch.",
  });
  const reviewers = settingField(group, {
    name: "global-reviewers",
    label: "Default reviewers",
    value: listText(g.reviewers),
    placeholder: "None",
    hint: "GitHub users or teams, separated by commas. Pull-request promotion uses them when a repository lists none.",
  });
  const assignees = settingField(group, {
    name: "global-assignees",
    label: "Default assignees",
    value: listText(g.assignees),
    placeholder: "None",
    hint: "GitHub users, separated by commas.",
  });
  group = settingsGroup(form, "Integration");
  const wait = settingField(group, {
    name: "global-lock-wait",
    label: "Lock wait (seconds)",
    type: "number",
    value: String(g.lockWaitSeconds),
    min: "0",
    max: "86400",
    step: "1",
    required: true,
    hint: "How long seshx integrate waits for another session to release the repository before stopping.",
  });
  const modes = [
    ["current-session", "Current session — the agent running integrate resolves conflicts"],
    ["nested-agent", "Nested agent — start a separate agent to resolve conflicts"],
  ];
  if (g.conflictResolutionMode === "nested-codex")
    modes.push(["nested-codex", "Nested Codex (legacy)"]);
  const conflicts = settingField(group, {
    name: "global-conflicts",
    label: "Conflict resolution",
    options: modes,
    value: g.conflictResolutionMode,
  });
  const policy = settingField(group, {
    name: "global-policy",
    label: "Delivery policy file",
    value: g.deliveryPolicyFile,
    placeholder: "None",
    hint: "Used by seshx begin when --policy-file is not given. Relative paths start from the configuration folder.",
  });
  group = settingsGroup(
    form,
    "Agent commands",
    "The program seshx starts for each harness, for nested conflict resolution and failure diagnosis. Use a name on PATH or a full path; arguments are not allowed.",
  );
  const commands = data.harnesses.map((h) => [
    h.id,
    settingField(group, {
      name: "global-harness-" + h.id,
      label: h.name,
      value: g.harnessCommands[h.id],
      placeholder: "Default: " + h.defaultCommand,
      hint: "Leave empty to use " + h.defaultCommand + ".",
    }),
  ]);
  settingsActions(form, "global");
  form.onsubmit = (event) => {
    event.preventDefault();
    void submitSettings(form, {
      scope: "global",
      values: {
        defaultTargetBranch: target.value.trim(),
        lockWaitSeconds: Number(wait.value),
        conflictResolutionMode: conflicts.value,
        reviewers: parseList(reviewers.value),
        assignees: parseList(assignees.value),
        deliveryPolicyFile: policy.value.trim(),
        harnessCommands: Object.fromEntries(
          commands.map(([id, input]) => [id, input.value.trim()]),
        ),
      },
    });
  };
  return form;
}
function repositorySettingsForm(data, r) {
  const form = el("form");
  form.dataset.revision = data.revision;
  if (!r) {
    const empty = el("div", undefined, "empty");
    empty.append(
      el("h2", "No registered repositories"),
      el(
        "p",
        "Run seshx register --auto-config in a repository, then return here.",
      ),
    );
    form.append(empty);
    return form;
  }
  const picker = settingField(form, {
    name: "repo-picker",
    label: "Repository",
    options: data.repositories.map((x) => [x.path, x.name]),
    value: r.path,
    hint: r.path,
    track: false,
  });
  picker.parentElement.classList.add("repository-picker");
  picker.onchange = () => {
    if (
      form.dataset.dirty === "true" &&
      !confirm("Discard unsaved changes to " + r.name + "?")
    ) {
      picker.value = r.path;
      return;
    }
    settingsRepository = picker.value;
    settingsForms.repository = null;
    renderSettings();
  };
  let group = settingsGroup(form, "Registration");
  settingsFacts(group, [
    ["Path", r.path],
    ["Git directory", r.gitCommonDir],
    ["Default branch", r.defaultBranch],
    ["Staging branch", r.integrationBranch],
    [
      "Promotes to",
      r.effectiveTargetBranch + " (" + targetSources[r.targetSource] + ")",
    ],
  ]);
  const enabled = settingField(group, {
    name: "repo-enabled",
    type: "checkbox",
    label: "Use sesh-integrator in this repository",
    value: r.enabled,
    hint: "When off, begin and integrate refuse to run here. Configuration, sessions and Git state are kept.",
  });
  const signing = settingField(group, {
    name: "repo-gpg",
    label: "Signing program",
    value: r.gpgProgram,
    placeholder: "Git's gpg.program setting",
    hint: "Program Git uses to sign this repository's commits and merges, for example /usr/bin/gpg. Leave empty to use Git's own setting.",
  });
  group = settingsGroup(form, "Target and promotion");
  const target = settingField(group, {
    name: "repo-target",
    label: "Target branch",
    value: r.targetBranch,
    placeholder: "Inherit: " + r.inheritedTargetBranch,
    hint: "Leave empty to inherit the global default target branch.",
  });
  const p = r.promotion;
  const type = settingField(group, {
    name: "repo-promotion",
    label: "Promotion",
    options: [
      ["none", "Local only — update the target branch on this machine"],
      ["pull-request", "Pull request — push and open a pull request"],
    ],
    value: p.type,
  });
  const pullRequest = el("div");
  group.append(pullRequest);
  const mode = settingField(pullRequest, {
    name: "repo-mode",
    label: "Pull request mode",
    options: [
      ["shared-target", "Shared target — push the target branch and open one pull request"],
      ["session-branch", "Session branch — open a pull request for each session"],
    ],
    value: p.mode,
  });
  const production = settingField(pullRequest, {
    name: "repo-production",
    label: "Production branch",
    value: p.productionBranch,
    placeholder: r.defaultBranch,
    hint: "Pull requests merge into this branch. Leave empty to use " + r.defaultBranch + ".",
  });
  const remote = settingField(pullRequest, {
    name: "repo-remote",
    label: "Remote",
    value: p.remote,
    placeholder: "origin",
    hint: "Leave empty to use origin.",
  });
  const inherited = (own, global) =>
    own && !own.length
      ? "None"
      : global.length
        ? "Inherit: " + listText(global)
        : "None";
  const reviewers = settingField(pullRequest, {
    name: "repo-reviewers",
    label: "Reviewers",
    value: listText(p.reviewers),
    placeholder: inherited(p.reviewers, data.global.reviewers),
    hint: "Separate with commas. Leave empty to use the global default reviewers.",
  });
  const assignees = settingField(pullRequest, {
    name: "repo-assignees",
    label: "Assignees",
    value: listText(p.assignees),
    placeholder: inherited(p.assignees, data.global.assignees),
    hint: "Separate with commas. Leave empty to use the global default assignees.",
  });
  const syncPromotion = () => {
    pullRequest.hidden = type.value !== "pull-request";
  };
  type.addEventListener("change", syncPromotion);
  syncPromotion();
  group = settingsGroup(form, "Validation");
  const cache = settingField(group, {
    name: "repo-cache",
    label: "Reuse passing checks",
    options: [
      ["session", "Session — for the same tree within one session"],
      ["repository", "Repository — for the same tree across sessions"],
      ["off", "Off — always run every check"],
    ],
    value: r.validationCache,
  });
  const setup = settingField(group, {
    name: "repo-setup",
    label: "Setup failures",
    options: [
      ["required", "Required — stop when setup fails"],
      ["advisory", "Advisory — warn and continue"],
    ],
    value: r.setupCommandPolicy,
    hint: "Applies to this repository's setup commands.",
  });
  group = settingsGroup(
    form,
    "Conflict instructions",
    "Given to the agent that resolves merge conflicts, alongside the repository's AGENTS.md.",
  );
  const instructions = settingField(group, {
    name: "repo-instructions",
    label: "Instructions",
    type: "textarea",
    value: r.conflictInstructions,
    placeholder: "Preserve compatible intent from both changes.",
  });
  group = settingsGroup(
    form,
    "Commands",
    "Edit setup, validation and post-integration commands, and validation tiers, in this repository's JSON entry.",
  );
  const edit = button("Edit in JSON", () => editRepositoryJson(r.path));
  edit.classList.add("group-action");
  group.append(edit);
  for (const c of r.commands) {
    group.append(el("h3", c.label));
    group.append(
      c.lines.length ? el("pre", c.lines.join("\n")) : el("p", "None configured."),
    );
  }
  for (const tier of r.validationTiers) {
    group.append(el("h3", "Validation tier · " + tier.name));
    group.append(
      el(
        "pre",
        [
          "Paths: " + tier.paths.join(", "),
          "Source validation:",
          ...(tier.source.length ? tier.source : ["(none)"]).map((l) => "  " + l),
          "Integration validation:",
          ...(tier.integration.length ? tier.integration : ["(none)"]).map(
            (l) => "  " + l,
          ),
          ...(tier.bypassIntegrationWorktree
            ? ["Skips the integration worktree"]
            : []),
        ].join("\n"),
      ),
    );
  }
  settingsActions(form, "repository");
  const list = (input, original) => {
    const names = parseList(input.value);
    return names.length
      ? names
      : Array.isArray(original) && !original.length
        ? []
        : null;
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void submitSettings(form, {
      scope: "repository",
      repository: r.path,
      values: {
        enabled: enabled.checked,
        targetBranch: target.value.trim(),
        promotion: {
          type: type.value,
          mode: mode.value,
          productionBranch: production.value.trim(),
          remote: remote.value.trim(),
          reviewers: list(reviewers, p.reviewers),
          assignees: list(assignees, p.assignees),
        },
        validationCache: cache.value,
        setupCommandPolicy: setup.value,
        conflictInstructions: instructions.value,
        gpgProgram: signing.value.trim(),
      },
    });
  };
  return form;
}
/** Open the JSON tab with this repository's entry selected. */
function editRepositoryJson(path) {
  selectSettingsTab("json");
  const editor = settingsForms.json?.querySelector("#setting-json-text");
  if (!editor) return;
  const text = editor.value,
    quoted = JSON.stringify(path),
    match = new RegExp('"path"\\s*:\\s*' + quoted.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")).exec(text),
    start = match ? match.index : text.indexOf(quoted);
  editor.focus({ preventScroll: true });
  if (start < 0) return;
  const end = start + (match ? match[0].length : quoted.length),
    line = text.slice(0, start).split("\n").length - 1,
    height = parseFloat(getComputedStyle(editor).lineHeight) || 19;
  editor.setSelectionRange(start, end);
  editor.scrollTop = Math.max(0, (line - 2) * height);
}
function jsonSettingsForm(raw) {
  const form = el("form");
  form.dataset.revision = raw.revision;
  const group = settingsGroup(
    form,
    "config.json",
    "Edit the whole configuration, including commands and validation tiers. Saving runs the checks the CLI applies when it loads the file.",
  );
  const editor = settingField(group, {
    name: "json-text",
    label: "Configuration",
    type: "textarea",
    value: raw.text,
    hint: "Repositories are added with seshx register; keep each path and gitCommonDir unchanged. Saving rewrites the file with two-space indentation.",
  });
  editor.classList.add("json-editor");
  editor.setAttribute("wrap", "off");
  editor.setAttribute("autocapitalize", "off");
  editor.spellcheck = false;
  const check = el("p", "", "hint json-check");
  check.id = "json-check";
  editor.setAttribute("aria-describedby", "setting-json-text-hint json-check");
  // Above the editor, so parse errors stay visible without scrolling.
  editor.before(check);
  const parse = () => {
    try {
      JSON.parse(editor.value);
      check.textContent = "Valid JSON";
      check.className = "hint json-check";
      editor.removeAttribute("aria-invalid");
      return true;
    } catch (error) {
      check.textContent = "Invalid JSON: " + error.message;
      check.className = "hint json-check error";
      editor.setAttribute("aria-invalid", "true");
      return false;
    }
  };
  editor.addEventListener("input", parse);
  parse();
  const format = button("Format", () => {
    if (!parse()) return editor.focus();
    const text = JSON.stringify(JSON.parse(editor.value), null, 2) + "\n";
    if (text === editor.value) return;
    editor.value = text;
    changed({ target: editor });
  });
  const changed = settingsActions(form, "json", [format]);
  editor.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      if (form.dataset.dirty === "true") form.requestSubmit();
    }
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!parse()) {
      setSettingsStatus(form, "Fix the JSON error before saving.", "error");
      editor.focus();
      return;
    }
    const text = editor.value;
    if (!(await confirmJsonSave(raw.text, text))) return editor.focus();
    void submitSettings(form, { scope: "json", text });
  };
  // History renders into its own slot so a new entry never resets the editor.
  form.historySlot = el("div");
  form.append(form.historySlot);
  form.restoreSnapshot = (snapshot) => {
    if (
      form.dataset.dirty === "true" &&
      !confirm("Replace your unsaved edits with this earlier version?")
    )
      return;
    editor.value = snapshot.text;
    parse();
    changed({ target: editor });
    setSettingsStatus(
      form,
      "Loaded the version replaced " +
        time(snapshot.replacedAt) +
        ". Review it, then choose Save changes.",
    );
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
    editor.scrollIntoView({ block: "nearest" });
  };
  return form;
}
function renderSettingsHistory() {
  const form = settingsForms.json,
    history = settingsHistory;
  if (!form?.historySlot) return;
  const key =
    settingsJson.revision +
    "\n" +
    (history ? history.entries.map((e) => e.id).join(",") : "unavailable");
  if (form.historySlot.dataset.key === key) return;
  form.historySlot.dataset.key = key;
  form.historySlot.replaceChildren();
  const group = settingsGroup(
    form.historySlot,
    "History",
    history
      ? "Earlier versions of config.json, kept each time the CLI or this dashboard changes it. The newest " +
          history.limit +
          " are kept. Restore loads a version into the editor; nothing changes until you save."
      : "History is unavailable. Reload settings to try again.",
  );
  if (!history) return;
  if (!history.entries.length) {
    group.append(el("p", "No earlier versions yet.", "hint group-action"));
    return;
  }
  const list = el("ul", undefined, "history-list");
  for (const entry of history.entries) {
    const li = el("li"),
      row = el("div", undefined, "history-row"),
      label = el("span"),
      at = el("time", time(entry.replacedAt));
    at.dateTime = entry.replacedAt;
    label.append(at, " · replaced by " + entry.source);
    let diff = null;
    const compare = button("Compare with current", async () => {
      if (diff) {
        diff.remove();
        diff = null;
        compare.textContent = "Compare with current";
        compare.setAttribute("aria-expanded", "false");
        return;
      }
      try {
        const snapshot = await getJson("/api/settings/history/" + entry.id);
        diff = diffView(snapshot.text, settingsJson.text);
        li.append(diff);
        compare.textContent = "Hide comparison";
        compare.setAttribute("aria-expanded", "true");
      } catch (error) {
        setSettingsStatus(form, error.message, "error");
      }
    });
    compare.setAttribute("aria-expanded", "false");
    const load = button("Restore", async () => {
      try {
        form.restoreSnapshot(
          await getJson("/api/settings/history/" + entry.id),
        );
      } catch (error) {
        setSettingsStatus(form, error.message, "error");
      }
    });
    row.append(label, compare, load);
    li.append(row);
    list.append(li);
  }
  group.append(list);
}
/** Line-level edit script from LCS; null when too large to compare here. */
function diffLines(before, after) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start,
    m = endB - start;
  if (n * m > 4000000) return null;
  // lcs[i][j]: common lines in a[start+i..endA) and b[start+j..endB).
  const lcs = new Uint32Array((n + 1) * (m + 1)),
    at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[at(i, j)] =
        a[start + i] === b[start + j]
          ? lcs[at(i + 1, j + 1)] + 1
          : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
  const out = a.slice(0, start).map((text) => [" ", text]);
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      out.push([" ", a[start + i]]);
      i++;
      j++;
    } else if (i < n && (j === m || lcs[at(i + 1, j)] >= lcs[at(i, j + 1)])) {
      out.push(["-", a[start + i]]);
      i++;
    } else {
      out.push(["+", b[start + j]]);
      j++;
    }
  }
  return out.concat(a.slice(endA).map((text) => [" ", text]));
}
/** A diff of before→after with three lines of context around each change. */
function diffView(before, after) {
  const pre = el("pre", undefined, "diff");
  pre.tabIndex = 0;
  const lines = diffLines(before, after);
  if (!lines) {
    pre.append(el("span", "Too large to compare here.", "gap"));
    return pre;
  }
  if (!lines.some(([kind]) => kind !== " ")) {
    pre.append(el("span", "No differences.", "gap"));
    return pre;
  }
  const near = lines.map(() => false);
  lines.forEach(([kind], index) => {
    if (kind === " ") return;
    for (let k = Math.max(0, index - 3); k <= Math.min(lines.length - 1, index + 3); k++)
      near[k] = true;
  });
  let hidden = 0;
  const flush = () => {
    if (hidden)
      pre.append(
        el("span", "… " + hidden + " unchanged line" + (hidden === 1 ? "" : "s"), "gap"),
      );
    hidden = 0;
  };
  lines.forEach(([kind, text], index) => {
    if (!near[index]) return void hidden++;
    flush();
    pre.append(
      el(
        "span",
        kind + " " + text,
        kind === "+" ? "add" : kind === "-" ? "remove" : undefined,
      ),
    );
  });
  flush();
  return pre;
}
const sorted = (value) =>
  JSON.stringify(value, (key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
// Fields whose values seshx runs as programs.
const programKeys = new Set([
  "codexCommand",
  "harnessCommands",
  "gpgProgram",
  "setupCommands",
  "sourceValidationCommands",
  "integrationValidationCommands",
  "postIntegrationCommands",
  "validationTiers",
]);
/** Changed settings by name, or null when the saved file is not valid JSON. */
function configChanges(before, after) {
  let a, b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return null;
  }
  const changed = (x, y) =>
    Object.keys({ ...x, ...y }).filter((k) => sorted(x?.[k]) !== sorted(y?.[k]));
  const changes = [],
    programs = [];
  for (const key of changed(a, b)) {
    if (key === "repositories") continue;
    changes.push(key);
    if (programKeys.has(key)) programs.push(key);
  }
  const repos = (c) =>
    Object.fromEntries(
      (Array.isArray(c?.repositories) ? c.repositories : []).map((r) => [r?.path, r]),
    );
  const ra = repos(a),
    rb = repos(b);
  for (const path of Object.keys({ ...ra, ...rb })) {
    const keys = changed(ra[path], rb[path]);
    if (!keys.length) continue;
    const name = String(path).split("/").filter(Boolean).pop() || String(path);
    changes.push(name + ": " + keys.join(", "));
    for (const key of keys)
      if (programKeys.has(key)) programs.push(name + " " + key);
  }
  return { changes, programs };
}
let jsonConfirmDone = null;
function confirmJsonSave(before, after) {
  const summary = configChanges(before, after),
    list = $("json-confirm-changes"),
    warning = $("json-confirm-warning");
  list.replaceChildren(
    ...(summary
      ? summary.changes.length
        ? summary.changes.map((c) => el("li", c))
        : [el("li", "Formatting only; no settings change.")]
      : [el("li", "Replaces a file that is not valid JSON.")]),
  );
  warning.hidden = !summary?.programs.length;
  warning.textContent = summary?.programs.length
    ? "Changes programs that seshx runs: " + summary.programs.join(", ") + "."
    : "";
  $("json-confirm-diff").replaceWith(
    Object.assign(diffView(before, after), { id: "json-confirm-diff" }),
  );
  $("json-confirm").showModal();
  // Start on the diff, not Save, so a second Enter cannot save unseen changes.
  $("json-confirm-diff").focus();
  return new Promise((resolve) => (jsonConfirmDone = resolve));
}
$("json-confirm-form").onsubmit = (event) => {
  event.preventDefault();
  const done = jsonConfirmDone;
  jsonConfirmDone = null;
  $("json-confirm").close();
  done?.(true);
};
$("json-confirm-cancel").onclick = () => $("json-confirm").close();
$("json-confirm").addEventListener("close", () => {
  jsonConfirmDone?.(false);
  jsonConfirmDone = null;
});
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
    if (settingsOpen) void loadSettings();
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
$("repository-search").oninput = renderRepositories;
$("repository-search").addEventListener("keydown", (event) => {
  const input = event.currentTarget;
  if (event.key === "Escape" && input.value) {
    event.preventDefault();
    input.value = "";
    renderRepositories();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const query = repositoryQuery(),
      match =
        query && repositoryPaths().find((p) => repositoryMatches(p, query));
    if (match) {
      if (settingsOpen && !closeSettings()) return;
      repository = match;
      render();
    }
  }
});
$("refresh").onclick = refresh;
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !settingsOpen &&
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
