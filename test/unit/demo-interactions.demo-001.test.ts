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
  children?: ReactNode; "aria-label"?: string; "data-demo-thread"?: string; role?: string; id?: string;
  onClick?: () => void | Promise<void>; onChange?: (event: { target: { value: string } }) => void;
  [key: string]: unknown;
};
const { route, storage, writes, hosts, layout, provider, registry, view, body, editor, recipientFields } = vi.hoisted(() => ({
  route: { path: "/demo" }, storage: new Map<string, unknown>(), writes: vi.fn(),
  hosts: new Map<string, HostProps>(), layout: vi.fn<(props: MailLayoutProps) => void>(),
  provider: vi.fn(), registry: { actions: [] as Action[], hidden: true },
  view: { snapshot: false, mailbox: null as ReturnType<typeof DemoProviderModule.useDemoMailbox> | null, focused: "" },
  body: { text: "", html: "", editable: true },
  editor: { getHTML: vi.fn<() => string>(), getText: vi.fn<() => string>(),
    setEditable: vi.fn<(value: boolean) => void>(), commands: { clearContent: vi.fn() } },
  recipientFields: vi.fn<(props: { "aria-label": string; value: { value: string; label: string }[];
    onChange: (values: { value: string; label: string }[]) => void; options?: { value: string; label: ReactNode }[] }) => null>(() => null),
}));
vi.mock("~/trpc/react", async () => ({ api: { account: (await import("../helpers/demo-isolation")).forbiddenAccountApi } }));
vi.mock("~/lib/aurinko", async () => ({ getAurinkoAuthURL: () => import("../helpers/demo-isolation").then(({ forbiddenDemoCall }) => forbiddenDemoCall("OAuth")) }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));
vi.mock("usehooks-ts", () => ({ useLocalStorage: (key: string, initial: unknown) => [storage.has(key) ? storage.get(key) : initial,
  (value: unknown) => { writes(key, value); storage.set(key, value); }] }));
