import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { runtimePaths } from "./runtime.js";

// Directory watches survive atomic JSON replacement. Reattach after events and
// on the fallback tick to recover missing/replaced directories or watcher errors.
export function watchDashboard(onChange: () => void): () => void {
  const paths = runtimePaths();
  let watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const attach = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    for (const path of [paths.root, paths.sessions]) {
      try {
        const watcher = watch(path, { persistent: false }, (_, filename) => {
          const name = filename?.toString();
          if (
            path === paths.root &&
            name &&
            ![basename(paths.config), basename(paths.sessions)].includes(name)
          )
            return;
          schedule();
        });
        watcher.on("error", () => {
          watcher.close();
          schedule();
        });
        watchers.push(watcher);
      } catch {
        // Missing/unavailable runtime directories must not prevent browsing.
        // The fallback retries without creating or modifying runtime state.
      }
    }
  };
  const update = () => {
    if (closed) return;
    attach();
    onChange();
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(debounce);
    debounce = setTimeout(update, 150);
    debounce.unref();
  };
  attach();
  const fallback = setInterval(update, 30_000);
  fallback.unref();
  return () => {
    closed = true;
    clearTimeout(debounce);
    clearInterval(fallback);
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };
}
