import React, { act, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { getDefaultStore } from "jotai";
import type { Action } from "kbar";
import type * as KBarModule from "kbar";
import type { MailLayoutProps } from "~/app/mail/components/mail-layout";
import type * as LayoutModule from "~/app/mail/components/mail-layout";
import type * as DemoProviderModule from "~/demo/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenDemoCalls } from "../helpers/demo-isolation";

type HostProps = {
  children?: ReactNode; "aria-label"?: string; "data-demo-thread"?: string; role?: string;
  onClick?: () => void; onChange?: (event: { target: { value: string } }) => void;
  [key: string]: unknown;
};
const { route, storage, writes, hosts, layout, provider, registry, view } = vi.hoisted(() => ({
  route: { path: "/demo" }, storage: new Map<string, unknown>(), writes: vi.fn(),
  hosts: new Map<string, HostProps>(), layout: vi.fn<(props: MailLayoutProps) => void>(),
  provider: vi.fn(), registry: { actions: [] as Action[] },
  view: { snapshot: false, mailbox: null as ReturnType<typeof DemoProviderModule.useDemoMailbox> | null },
}));
vi.mock("~/trpc/react", async () => ({ api: { account: (await import("../helpers/demo-isolation")).forbiddenAccountApi } }));
vi.mock("~/lib/aurinko", async () => ({ getAurinkoAuthURL: () => import("../helpers/demo-isolation").then(({ forbiddenDemoCall }) => forbiddenDemoCall("OAuth")) }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));
vi.mock("usehooks-ts", () => ({ useLocalStorage: (key: string, initial: unknown) => [storage.has(key) ? storage.get(key) : initial,
  (value: unknown) => { writes(key, value); storage.set(key, value); }] }));
vi.mock("lucide-react", () => ({ File: () => null, Inbox: () => null, Send: () => null, Search: () => null }));
vi.mock("~/app/mail/components/thread-actions", () => ({ ThreadActions: () => null }));
vi.mock("~/app/mail/components/kbar/use-theme-switching", () => ({ default: () => undefined }));
vi.mock("kbar", async original => {
  const actual = await original<typeof KBarModule>();
  return { ...actual, KBarPortal: () => null,
    KBarProvider: function ObservedPalette({ actions, children }: PropsWithChildren<{ actions: Action[] }>) {
      provider(actions);
      React.useEffect(() => {
        registry.actions = actions;
        return () => { registry.actions = []; };
      }, [actions]);
      return children;
    } };
});
vi.mock("~/demo/provider", async original => {
  const actual = await original<typeof DemoProviderModule>();
  return { ...actual, useDemoMailbox: function useObservedMailbox() {
    const mailbox = actual.useDemoMailbox();
    // Bridge the live provider's actual state to real SSR presentation snapshots.
    // No fixture-derived filtering or state transitions are duplicated here.
    if (view.snapshot && view.mailbox) return view.mailbox;
    view.mailbox = mailbox;
    return mailbox;
  } };
});
vi.mock("~/app/mail/components/mail-layout", async original => {
  const actual = await original<typeof LayoutModule>();
  return { MailLayout: function LayoutBoundary(props: MailLayoutProps) {
    layout(props);
    if (view.snapshot) return React.createElement(actual.MailLayout, props);
    return React.createElement(React.Fragment, null, props.accountSwitcher(false), props.sidebar(false),
      props.searchBar, props.threadList, props.threadDisplay);
  } };
});
vi.mock("~/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: PropsWithChildren) => children,
  ResizablePanel: ({ children }: PropsWithChildren) => children,
  ResizableHandle: () => null,
}));

