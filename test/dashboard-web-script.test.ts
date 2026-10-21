import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { webHtml, webScript } from "../src/dashboard-web-assets.js";

// A minimal recording DOM: enough for the dashboard script to boot and render
// without a browser. Unknown members resolve to no-op functions.
type Listener = (event: Record<string, unknown>) => void;
class FakeElement {
  static focused: FakeElement | undefined;
  id = "";
  open = false;
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  style = { setProperty() {} };
  hidden = false;
  clientWidth = 1000;
  value = "";
  textContent = "";
  constructor(readonly tagName = "DIV") {}
  append(...nodes: unknown[]) {
    for (const node of nodes)
      if (node instanceof FakeElement) this.children.push(node);
  }
  replaceChildren(...nodes: unknown[]) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    const full = { preventDefault() {}, currentTarget: this, ...event };
    const handler = (this as Record<string, unknown>)["on" + type];
    if (typeof handler === "function") handler(full);
    for (const listener of this.listeners.get(type) ?? []) listener(full);
  }
  focus() {
    FakeElement.focused = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  get text(): string {
    return this.textContent + this.children.map((c) => c.text).join("");
  }
  /** Depth-first search of this element's descendants. */
  find(test: (node: FakeElement) => boolean): FakeElement[] {
    return this.children.flatMap((c) => [
      ...(test(c) ? [c] : []),
      ...c.find(test),
    ]);
  }
}
const lenient = <T extends object>(target: T): T =>
  new Proxy(target, {
    get: (t, key) =>
      key in t || typeof key === "symbol"
        ? Reflect.get(t, key)
        : () => undefined,
  });

type Api = (
  url: string,
  init?: { method?: string; body?: string },
) => [number, unknown] | undefined;

async function boot(
  rows: Record<string, unknown>[],
  options: { api?: Api; storage?: Map<string, string> } = {},
) {
  const ids = new Map<string, FakeElement>();
  const byId = (id: string) => {
    if (!ids.has(id))
      ids.set(id, lenient(Object.assign(new FakeElement(), { id })));
    return ids.get(id)!;
  };
  byId("filter").value = "active";
  byId("sort").value = "updated";
  const documentElement = lenient(new FakeElement("HTML"));
  const document = lenient(
    Object.assign(new FakeElement("DOCUMENT"), {
      documentElement,
      activeElement: undefined as FakeElement | undefined,
      hidden: false,
      getElementById: byId,
      querySelector: (selector: string) => byId("query " + selector),
      createElement: (tag: string) =>
        lenient(new FakeElement(tag.toUpperCase())),
    }),
  );
  const state = { rows, job: null, refreshedAt: Date.now() };
  const context: Record<string, unknown> = {
    document,
    window: { innerWidth: 1400, addEventListener() {} },
    localStorage: {
      getItem: (key: string) => options.storage?.get(key) ?? null,
      setItem: (key: string, value: string) => options.storage?.set(key, value),
      removeItem() {},
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class {
      observe() {}
    },
    EventSource: class {
      addEventListener() {}
    },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const [status, body] = options.api?.(url, init) ?? [200, state];
      return { ok: status < 400, json: async () => body };
    },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  };
  runInNewContext(webScript, context);
  await new Promise((resolve) => setImmediate(resolve));
  const shown = () =>
    byId("repositories").children.map((b) => b.dataset.repo ?? "");
  const type = (value: string) => {
    byId("repository-search").value = value;
    byId("repository-search").dispatch("input");
  };
  return { byId, shown, type, context };
}

const session = (id: string, repository: string) => ({
  id,
  title: "Task " + id,
  repository,
  repositoryName: repository.split("/").pop(),
  branch: "task/" + id,
  status: "active",
  attention: false,
  updated: Date.now(),
  current: "",
  progress: "",
  tasks: [],
  actions: {},
  // Everything the detail pane reads, so selecting any row renders it.
  followUps: [],
  activity: [],
  details: [],
});