vi.mock("lucide-react", () => ({ File: () => null, Inbox: () => null, Send: () => null, Search: () => null }));
vi.mock("@tiptap/react", () => ({
  useEditor: function useTestEditor() {
    React.useEffect(() => { body.text = ""; body.html = ""; }, []);
    return editor;
  },
  EditorContent: () => null,
}));
vi.mock("~/app/mail/components/email-editor/editor-menubar", () => ({ default: () => null }));
vi.mock("react-select", () => ({ default: function RecipientBoundary(props: Parameters<typeof recipientFields>[0]) {
  if (!view.snapshot) recipientFields(props);
  return null;
} }));
vi.mock("~/components/ui/separator", () => ({ Separator: () => null }));
vi.mock("~/app/mail/components/thread-actions", () => ({ ThreadActions: () => null }));
vi.mock("~/app/mail/components/kbar/use-theme-switching", () => ({ default: () => undefined }));
vi.mock("kbar", async original => {
  const actual = await original<typeof KBarModule>();
  return { ...actual, KBarPortal: () => null, useKBar: () => ({ hidden: registry.hidden }),
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
  const wrappers = new Map<string, React.ElementType>();
  function wrap(factory: Factory): Factory {
    return (type, props, key) => {
      if (view.snapshot || typeof type !== "string") return factory(type, props, key);
      let Host = wrappers.get(type);
      if (!Host) {
        const tag = type;
        Host = React.forwardRef<HTMLElement, HostProps>(function HostBoundary(props, ref) {
          const button = tag === "button" && typeof props.children === "string" ? `button-${props.children}` : undefined;
          const id = String(props["aria-label"] ?? props["data-demo-thread"] ?? props.id ?? button ?? props.role ?? tag);
          hosts.set(id, props);
          React.useImperativeHandle(ref, () => ({ focus: () => { view.focused = id; },
            querySelector: () => ({ focus: () => { view.focused = "compose input"; } }),
            scrollIntoView: vi.fn() }) as unknown as HTMLElement, [id]);
          React.useEffect(() => () => { if (hosts.get(id) === props) hosts.delete(id); }, [id, props]);
          return React.Children.toArray(props.children).filter(React.isValidElement);
        });
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
import { demoThreads } from "~/demo/fixtures";

const fixtureJSON = JSON.stringify(demoThreads);

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
  act(() => { void handler(); });
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
  act(() => {
    for (const action of registry.actions) {
      if (action.shortcut?.join(" ") === shortcut.join(" ")) action.perform?.(action as never);
    }
  });
}
function mailbox() {
  if (!view.mailbox) throw new Error("Demo not mounted");
  return view.mailbox;
}
function recipients(label: "TO" | "CC", ...addresses: string[]) {
  const field = recipientFields.mock.calls.filter(([props]) => props["aria-label"] === label).at(-1)?.[0];
  if (!field) throw new Error(`Missing recipient field ${label}`);
  act(() => field.onChange(addresses.map(value => ({ value, label: value }))));
}
function recipientField(label: "TO" | "CC") {
  return recipientFields.mock.calls.filter(([props]) => props["aria-label"] === label).at(-1)?.[0];
}
function editBody(text: string) { body.text = text; body.html = `<p><strong>${text}</strong></p>`; }
function startSend() {
  const callback = control("button-Send").onClick;
  if (!callback) throw new Error("Missing send");
  let attempt: void | Promise<void>;
  act(() => { attempt = callback(); });
  return Promise.resolve(attempt!);
}
async function finishSend(attempt: Promise<void>) {
  await act(async () => { await vi.advanceTimersByTimeAsync(400); await attempt; });
}
function command(name: string) {
  const action = registry.actions.find(action => action.name === name);
  if (!action?.perform) throw new Error(`Missing Demo command ${name}`);
  act(() => { action.perform?.(action as never); });
}
function expectProductionUnchanged() {
  expect(Object.fromEntries(storage)).toEqual(productionState);
  expect(storage.get("accountId")).not.toMatch(/^demo-/);
  expect(store.get(threadIdAtom)).toBe("production-thread");
  expect(writes).not.toHaveBeenCalled();
  expect(forbiddenDemoCalls).toEqual([]);
  expect(JSON.stringify(demoThreads)).toBe(fixtureJSON);
}

beforeEach(() => {
  route.path = "/demo";
  storage.clear(); Object.entries(productionState).forEach(([key, value]) => storage.set(key, value));
  store.set(threadIdAtom, "production-thread");
  hosts.clear(); registry.actions = []; registry.hidden = true; forbiddenDemoCalls.length = 0;
  view.snapshot = false; view.mailbox = null; view.focused = "";
  vi.useFakeTimers();
  body.text = ""; body.html = ""; body.editable = true;
  editor.getHTML.mockImplementation(() => body.html);
  editor.getText.mockImplementation(() => body.text);
  editor.setEditable.mockImplementation(value => { body.editable = value; });
  editor.commands.clearContent.mockImplementation(() => { body.text = ""; body.html = ""; });
  recipientFields.mockReturnValue(null);
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
  vi.clearAllTimers(); vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DEMO-002 shared-editor workflows and isolated memory mutations", () => {
  it("composes through synthetic suggestions, prevents duplicates, clears on success, searches current data and resets on remount", async () => {
    renderDemo(); click("Compose in Demo");
    expect(recipientField("TO")?.options?.map(option => option.value)).toContain("mira@example.test");
    recipients("TO", "carol@example.test"); recipients("CC", "cc@example.test");
    change("subject", "Composed subject needle"); editBody("Composed body needle");
    const clickSend = control("button-Send").onClick!;
    let first: void | Promise<void>, duplicate: void | Promise<void>;
    act(() => { first = clickSend(); duplicate = clickSend(); });
    await duplicate!;
    expect(mailbox().state.threads).toHaveLength(14);
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    expect(body.editable).toBe(false);
    expect(control("button-Send").disabled).toBe(true);
    await finishSend(Promise.resolve(first!));
    expect(editor.commands.clearContent).toHaveBeenCalledOnce();
    expect(body.text).toBe(""); // Compose unmounts after success.
    expect(mailbox().state.threads).toHaveLength(15);
    const sent = mailbox().state.threads[0]!;
    expect(sent).toMatchObject({ accountId: "demo-avery", category: "sent", done: false, subject: "Composed subject needle" });
    expect(sent.messages[0]).toMatchObject({ from: "avery@example.test", body: "Composed body needle",
      to: [{ address: "carol@example.test", name: "carol@example.test" }], cc: [{ address: "cc@example.test", name: "cc@example.test" }] });
    expect(mailbox().notice).toEqual({ kind: "success", text: "Saved to Demo Sent · Simulated successfully. No real email was sent.",
      target: { accountId: "demo-avery", threadId: sent.id } });
    click("Sent demo category"); expect(subject()).toBe("Composed subject needle");
    const html = renderedDemo(); expect(html).toContain("Composed body needle"); expect(html).not.toContain("&lt;p&gt;");
    for (const query of ["Composed subject needle", "Composed body needle"]) {
      change("Search synthetic mailbox", query);
      expect(mailbox().visibleThreads.map(thread => thread.id)).toEqual([sent.id]);
    }
    change("Synthetic demo account", "demo-robin"); change("Search synthetic mailbox", "Composed body needle");
    expect(mailbox().visibleThreads).toEqual([]);
    change("Synthetic demo account", "demo-avery"); change("Search synthetic mailbox", "Composed body needle");
    expect(mailbox().visibleThreads.map(thread => thread.id)).toEqual([sent.id]);
    act(() => root.render(null)); renderDemo();
    expect(mailbox().state.threads).toEqual(demoThreads);
    expect(mailbox().composer).toBeNull();
    change("Search synthetic mailbox", "Composed body needle"); expect(mailbox().visibleThreads).toEqual([]);
  });

  it.each((["compose", "reply"] as const).flatMap(mode => [{ mode, addresses: [] as string[] }, { mode, addresses: ["  \t "] }]))("$mode rejects empty/blank To $addresses visibly, preserves body and releases pending for correction", async ({ mode, addresses }) => {
    renderDemo(); click(mode === "reply" ? "Reply in Demo" : "Compose in Demo"); recipients("TO", ...addresses);
    editBody("Preserved draft body");
    const callback = mailbox().sendMessage;
    await act(async () => {
      await expect(callback({ accountId: "demo-avery", to: addresses.map(address => ({ address })), cc: [], subject: "", body: body.text })).rejects.toThrow("Add a To recipient");
    });
    const invalidAttempt = startSend();
    await act(async () => { await invalidAttempt; });
    expect(mailbox().state.threads).toHaveLength(14);
    expect(mailbox().state.threads.flatMap(thread => thread.messages)).toHaveLength(18);
    expect(mailbox().notice?.kind).toBe("error");
    const html = renderedDemo();
    expect(html).toMatch(/role="alert"[^>]*><span>Add a To recipient to continue\.<\/span>/);
    expect(html).not.toContain("Demo only — no email was sent.");
    expect(body.text).toBe("Preserved draft body"); expect(body.editable).toBe(true);
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    expect(control("button-Send").disabled).toBe(false);
    recipients("TO", "fixed@example.test"); await finishSend(startSend());
    expect(mailbox().state.threads).toHaveLength(mode === "reply" ? 14 : 15);
    expect(mailbox().state.threads.flatMap(thread => thread.messages)).toHaveLength(19);
    expect(editor.commands.clearContent).toHaveBeenCalledOnce();
  });

  it("uses the latest external reply defaults, sends edited To/CC and appends searchable plain text to that conversation", async () => {
    renderDemo(); click("Reply in Demo");
    expect(recipientField("TO")?.value.map(value => value.value)).toEqual(["mira@example.test"]);
    expect(recipientField("CC")?.value.map(value => value.value)).toEqual(["sam@example.test"]);
    expect(control("subject").value).toBe("Re: Aurora launch plan");
    recipients("TO", "reply-to@example.test"); recipients("CC", "reply-cc@example.test");
    change("subject", "Re: Edited Aurora"); editBody("Reply body search needle");
    await finishSend(startSend());
    const conversation = mailbox().state.threads.find(thread => thread.id === "demo-avery-aurora")!;
    expect(conversation.messages).toHaveLength(4);
    expect(conversation.messages.at(-1)).toMatchObject({ from: "avery@example.test", body: "Reply body search needle",
      subject: "Re: Edited Aurora", inReplyTo: "demo-avery-aurora-3",
      to: [{ address: "reply-to@example.test", name: "reply-to@example.test" }],
      cc: [{ address: "reply-cc@example.test", name: "reply-cc@example.test" }] });
    expect(renderedDemo()).toContain("Reply body search needle");
    expect(mailbox().notice?.text).toBe("Reply added to demo thread. No real email was sent.");
    change("Search synthetic mailbox", "Reply body search needle");
    expect(mailbox().visibleThreads.map(thread => thread.id)).toEqual([conversation.id]);
    change("Synthetic demo account", "demo-robin"); change("Search synthetic mailbox", "Reply body search needle");
    expect(mailbox().visibleThreads).toEqual([]);
    change("Synthetic demo account", "demo-avery"); change("Search synthetic mailbox", "Reply body search needle");
    expect(mailbox().visibleThreads.map(thread => thread.id)).toEqual([conversation.id]);
  });

  it("preserves an existing Re: prefix and trusted names for retained default recipients", async () => {
    renderDemo();
    // Variant input lives only in this provider-owned clone, never imported fixtures.
    const conversation = mailbox().state.threads.find(thread => thread.id === "demo-avery-aurora")!;
    conversation.subject = "Re: Aurora launch plan";
    click("Reply in Demo");
    expect(control("subject").value).toBe("Re: Aurora launch plan");
    editBody("Retained recipients"); await finishSend(startSend());
    expect(mailbox().state.threads.find(thread => thread.id === conversation.id)?.messages.at(-1)).toMatchObject({
      to: [{ address: "mira@example.test", name: "Mira Chen" }],
      cc: [{ address: "sam@example.test", name: "Sam Rivera" }],
    });
  });

  it("keeps a delayed Compose snapshot in A even after field edits and navigation to B", async () => {
    renderDemo(); click("Compose in Demo");
    recipients("TO", "original@example.test"); recipients("CC", "original-cc@example.test");
    change("subject", "Snapshot A subject"); editBody("Snapshot A body");
    const attempt = startSend();
    expect(mailbox().sending).toBe(true);
    change("subject", "Later subject"); recipients("TO", "later@example.test"); recipients("CC", "later-cc@example.test");
    change("Synthetic demo account", "demo-robin"); click("Draft demo category"); status(true);
    await finishSend(attempt);
    expect(mailbox().state).toMatchObject({ accountId: "demo-robin", category: "draft", done: true });
    expect(subject()).toBe("Draft: exhibition invitation");
    expect(mailbox().state.threads[0]).toMatchObject({ accountId: "demo-avery", subject: "Snapshot A subject",
      messages: [expect.objectContaining({ from: "avery@example.test", body: "Snapshot A body",
        to: [{ address: "original@example.test", name: "original@example.test" }],
        cc: [{ address: "original-cc@example.test", name: "original-cc@example.test" }] })] });
    expect(mailbox().state.threads.filter(thread => thread.accountId === "demo-robin")).toHaveLength(7);
  });

  it.each([false, true])("keeps a delayed Reply pinned while switching thread/account (account switch=%s)", async switchAccount => {
    renderDemo(); click("Reply in Demo"); recipients("TO", "pinned@example.test"); editBody("Pinned reply body");
    const attempt = startSend();
    click("demo-avery-ceramics");
    if (switchAccount) change("Synthetic demo account", "demo-robin");
    const selected = mailbox().selectedThread?.id;
    await finishSend(attempt);
    expect(mailbox().selectedThread?.id).toBe(selected);
    expect(mailbox().state.accountId).toBe(switchAccount ? "demo-robin" : "demo-avery");
    const threads = mailbox().state.threads;
    expect(threads.find(thread => thread.id === "demo-avery-aurora")?.messages.at(-1)).toMatchObject({ body: "Pinned reply body", inReplyTo: "demo-avery-aurora-3" });
    expect(threads.find(thread => thread.id === "demo-avery-ceramics")?.messages).toHaveLength(1);
    expect(threads.find(thread => thread.id === "demo-robin-aurora")?.messages).toHaveLength(3);
  });

  it("registers only Demo commands and focuses local Search after palette close/focus restoration", () => {
    renderDemo();
    expect(registry.actions).toHaveLength(7);
    expect(registry.actions.every(action => action.id.startsWith("demo-"))).toBe(true);
    expect(registry.actions.map(action => action.name)).not.toEqual(expect.arrayContaining(["Archive", "Delete", "Snooze", "Mute"]));
    command("Sent"); expect(mailbox().state.category).toBe("sent");
    command("Draft"); expect(mailbox().state.category).toBe("draft");
    command("View Done threads"); expect(mailbox().state.done).toBe(true);
    command("View Active threads"); expect(mailbox().state.done).toBe(false);
    command("Inbox"); expect(mailbox().state.category).toBe("inbox");
    command("Compose"); expect(mailbox().composer?.accountId).toBe("demo-avery");
    registry.hidden = false;
    command("Search mailbox");
    expect(view.focused).toBe("compose input"); // Do not race KBar's close-time focus restoration.
    registry.hidden = true; renderDemo();
    expect(view.focused).toBe("Search synthetic mailbox");
    expectProductionUnchanged();
  });

  it("does not expose Reply on self-only Sent conversations", () => {
    renderDemo(); click("Sent demo category");
    expect(renderedDemo()).not.toContain('aria-label="Reply in Demo"');
  });
});

describe("DEMO-003 portfolio interactions", () => {
  it("renders a compact disclosed header and a separate non-modal, keyboard-accessible Compose", () => {
    renderDemo();
    const initial = renderedDemo();
    expect(initial).toContain("MindMail · Interactive Demo");
    expect(initial).toContain("Synthetic data · No real emails sent · Resets on refresh");
    expect(initial).toContain("⌘K / Ctrl+K for commands");
    expect(initial).not.toContain("All accounts/messages are fictional");
    expect(initial).toContain('aria-label="Compose in Demo"');
    click("Compose in Demo");
    expect(view.focused).toBe("compose input");
    const open = renderedDemo();
    expect(open).toMatch(/aria-label="Demo reading pane"[\s\S]*<\/div><\/div><div class="fixed inset-x-2 bottom-2/);
    expect(open).toContain('role="region"');
    expect(open).toContain('aria-label="Floating Demo compose"');
    expect(open).not.toContain("fixed inset-0 z-50 bg-black");
    click("demo-avery-ceramics"); click("Sent demo category");
    expect(mailbox().composer?.accountId).toBe("demo-avery");
    click("button-Close draft");
    expect(mailbox().composer).toBeNull();
    expect(view.focused).toBe("Compose in Demo");
    expect(mailbox().state.threads).toHaveLength(14);
    click("Compose in Demo");
    expect(control("subject").value).toBe("");
  });

  it("preserves the exact success target and atomically opens Sent/Active across account, search and Done", async () => {
    renderDemo(); click("Compose in Demo"); recipients("TO", "target@example.test");
    change("subject", "Exact portfolio target"); editBody("Exact portfolio message");
    await finishSend(startSend());
    const sent = mailbox().state.threads[0]!;
    expect(mailbox().state.threads.filter(thread => thread.id === sent.id)).toHaveLength(1);
    expect(mailbox().composer).toBeNull();
    expect(renderedDemo()).toContain("Saved to Demo Sent");
    expect(control("button-View in Sent").children).toBe("View in Sent");
    click("Draft demo category"); status(true);
    change("Synthetic demo account", "demo-robin");
    change("Search synthetic mailbox", "aurora");
    expect(mailbox().state).toMatchObject({ accountId: "demo-robin", category: "inbox", done: false, query: "aurora" });
    // Re-establish Done and a different category before searching, on the other account.
    click("Draft demo category"); status(true); change("Search synthetic mailbox", "aurora");
    click("button-View in Sent");
    expect(mailbox().state).toMatchObject({ accountId: "demo-avery", category: "sent", done: false, query: "", threadId: sent.id });
    expect(mailbox().selectedThread?.id).toBe(sent.id);
    expect(renderedDemo()).toContain("Exact portfolio message");
    expect(mailbox().notice?.target?.threadId).toBe(sent.id);
  });

  it("keeps Compose open and locked while pending; completion does not steal navigation, explicit action does", async () => {
    renderDemo(); click("Compose in Demo"); recipients("TO", "a@example.test"); editBody("Pending source A");
    const attempt = startSend();
    expect(control("button-Close draft").disabled).toBe(true);
    click("button-Close draft");
    expect(mailbox().composer).not.toBeNull();
    change("Synthetic demo account", "demo-robin"); click("Draft demo category"); status(true);
    await finishSend(attempt);
    expect(mailbox().state).toMatchObject({ accountId: "demo-robin", category: "draft", done: true });
    expect(mailbox().composer).toBeNull();
    expect(mailbox().notice?.target?.accountId).toBe("demo-avery");
    click("button-View in Sent");
    expect(mailbox().selectedThread?.messages[0]?.body).toBe("Pending source A");
  });

  it("pins a pending inline Reply to its original thread without dismissing or redirecting", async () => {
    renderDemo(); click("Reply in Demo"); editBody("Pinned portfolio reply");
    const attempt = startSend();
    expect(control("button-Close draft").disabled).toBe(true);
    click("button-Close draft"); expect(mailbox().composer?.threadId).toBe("demo-avery-aurora");
    click("demo-avery-ceramics"); change("Synthetic demo account", "demo-robin");
    await finishSend(attempt);
    expect(mailbox().state.accountId).toBe("demo-robin");
    expect(mailbox().composer).toBeNull();
    expect(mailbox().state.threads.find(thread => thread.id === "demo-avery-aurora")?.messages.at(-1)?.body).toBe("Pinned portfolio reply");
    expect(mailbox().state.threads.find(thread => thread.id === "demo-avery-ceramics")?.messages).toHaveLength(1);
    expect(mailbox().notice?.text).toContain("Reply added");
  });

  it("retains invalid Compose, retries, then closes inline Reply and resets both mutations on remount", async () => {
    renderDemo(); click("Compose in Demo"); recipients("TO", "bad-address");
    change("subject", "Retry subject"); editBody("Retry body");
    await act(async () => { await startSend(); });
    expect(mailbox().notice?.kind).toBe("error");
    expect(mailbox().composer).not.toBeNull();
    expect(control("subject").value).toBe("Retry subject");
    expect(body.text).toBe("Retry body");
    expect(mailbox().state.threads).toHaveLength(14);
    recipients("TO", "valid@example.test"); await finishSend(startSend());
    expect(mailbox().composer).toBeNull();
    click("button-View in Sent");
    change("Search synthetic mailbox", "Retry body");
    expect(mailbox().visibleThreads).toHaveLength(1);
    click("Inbox demo category"); click("demo-avery-aurora"); click("Reply in Demo");
    expect(renderedDemo()).toContain('aria-label="Demo reply editor"');
    expect(renderedDemo()).not.toContain('aria-label="Floating Demo compose"');
    editBody("Appended reply needle"); await finishSend(startSend());
    expect(mailbox().composer).toBeNull();
    expect(mailbox().notice?.text).toContain("Reply added");
    expect(mailbox().selectedThread?.messages).toHaveLength(4);
    expect(renderedDemo()).toContain("Appended reply needle");
    change("Search synthetic mailbox", "Appended reply needle"); expect(mailbox().visibleThreads).toHaveLength(1);
    act(() => root.render(null)); renderDemo();
    expect(mailbox().state.threads).toEqual(demoThreads);
    expect(mailbox().notice).toBeNull();
    change("Search synthetic mailbox", "Appended reply needle"); expect(mailbox().visibleThreads).toHaveLength(0);
  });
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
    expect(provider.mock.calls.every(([actions]) => (actions as Action[]).every(action => action.id.startsWith("demo-")))).toBe(true);
    expect(registry.actions).toHaveLength(7);
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
    expect(provider.mock.calls.every(([actions]) => (actions as Action[]).every(action => action.id.startsWith("demo-")))).toBe(true);
    expect(registry.actions).toHaveLength(7);
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
