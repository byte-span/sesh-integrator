import { afterEach, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { settingsView } from "../src/dashboard-settings.js";
import type { SettingsSuggestions } from "../src/dashboard-suggestions.js";
import { webHtml, webScript } from "../src/dashboard-web-assets.js";
import type { Config } from "../src/types.js";

afterEach(() => vi.unstubAllEnvs());

// A minimal recording DOM: enough for the dashboard script to boot and render
// without a browser. Unknown members resolve to no-op functions.
type Listener = (event: Record<string, unknown>) => void;
class FakeEvent {
  defaultPrevented = false;
  stopped = false;
  bubbles: boolean;
  target?: FakeElement;
  currentTarget?: FakeElement;
  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    this.bubbles = !!init.bubbles;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}
class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  id = "";
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
      if (node instanceof FakeElement) {
        node.parentElement = this;
        this.children.push(node);
      }
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
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  /** Calls handlers here, then on each parent when the event bubbles. */
  dispatchEvent(event: FakeEvent) {
    event.target ??= this;
    for (
      let node: FakeElement | null = this;
      node && !event.stopped;
      node = event.bubbles ? node.parentElement : null
    ) {
      event.currentTarget = node;
      const handler = (node as Record<string, unknown>)["on" + event.type];
      if (typeof handler === "function") handler(event);
      for (const listener of node.listeners.get(event.type) ?? [])
        listener(event as unknown as Record<string, unknown>);
    }
    return !event.defaultPrevented;
  }
  /** A user event: bubbles to the form and records preventDefault. */
  fire(type: string, init: Record<string, unknown> = {}) {
    const event = new FakeEvent(type, { bubbles: true, ...init });
    this.dispatchEvent(event);
    return event;
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
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  get text(): string {
    return this.textContent + this.children.map((c) => c.text).join("");
  }
}
const lenient = <T extends object>(target: T): T =>
  new Proxy(target, {
    get: (t, key) =>
      key in t || typeof key === "symbol"
        ? Reflect.get(t, key)
        : () => undefined,
  });

type Api = (url: string, init?: { method?: string; body?: string }) => unknown;

async function boot(rows: Record<string, unknown>[], api?: Api) {
  const ids = new Map<string, FakeElement>();
  const byId = (id: string) => {
    if (!ids.has(id)) ids.set(id, lenient(new FakeElement()));
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
      querySelector: () => lenient(new FakeElement()),
      createElement: (tag: string) =>
        lenient(new FakeElement(tag.toUpperCase())),
    }),
  );
  const state = { rows, job: null, refreshedAt: Date.now() };
  const context: Record<string, unknown> = {
    document,
    window: { innerWidth: 1400, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class {
      observe() {}
    },
    EventSource: class {
      addEventListener() {}
    },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      if (!api || url === "/api/state")
        return { ok: true, json: async () => state };
      try {
        const value = await api(url, init);
        return { ok: true, json: async () => value };
      } catch (error) {
        return {
          ok: false,
          json: async () => ({ error: (error as Error).message }),
        };
      }
    },
    Event: FakeEvent,
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

// Settings with suggestion fields, served by a stub API.
const settingsConfig = (): Config => {
  const repo = (name: string, targetBranch?: string) => ({
    path: "/work/" + name,
    gitCommonDir: "/work/" + name + "/.git",
    defaultBranch: "main",
    integrationBranch: "sesh-integrator/integration",
    ...(targetBranch ? { targetBranch } : {}),
    promotion: { type: "pull-request" as const },
    setupCommands: [],
    sourceValidationCommands: [],
    integrationValidationCommands: [],
    postIntegrationCommands: [],
    conflictInstructions: "",
  });
  return {
    lockWaitSeconds: 900,
    defaultTargetBranch: "dev",
    defaultPromotion: { reviewers: ["platform-team"] },
    repositories: [repo("alpha"), repo("beta", "stable"), repo("gamma")],
  };
};
const suggestions = (): SettingsSuggestions => ({
  repositories: [
    {
      path: "/work/alpha",
      name: "alpha",
      branches: ["dev", "feature", "main"],
      remoteBranches: { origin: ["main", "release"] },
      remotes: ["origin"],
    },
    {
      path: "/work/beta",
      name: "beta",
      branches: ["dev", "main"],
      remoteBranches: {},
      remotes: ["origin"],
    },
    {
      path: "/work/gamma",
      name: "gamma",
      branches: ["main"],
      remoteBranches: {},
      remotes: [],
    },
  ],
  participants: ["Alice", "bigobot", "byte-span/core"],
  programs: {
    signing: [{ name: "gpg", paths: ["/usr/bin/gpg", "/opt/bin/gpg"] }],
    harnesses: {
      codex: [],
      claude: [{ name: "claude", paths: ["/usr/local/bin/claude"] }],
      antigravity: [],
      grok: [],
    } as SettingsSuggestions["programs"]["harnesses"],
  },
});

function find(
  node: FakeElement,
  match: (n: FakeElement) => boolean,
): FakeElement | undefined {
  if (match(node)) return node;
  for (const child of node.children) {
    const found = find(child, match);
    if (found) return found;
  }
  return undefined;
}

async function bootSettings(loadSuggestions: () => unknown) {
  vi.stubEnv("SESH_INTEGRATOR_HOME", "/runtime");
  const view = settingsView(null, settingsConfig());
  const saved: Record<string, unknown>[] = [];
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const dashboard = await boot([], (url, init) => {
    if (url === "/api/settings" && init?.method === "POST") {
      saved.push(JSON.parse(init.body!));
      return view;
    }
    if (url === "/api/settings") return view;
    if (url === "/api/settings/json")
      return { ...view, text: JSON.stringify(settingsConfig()) };
    if (url === "/api/settings/history") return { limit: 20, entries: [] };
    if (url === "/api/settings/suggestions") return loadSuggestions();
    throw new Error("Unexpected request " + url);
  });
  const { byId } = dashboard;
  byId("settings-button").dispatch("click");
  for (let i = 0; i < 5; i++) await settled();
  const form = (scope: string) => byId("panel-" + scope).children[0]!;
  const field = (scope: string, name: string) => {
    const input = find(form(scope), (n) => n.id === "setting-" + name)!;
    const list = () =>
      find(form(scope), (n) => n.id === input.id + "-options")!;
    const warning = () =>
      find(form(scope), (n) => n.id === input.id + "-warning");
    return {
      input,
      list,
      warning,
      options: () =>
        list().hidden ? [] : list().children.map((option) => option.text),
      type(value: string) {
        input.value = value;
        input.fire("input");
      },
      key: (key: string) => input.fire("keydown", { key }),
      chips: () =>
        find(form(scope), (n) => n.className === "chip-list")!.children.map(
          (chip) => chip.children[0]!.text,
        ),
    };
  };
  return { ...dashboard, form, field, saved, settled };
}

it("filters branch suggestions, picks with the keyboard and offers new branches with a warning", async () => {
  const { form, field } = await bootSettings(suggestions);
  const target = field("global", "global-target");
  expect(target.input.getAttribute("role")).toBe("combobox");
  expect(target.input.getAttribute("aria-controls")).toBe(target.list().id);
  // The saved default is checked once suggestions load.
  expect(target.warning()?.text).toContain('No branch "dev" in gamma,');

  // Arrow keys open the full list, most widely present branch first.
  target.type("");
  target.key("Escape");
  target.key("ArrowDown");
  expect(target.options()).toEqual([
    "main3 of 3 repos",
    "dev2 of 3 repos",
    "feature1 of 3 repos",
  ]);
  expect(target.input.getAttribute("aria-expanded")).toBe("true");
  expect(target.list().children[1]!.getAttribute("aria-label")).toBe(
    "dev — 2 of 3 repos",
  );
  target.key("ArrowDown");
  expect(target.input.getAttribute("aria-activedescendant")).toBe(
    target.list().children[1]!.id,
  );
  expect(target.list().children[1]!.getAttribute("aria-selected")).toBe("true");
  // Escape closes the list and keeps the typed value.
  const escape = target.key("Escape");
  expect(escape.defaultPrevented).toBe(true);
  expect(target.list().hidden).toBe(true);
  expect(target.input.getAttribute("aria-expanded")).toBe("false");
  expect(target.input.getAttribute("aria-activedescendant")).toBeNull();

  // Typing filters; an unmatched name is offered as a new branch.
  target.type("de");
  expect(target.options()).toEqual(["dev2 of 3 repos", 'Use new branch "de"']);
  target.key("ArrowDown");
  const enter = target.key("Enter");
  expect(enter.defaultPrevented).toBe(true);
  expect(target.input.value).toBe("dev");
  expect(target.list().hidden).toBe(true);
  expect(form("global").dataset.dirty).toBe("true");
  // beta has its own target, so only gamma, which inherits, lacks dev.
  expect(target.warning()?.hidden).toBe(false);
  expect(target.warning()?.text).toContain('No branch "dev" in gamma, which');

  target.type("release");
  expect(target.options()).toEqual(['Use new branch "release"']);
  target.key("ArrowUp");
  target.key("Enter");
  expect(target.input.value).toBe("release");
  expect(target.warning()?.text).toBe(
    'No branch "release" in alpha, gamma, which use this default. Saving does not create it; create it there before integrating.',
  );
  // Clicking an option picks it too.
  target.type("mai");
  target.list().children[0]!.fire("click");
  expect(target.input.value).toBe("main");
  expect(target.warning()?.hidden).toBe(true);

  // Programs found on PATH: the name, then each path.
  const claude = field("global", "global-harness-claude");
  claude.type("cl");
  expect(claude.options()).toEqual([
    "claude/usr/local/bin/claude",
    "/usr/local/bin/claude",
  ]);

  // Repository fields use that repository's branches and remotes.
  const production = field("repository", "repo-production");
  production.type("rel");
  // Remote-only branches count: a pull-request base may exist only there.
  expect(production.options()).toEqual(["release", 'Use new branch "rel"']);
  production.input.value = "release";
  production.input.fire("change");
  expect(production.warning()?.hidden).toBe(true);
  const repoTarget = field("repository", "repo-target");
  repoTarget.type("ma");
  expect(repoTarget.options()).toEqual([
    "maindefault branch",
    'Use new branch "ma"',
  ]);
  repoTarget.input.value = "release";
  repoTarget.input.fire("change");
  expect(repoTarget.warning()?.text).toContain('No branch "release" in alpha.');
  const remote = field("repository", "repo-remote");
  remote.type("");
  remote.key("ArrowDown");
  expect(remote.options()).toEqual(["origin"]);
  remote.input.value = "upstream";
  remote.input.fire("change");
  expect(remote.warning()?.text).toContain('No remote "upstream" in alpha.');
  // The production branch is checked against the chosen remote.
  expect(production.warning()?.text).toContain('No branch "release" in alpha.');
  const signing = field("repository", "repo-gpg");
  signing.type("gpg");
  expect(signing.options()).toEqual([
    "gpg/usr/bin/gpg",
    "/usr/bin/gpg",
    "/opt/bin/gpg",
  ]);
});

it("enters reviewers and assignees as chips and saves only the names", async () => {
  const { form, field, saved, settled } = await bootSettings(suggestions);
  const reviewers = field("global", "global-reviewers");
  expect(reviewers.chips()).toEqual(["platform-team"]);

  // A comma ends a name; duplicates are ignored.
  reviewers.type("alice,");
  expect(reviewers.chips()).toEqual(["platform-team", "alice"]);
  expect(reviewers.input.value).toBe("");
  expect(form("global").dataset.dirty).toBe("true");
  reviewers.type("PLATFORM-team ");
  expect(reviewers.chips()).toEqual(["platform-team", "alice"]);

  // Suggestions omit chosen names and can be picked with the keyboard.
  reviewers.type("b");
  expect(reviewers.options()).toEqual(["bigobot", "byte-span/core"]);
  reviewers.key("ArrowDown");
  reviewers.key("Enter");
  expect(reviewers.chips()).toEqual(["platform-team", "alice", "bigobot"]);
  reviewers.type("carol");
  const enter = reviewers.key("Enter");
  expect(enter.defaultPrevented).toBe(true);
  expect(reviewers.chips()).toEqual([
    "platform-team",
    "alice",
    "bigobot",
    "carol",
  ]);
  // Backspace in the empty input removes the last chip; × removes any.
  reviewers.key("Backspace");
  find(
    form("global"),
    (n) => n.getAttribute("aria-label") === "Remove reviewer alice",
  )!.fire("click");
  expect(reviewers.chips()).toEqual(["platform-team", "bigobot"]);

  // Teams cannot be assignees.
  const assignees = field("global", "global-assignees");
  assignees.type("b");
  expect(assignees.options()).toEqual(["bigobot"]);
  assignees.type("dana");

  form("global").onsubmit!({ preventDefault() {} });
  await settled();
  expect(saved.at(-1)).toMatchObject({
    scope: "global",
    values: {
      defaultTargetBranch: "dev",
      reviewers: ["platform-team", "bigobot"],
      assignees: ["dana"],
    },
  });

  // Repository chips keep "inherit" (null) apart from an explicit empty list.
  const repoReviewers = field("repository", "repo-reviewers");
  expect(repoReviewers.chips()).toEqual([]);
  expect(repoReviewers.input.placeholder).toBe("Inherit: platform-team");
  repoReviewers.type("Alice ");
  expect(repoReviewers.input.placeholder).toBe("");
  form("repository").onsubmit!({ preventDefault() {} });
  await settled();
  expect(saved.at(-1)).toMatchObject({
    scope: "repository",
    values: { promotion: { reviewers: ["Alice"], assignees: null } },
  });
});

it("keeps every field usable when suggestions cannot be loaded", async () => {
  const { form, field, saved, settled } = await bootSettings(() => {
    throw new Error("Git is unavailable");
  });
  const target = field("global", "global-target");
  target.type("release");
  // No list and no new-branch option or warning: nothing is known.
  expect(target.list().hidden).toBe(true);
  target.key("ArrowDown");
  expect(target.list().hidden).toBe(true);
  target.input.fire("change");
  expect(target.warning()?.hidden).toBe(true);
  const reviewers = field("global", "global-reviewers");
  reviewers.type("erin");
  reviewers.key("Enter");
  expect(reviewers.chips()).toEqual(["platform-team", "erin"]);
  form("global").onsubmit!({ preventDefault() {} });
  await settled();
  expect(saved.at(-1)).toMatchObject({
    values: {
      defaultTargetBranch: "release",
      reviewers: ["platform-team", "erin"],
    },
  });
});