it("filters the repository panel by name, keeps the chosen one and reports no matches", async () => {
  expect(webHtml).toContain('id="repository-search"');
  const { byId, shown, type } = await boot([
    session("a", "/home/dev/code/sesh-integrator"),
    session("b", "/home/dev/code/secret-sync"),
    session("c", "/srv/work/wsl-glance"),
  ]);
  const all = [
    "",
    "/home/dev/code/secret-sync",
    "/home/dev/code/sesh-integrator",
    "/srv/work/wsl-glance",
  ];
  expect(shown()).toEqual(all);
  expect(byId("repository-empty").hidden).toBe(true);

  // Names match case-insensitively; shared parent folders do not.
  type("  SE ");
  expect(shown()).toEqual(all.slice(0, 3));
  type("dev");
  expect(shown()).toEqual([""]);
  expect(byId("repository-empty").hidden).toBe(false);

  // A separator searches full paths.
  type("/srv/");
  expect(shown()).toEqual(["", "/srv/work/wsl-glance"]);

  // Enter opens the first match, which then stays visible under other queries.
  type("sesh");
  byId("repository-search").dispatch("keydown", { key: "Enter" });
  expect(
    byId("repositories")
      .children.find((b) => b.dataset.repo)
      ?.getAttribute("aria-current"),
  ).toBe("true");
  expect(byId("rows").children).toHaveLength(1);
  type("glance");
  expect(shown()).toEqual([
    "",
    "/home/dev/code/sesh-integrator",
    "/srv/work/wsl-glance",
  ]);

  // Escape clears the filter.
  byId("repository-search").dispatch("keydown", { key: "Escape" });
  expect(byId("repository-search").value).toBe("");
  expect(shown()).toEqual(all);
});

it("diffs config text by line and names changed settings for the save confirmation", async () => {
  expect(webHtml).toContain('id="json-confirm"');
  const { context } = await boot([]);
  const diffLines = context.diffLines as (
    a: string,
    b: string,
  ) => [string, string][] | null;
  const configChanges = context.configChanges as (
    a: string,
    b: string,
  ) => { changes: string[]; programs: string[] } | null;
  expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual([
    [" ", "a"],
    ["-", "b"],
    ["+", "B"],
    [" ", "c"],
    ["+", "d"],
  ]);
  expect(diffLines("same", "same")).toEqual([[" ", "same"]]);
  // Bounded: a pathological input is refused instead of freezing the page.
  const many = (p: string) =>
    Array.from({ length: 2100 }, (_, i) => p + i).join("\n");
  expect(diffLines(many("x"), many("y"))).toBeNull();

  const before = JSON.stringify({
    lockWaitSeconds: 900,
    harnessCommands: { claude: "claude" },
    repositories: [
      {
        path: "/work/alpha",
        setupCommands: [["pnpm", "install"]],
        conflictInstructions: "",
      },
    ],
  });
  const after = JSON.stringify({
    harnessCommands: { claude: "/opt/claude" },
    lockWaitSeconds: 30,
    repositories: [
      {
        conflictInstructions: "Keep both.",
        setupCommands: [["npm", "ci"]],
        path: "/work/alpha",
      },
    ],
  });
  expect(configChanges(before, after)).toEqual({
    changes: [
      "lockWaitSeconds",
      "harnessCommands",
      "alpha: setupCommands, conflictInstructions",
    ],
    programs: ["harnessCommands", "alpha setupCommands"],
  });
  // Key order alone is not a change.
  expect(
    configChanges('{"a":1,"b":{"c":2,"d":3}}', '{"b":{"d":3,"c":2},"a":1}'),
  ).toEqual({ changes: [], programs: [] });
  expect(configChanges("{ broken", "{}")).toBeNull();
});