// Existing UI-004-style null host: execute real state/effects and capture public
// DOM control props instead of adding a browser framework. SSR tests keep the
// real shared layout, Radix Tabs and UX-001 toolbar separately.
vi.mock("react/jsx-runtime", async original => {
  type Factory = (type: React.ElementType, props: HostProps, key?: string) => React.ReactElement;
  const actual = await original<{ jsx: Factory; jsxs: Factory }>();
  const wrappers = new Map<string, React.FunctionComponent<HostProps>>();
  function wrap(factory: Factory): Factory {
    return (type, props, key) => {
      if (view.snapshot || typeof type !== "string") return factory(type, props, key);
      let Host = wrappers.get(type);
      if (!Host) {
        const tag = type;
        Host = function HostBoundary(props: HostProps) {
          const id = String(props["aria-label"] ?? props["data-demo-thread"] ?? props.role ?? tag);
          hosts.set(id, props);
          React.useEffect(() => () => { if (hosts.get(id) === props) hosts.delete(id); }, [id, props]);
          return React.Children.toArray(props.children).filter(React.isValidElement);
        };
        wrappers.set(type, Host);
      }
      return factory(Host, props, key);
    };
  }
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async () => {
  type Factory = (type: React.ElementType, props: HostProps, key?: string) => React.ReactElement;
  const runtime = await import("react/jsx-runtime") as unknown as { jsx: Factory; jsxs: Factory; Fragment: typeof React.Fragment };
  return { Fragment: runtime.Fragment,
    jsxDEV: (type: React.ElementType, props: HostProps, key: string | undefined, staticChildren: boolean) =>
      (staticChildren ? runtime.jsxs : runtime.jsx)(type, props, key),
  };
});

import DemoPage from "~/app/demo/[[...path]]/page";
import KBar from "~/app/mail/components/kbar";
import { threadIdAtom } from "~/hooks/use-threads";

let root: Root;
const store = getDefaultStore();
const productionState = { accountId: "production-account", "tab-category": "sent", "thread-done": true };
function renderDemo() { act(() => root.render(React.createElement(KBar, null, React.createElement(DemoPage)))); }
function control(label: string) {
  const props = hosts.get(label);
  if (!props) throw new Error(`Missing demo control ${label}`);
  return props;
}
function click(label: string) {
  const handler = control(label).onClick;
  if (typeof handler !== "function") throw new Error(`Missing click handler ${label}`);
  act(() => { handler(); });
}
function change(label: string, value: string) {
  const handler = control(label).onChange;
  if (typeof handler !== "function") throw new Error(`Missing change handler ${label}`);
  act(() => { handler({ target: { value } }); });
}
function status(done: boolean) { act(() => { layout.mock.lastCall?.[0].onDoneChange(done); }); }
function subject() { return hosts.get("h2")?.children; }
function renderedDemo() {
  if (!view.mailbox) throw new Error("Demo must be mounted before taking its UI snapshot");
  view.snapshot = true;
  try { return renderToString(React.createElement(DemoPage)); }
  finally { view.snapshot = false; }
}
function expectDraftDone(html: string) {
  expect(html).toMatch(/<h1[^>]*>Draft<\/h1>/);
  expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="false"[^>]*>Active<\/button>/);
  expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Done<\/button>/);
  expect(html).toContain('data-demo-thread="demo-avery-invitation"');
  expect(html).not.toContain('data-demo-thread="demo-avery-newsletter"');
}
function keyboard(shortcut: string[]) {
  for (const action of registry.actions) {
    if (action.shortcut?.join(" ") === shortcut.join(" ")) action.perform?.(action as never);
  }
}
function expectProductionUnchanged() {
  expect(Object.fromEntries(storage)).toEqual(productionState);
  expect(storage.get("accountId")).not.toMatch(/^demo-/);
  expect(store.get(threadIdAtom)).toBe("production-thread");
  expect(writes).not.toHaveBeenCalled();
  expect(forbiddenDemoCalls).toEqual([]);
}

