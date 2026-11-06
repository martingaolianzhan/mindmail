import { createElement, type ComponentProps, type PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";
import type { Action, ActionImpl } from "kbar";
import type * as KBarModule from "kbar";
import type * as TabsModule from "~/components/ui/tabs";
import type { Tabs } from "~/components/ui/tabs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { storage, reads, writes, tabs, actions, getThreads, getAccounts } = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  reads: new Set<string>(),
  writes: vi.fn(),
  tabs: vi.fn<(props: ComponentProps<typeof Tabs>) => void>(),
  actions: vi.fn<(value: Action[]) => void>(),
  getThreads: vi.fn(),
  getAccounts: vi.fn(),
}));

// Model useLocalStorage's shared-key persistence contract, replaying renders after
// captured control callbacks. This is a component contract test, not browser E2E.
vi.mock("usehooks-ts", () => ({
  useLocalStorage: (key: string, initial: unknown) => {
    reads.add(key);
    return [storage.has(key) ? storage.get(key) : initial, (value: unknown) => {
      writes(key, value);
      storage.set(key, value);
    }];
  },
}));
vi.mock("~/trpc/react", () => ({
  api: { account: {
    getAccounts: { useQuery: getAccounts },
    getThreads: { useQuery: getThreads },
  } },
}));
vi.mock("~/components/ui/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof TabsModule>();
  return { ...actual, Tabs: (props: ComponentProps<typeof actual.Tabs>) => {
    tabs(props);
    return createElement(actual.Tabs, props);
  } };
});
vi.mock("kbar", async (importOriginal) => {
  const actual = await importOriginal<typeof KBarModule>();
  return { ...actual,
    KBarProvider: (props: PropsWithChildren<{ actions: Action[] }>) => {
      actions(props.actions);
      return props.children;
    },
    KBarPortal: () => null,
  };
});
vi.mock("~/app/mail/components/kbar/use-theme-switching", () => ({ default: () => undefined }));
vi.mock("~/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: PropsWithChildren) => children,
  ResizablePanel: ({ children }: PropsWithChildren) => children,
  ResizableHandle: () => null,
}));
vi.mock("~/app/mail/components/account-switcher", () => ({ default: () => null }));
vi.mock("~/app/mail/components/sidebar", () => ({ default: () => null }));
vi.mock("~/app/mail/components/thread-display", () => ({ default: () => null }));
vi.mock("~/app/mail/components/email-search/search-bar", () => ({ default: () => null }));
vi.mock("~/app/mail/components/thread-list", async () => {
  const { default: useThreads } = await import("~/hooks/use-threads");
  return { default: function ThreadListProbe() { useThreads(); return null; } };
});

import Mail from "~/app/mail/mail";
import KBar from "~/app/mail/components/kbar";

function renderMail() {
  return renderToString(createElement(KBar, null,
    createElement(Mail, { defaultLayout: undefined, navCollapseSize: 4, defaultCollapsed: false }),
  ));
}

function expectView(html: string, category: "inbox" | "sent" | "draft", done: boolean) {
  const heading = { inbox: "Inbox", sent: "Sent", draft: "Draft" }[category];
  expect(html).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
  expect(html).toMatch(new RegExp(`<button[^>]*data-state="active"[^>]*>${done ? "Done" : "Active"}</button>`));
  expect(tabs.mock.lastCall?.[0].value).toBe(done ? "done" : "active");
  expect(tabs.mock.lastCall?.[0].defaultValue).toBeUndefined();
  expect(getThreads.mock.lastCall?.[0]).toEqual({ accountId: "account-status", tabCategory: category, done });
  expect([...reads].sort()).toEqual(["accountId", "tab-category", "thread-done"]);
}

function selectStatus(value: "active" | "done") {
  const onChange = tabs.mock.lastCall?.[0].onValueChange;
  expect(onChange).toBeTypeOf("function");
  onChange?.(value);
}

function performAction(name: string) {
  const action = actions.mock.lastCall?.[0].find(item => item.name === name);
  if (!action?.perform) throw new Error(`Missing KBar action: ${name}`);
  action.perform(action as ActionImpl);
}

beforeEach(() => {
  storage.clear();
  reads.clear();
  storage.set("accountId", "account-status");
  getAccounts.mockReturnValue({ data: [] });
  getThreads.mockReturnValue({ data: [], isFetching: false, refetch: vi.fn() });
});

describe("UI-002 canonical thread status and mailbox heading", () => {
  it("defaults to Active even with an obsolete saved thread-finish value", () => {
    storage.set("thread-finish", true);
    expectView(renderMail(), "inbox", false);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([
    ["inbox", false], ["inbox", true],
    ["sent", false], ["sent", true],
    ["draft", false], ["draft", true],
  ] as const)("restores %s with persisted done=%s in Tabs, heading and query", (category, done) => {
    storage.set("tab-category", category);
    storage.set("thread-done", done);
    expectView(renderMail(), category, done);
    expect(writes).not.toHaveBeenCalled();
  });

  it("persists both Tabs selections without changing the mailbox category", () => {
    storage.set("tab-category", "sent");
    renderMail();
    selectStatus("done");
    expect(writes.mock.calls).toEqual([["thread-done", true]]);
    expect(storage.get("thread-done")).toBe(true);
    expect(storage.get("tab-category")).toBe("sent");
    expectView(renderMail(), "sent", true);

    selectStatus("active");
    expect(writes.mock.calls).toEqual([["thread-done", true], ["thread-done", false]]);
    expect(storage.get("thread-done")).toBe(false);
    expect(storage.get("tab-category")).toBe("sent");
    expectView(renderMail(), "sent", false);
  });

  it("shares both KBar status actions with Tabs/query state and preserves shortcuts", () => {
    storage.set("tab-category", "draft");
    renderMail();
    const statusActions = actions.mock.lastCall?.[0].filter(action => action.name.startsWith("View "));
    expect(statusActions?.map(({ name, shortcut }) => ({ name, shortcut }))).toEqual([
      { name: "View Active threads", shortcut: ["g", "p"] },
      { name: "View Done threads", shortcut: ["g", "f"] },
    ]);

    performAction("View Done threads");
    expect(storage.get("thread-done")).toBe(true);
    expectView(renderMail(), "draft", true);
    performAction("View Active threads");
    expect(storage.get("thread-done")).toBe(false);
    expectView(renderMail(), "draft", false);
    expect(writes.mock.calls).toEqual([["thread-done", true], ["thread-done", false]]);
    expect(storage.get("tab-category")).toBe("draft");
  });

  it.each([false, true])("keeps done=%s when KBar changes categories and updates the heading/query", done => {
    storage.set("thread-done", done);
    renderMail();
    const categoryActions = actions.mock.lastCall?.[0].filter(action => ["Inbox", "Sent", "Draft"].includes(action.name));
    expect(categoryActions?.map(({ name, shortcut }) => ({ name, shortcut }))).toEqual([
      { name: "Inbox", shortcut: ["g", "i"] },
      { name: "Sent", shortcut: ["g", "s"] },
      { name: "Draft", shortcut: ["g", "d"] },
    ]);
    for (const [name, category] of [["Sent", "sent"], ["Draft", "draft"], ["Inbox", "inbox"]] as const) {
      performAction(name);
      expect(storage.get("thread-done")).toBe(done);
      expect(storage.get("tab-category")).toBe(category);
      expectView(renderMail(), category, done);
    }
    expect(writes.mock.calls).toEqual([["tab-category", "sent"], ["tab-category", "draft"], ["tab-category", "inbox"]]);
  });
});