// A settings API with one earlier config.json version; POST saves record here.
function settingsApi(options: { history?: "fail" | "empty" } = {}) {
  const config = (lockWaitSeconds: number) =>
    JSON.stringify({ lockWaitSeconds, repositories: [] }, null, 2) + "\n";
  const posts: Record<string, unknown>[] = [];
  let raw = {
    configPath: "/runtime/config.json",
    exists: true,
    revision: "rev-1",
    text: config(900),
  };
  const entries = [
    {
      id: "2026-10-19T08-00-00-000Z-a1",
      replacedAt: "2026-10-19T08:00:00.000Z",
      source: "seshx register",
    },
  ];
  const snapshot = config(30);
  const api: Api = (url, init) => {
    if (init?.method === "POST" && url === "/api/settings/json") {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      posts.push(body);
      entries.unshift({
        id: "2026-10-20T08-00-00-000Z-b2",
        replacedAt: "2026-10-20T08:00:00.000Z",
        source: "dashboard",
      });
      raw = { ...raw, revision: "rev-2", text: String(body.text) };
      return [200, raw];
    }
    if (url === "/api/settings")
      return [
        200,
        {
          configPath: raw.configPath,
          exists: true,
          revision: raw.revision,
          global: {
            defaultTargetBranch: "dev",
            reviewers: [],
            assignees: [],
            lockWaitSeconds: 900,
            conflictResolutionMode: "current-session",
            deliveryPolicyFile: "",
            harnessCommands: {},
          },
          harnesses: [],
          repositories: [],
        },
      ];
    if (url === "/api/settings/json") return [200, raw];
    if (url === "/api/settings/history")
      return options.history === "fail"
        ? [500, { error: "History folder is unreadable" }]
        : [
            200,
            {
              limit: 20,
              entries: options.history === "empty" ? [] : entries,
            },
          ];
    if (url.startsWith("/api/settings/history/"))
      return [200, { ...entries.at(-1), text: snapshot }];
    return undefined;
  };
  return { api, posts, snapshot, raw: () => raw };
}
const settle = async () => {
  for (let i = 0; i < 20; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const buttons = (root: FakeElement, label: string) =>
  root.find((n) => n.tagName === "BUTTON" && n.textContent === label);

it("shows config history in its own Settings tab with saved choice and keyboard navigation", async () => {
  for (const id of ["tab-history", "panel-history", "settings-history-button"])
    expect(webHtml).toContain(`id="${id}"`);
  const storage = new Map([["sesh-settings-tab", "history"]]);
  const { api } = settingsApi();
  const { byId } = await boot([], { api, storage });
  byId("settings-button").dispatch("click");
  await settle();

  // The saved tab choice opens History; the JSON tab no longer lists versions.
  expect(byId("tab-history").getAttribute("aria-selected")).toBe("true");
  expect(byId("panel-history").hidden).toBe(false);
  expect(byId("panel-json").hidden).toBe(true);
  const panel = byId("panel-history");
  expect(panel.text).toContain("Earlier versions");
  expect(buttons(panel, "Compare with current")).toHaveLength(1);
  expect(buttons(panel, "Restore")).toHaveLength(1);
  expect(buttons(byId("panel-json"), "Compare with current")).toHaveLength(0);
  expect(buttons(byId("panel-json"), "Restore")).toHaveLength(0);

  // Arrow keys wrap through all four tabs, and the choice is saved.
  const tablist = byId('query #settings [role="tablist"]');
  tablist.dispatch("keydown", { key: "ArrowRight" });
  expect(byId("tab-global").getAttribute("aria-selected")).toBe("true");
  expect(byId("panel-history").hidden).toBe(true);
  tablist.dispatch("keydown", { key: "ArrowLeft" });
  expect(byId("tab-history").getAttribute("aria-selected")).toBe("true");
  tablist.dispatch("keydown", { key: "Home" });
  tablist.dispatch("keydown", { key: "End" });
  expect(FakeElement.focused).toBe(byId("tab-history"));
  expect(storage.get("sesh-settings-tab")).toBe("history");
});

it("keeps the empty and unavailable history states in the tab and the header dialog", async () => {
  const empty = await boot([], { api: settingsApi({ history: "empty" }).api });
  empty.byId("settings-button").dispatch("click");
  await settle();
  expect(empty.byId("panel-history").text).toContain(
    "No earlier versions yet.",
  );
  empty.byId("settings-history-button").dispatch("click");
  expect(empty.byId("history-dialog").open).toBe(true);
  expect(empty.byId("history-dialog-body").text).toContain(
    "No earlier versions yet.",
  );

  const failed = await boot([], { api: settingsApi({ history: "fail" }).api });
  failed.byId("settings-button").dispatch("click");
  await settle();
  for (const id of ["panel-history", "history-dialog-body"])
    expect(failed.byId(id).text).toContain("History is unavailable.");
  // The editor still works without history.
  expect(failed.byId("settings-error").hidden).toBe(true);
  expect(failed.byId("panel-json").children).toHaveLength(1);
});

it("restores from the header History dialog only through the save confirmation", async () => {
  const { api, posts, snapshot, raw } = settingsApi();
  const { byId } = await boot([], { api });
  byId("settings-button").dispatch("click");
  await settle();
  const original = raw().text;

  // An unsaved JSON edit, made on the JSON tab before opening History.
  const form = byId("panel-json").children[0]!;
  const editor = form.find((n) => n.tagName === "TEXTAREA")[0]!;
  expect(editor.value).toBe(original);
  editor.value = original.replace("900", "45");
  form.dispatch("input", { target: editor });
  expect(form.dataset.dirty).toBe("true");

  // The header button opens the same list from the Global tab.
  expect(byId("tab-global").getAttribute("aria-selected")).toBe("true");
  byId("settings-history-button").dispatch("click");
  expect(byId("history-dialog").open).toBe(true);
  const dialog = byId("history-dialog-body");
  expect(buttons(dialog, "Compare with current")).toHaveLength(1);

  // Cancel leaves the file and the editor alone.
  buttons(dialog, "Restore")[0]!.dispatch("click");
  await settle();
  expect(byId("json-confirm").open).toBe(true);
  expect(byId("json-confirm-context").hidden).toBe(false);
  expect(byId("json-confirm-context").textContent).toContain(
    "Restores the version replaced",
  );
  expect(byId("json-confirm-context").textContent).toContain("JSON tab");
  expect(byId("json-confirm-changes").text).toContain("lockWaitSeconds");
  byId("json-confirm-cancel").dispatch("click");
  await settle();
  expect(byId("json-confirm").open).toBe(false);
  expect(posts).toHaveLength(0);
  expect(editor.value).toBe(original.replace("900", "45"));

  // Confirming saves the earlier version against the current revision.
  buttons(dialog, "Restore")[0]!.dispatch("click");
  await settle();
  byId("json-confirm-form").dispatch("submit");
  await settle();
  expect(posts).toEqual([{ text: snapshot, revision: "rev-1" }]);
  expect(byId("history-dialog").open).toBe(true);
  expect(dialog.text).toContain("Restored the version replaced");
  expect(byId("panel-history").text).toContain("Restored the version replaced");
  expect(buttons(dialog, "Restore")).toHaveLength(2);
  expect(FakeElement.focused).toBe(dialog);

  // The editor keeps the unsaved edit instead of loading either version.
  expect(byId("panel-json").children[0]).toBe(form);
  expect(editor.value).toBe(original.replace("900", "45"));
  expect(form.dataset.dirty).toBe("true");

  byId("history-dialog-close").dispatch("click");
  expect(byId("history-dialog").open).toBe(false);

  // A normal JSON save uses the same confirmation without restore context.
  form.dispatch("submit");
  await settle();
  expect(byId("json-confirm").open).toBe(true);
  expect(byId("json-confirm-context").hidden).toBe(true);
  byId("json-confirm-cancel").dispatch("click");
  await settle();
  expect(posts).toHaveLength(1);
});