beforeEach(() => {
  route.path = "/demo";
  storage.clear(); Object.entries(productionState).forEach(([key, value]) => storage.set(key, value));
  store.set(threadIdAtom, "production-thread");
  hosts.clear(); registry.actions = []; forbiddenDemoCalls.length = 0;
  view.snapshot = false; view.mailbox = null;
  const document = { nodeType: 9, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, addEventListener: vi.fn(), removeEventListener: vi.fn(), textContent: "" };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { HTMLIFrameElement: class {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  expectProductionUnchanged();
  store.set(threadIdAtom, null);
  vi.unstubAllGlobals();
});

describe("DEMO-001 real demo interactions and production-state isolation", () => {
  it.each(["", " \t\n "])("renders global search without status tabs and restores Draft + Done for cleared/blank query %j", cleared => {
    renderDemo();
    click("Draft demo category"); status(true);
    expectDraftDone(renderedDemo());
    change("Search synthetic mailbox", "  Aurora  ");
    const results = renderedDemo();
    expect(results).toMatch(/<h1[^>]*>Search Results<\/h1>/);
    expect(results).not.toContain('role="tab"');
    expect(results).not.toContain('role="tablist"');
    expect(results).not.toContain('role="tabpanel"');
    expect(results).toContain('data-demo-thread="demo-avery-aurora"');
    expect(results).not.toContain('data-demo-thread="demo-avery-invitation"');
    expect(view.mailbox?.state.category).toBe("draft");
    expect(view.mailbox?.state.done).toBe(true);
    if (cleared) change("Search synthetic mailbox", cleared);
    else click("Clear demo search");
    expectDraftDone(renderedDemo());
    expectProductionUnchanged();
  });

  it("navigates both local accounts, all views, thread reading and local search without account APIs", () => {
    renderDemo();
    expect(subject()).toBe("Aurora launch plan");
    click("demo-avery-ceramics");
    expect(subject()).toBe("Saturday ceramics workshop");
    for (const category of ["Inbox", "Sent", "Draft"] as const) {
      click(`${category} demo category`);
      expect(layout.mock.lastCall?.[0].heading).toBe(category);
      for (const done of [true, false]) {
        status(done);
        expect(layout.mock.lastCall?.[0].done).toBe(done);
        const subjects = {
          Inbox: ["Aurora launch plan", "Design books receipt"],
          Sent: ["Community garden proposal", "Thanks for the review"],
          Draft: ["Draft: May studio newsletter", "Draft: exhibition invitation"],
        };
        expect(subject()).toBe(subjects[category][done ? 1 : 0]);
      }
    }
    change("Search synthetic mailbox", "Aurora");
    expect(subject()).toBe("Aurora launch plan");
    change("Search synthetic mailbox", "nonexistent-needle");
    expect(subject()).toBeUndefined();
    expect(control("status").children).toBe("No synthetic threads match your search.");
    click("Clear demo search");
    expect(control("Search synthetic mailbox").value).toBe("");
    expect(subject()).toBe("Draft: May studio newsletter");
    change("Synthetic demo account", "demo-robin");
    expect(control("Synthetic demo account").value).toBe("demo-robin");
    expect(subject()).toBe("Aurora launch plan");
    expect(control("demo-robin-aurora")["aria-pressed"]).toBe(true);
    expectProductionUnchanged();
    expect(provider).not.toHaveBeenCalled();
    expect(registry.actions).toEqual([]);
    for (const keys of [["g", "i"], ["g", "s"], ["g", "d"], ["g", "p"], ["g", "f"]]) keyboard(keys);
    expectProductionUnchanged();
  });

  it.each(["/demo", "/demo/", "/demo/example"])("unmounts production mailbox KBar commands on entry to %s and restores only production state on exit", path => {
    route.path = "/mail";
    act(() => root.render(React.createElement(KBar, null, null)));
    expect(registry.actions.map(action => action.id)).toEqual(["inboxAction", "sentAction", "draftAction", "activeAction", "doneAction"]);
    provider.mockClear();
    route.path = path;
    renderDemo();
    expect(provider).not.toHaveBeenCalled();
    expect(registry.actions).toEqual([]);
    change("Synthetic demo account", "demo-robin");
    click("Draft demo category"); status(true);
    click("demo-robin-invitation");
    for (const keys of [["g", "s"], ["g", "f"], ["g", "p"]]) keyboard(keys);
    expectProductionUnchanged();
    route.path = "/mail";
    act(() => root.render(React.createElement(KBar, null, null)));
    expect(registry.actions).toHaveLength(5);
    expectProductionUnchanged();
  });
});
