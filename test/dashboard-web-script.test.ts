import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { webHtml, webScript } from "../src/dashboard-web-assets.js";

// A minimal recording DOM: enough for the dashboard script to boot and render
// without a browser. Unknown members resolve to no-op functions.
type Listener = (event: Record<string, unknown>) => void;
class FakeElement {
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

async function boot(rows: Record<string, unknown>[]) {
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
  runInNewContext(webScript, {
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
    fetch: async () => ({ ok: true, json: async () => state }),
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const shown = () =>
    byId("repositories").children.map((b) => b.dataset.repo ?? "");
  const type = (value: string) => {
    byId("repository-search").value = value;
    byId("repository-search").dispatch("input");
  };
  return { byId, shown, type };
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
