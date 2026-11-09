import React, { act, type ComponentProps, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EditorModule from "~/app/mail/components/email-editor/email-editor";
import type { RouterInputs } from "~/trpc/react";

type EditorProps = ComponentProps<typeof EditorModule.default>;
type SendButtonProps = PropsWithChildren<{ disabled?: boolean; onClick?: () => Promise<void> }>;
type HostProps = PropsWithChildren<{ disabled?: boolean }>;
const { body, editor, button, menu, editorProps, hostProps, send, mutateAsync, mutation, selected, success, error } = vi.hoisted(() => ({
  body: { html: "<p>Synthetic draft</p>", editable: true },
  editor: { getHTML: vi.fn<() => string>(), setEditable: vi.fn<(editable: boolean) => void>(), commands: { clearContent: vi.fn() } },
  button: vi.fn<(props: SendButtonProps) => null>(() => null),
  menu: vi.fn(() => null),
  editorProps: vi.fn<(props: EditorProps) => void>(),
  hostProps: new Map<string, HostProps>(),
  send: vi.fn<(body: string) => Promise<void>>(),
  mutateAsync: vi.fn<(input: RouterInputs["account"]["sendEmail"]) => Promise<void>>(),
  mutation: { isPending: false },
  selected: { accountId: "account-send", threadId: "thread-send" as string | null,
    account: undefined as { id: string; name: string; emailAddress: string } | undefined },
  success: vi.fn(), error: vi.fn(),
}));

// Real React state/effects run on the existing null-root host. Intrinsic wrappers
// retain element children and fieldset props, but don't need browser DOM nodes.
vi.mock("react/jsx-runtime", async (importOriginal) => {
  type Factory = (type: React.ElementType, props: Record<string, unknown>, key?: string) => React.ReactElement;
  const actual = await importOriginal<{ jsx: Factory; jsxs: Factory }>();
  const hosts = new Map<string, React.FunctionComponent<HostProps>>();
  function wrap(factory: Factory): Factory {
    return (type, props, key) => {
      if (typeof type !== "string") return factory(type, props, key);
      let Host = hosts.get(type);
      if (!Host) {
        const tag = type;
        Host = function HostElement(props: HostProps) {
          hostProps.set(tag, props);
          return React.Children.toArray(props.children).filter(React.isValidElement);
        };
        hosts.set(type, Host);
      }
      return factory(Host, props, key);
    };
  }
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async () => {
  // Vite's development JSX uses the same null-host adapter as production JSX.
  const runtime = await import("react/jsx-runtime") as unknown as {
    jsx: (type: React.ElementType, props: Record<string, unknown>, key?: string) => React.ReactElement;
    jsxs: (type: React.ElementType, props: Record<string, unknown>, key?: string) => React.ReactElement;
    Fragment: typeof React.Fragment;
  };
  return { Fragment: runtime.Fragment,
    jsxDEV: (type: React.ElementType, props: Record<string, unknown>, key: string | undefined, staticChildren: boolean) =>
      (staticChildren ? runtime.jsxs : runtime.jsx)(type, props, key),
  };
});
vi.mock("@tiptap/react", () => ({ useEditor: () => editor, EditorContent: () => null }));
vi.mock("~/components/ui/button", () => ({ Button: button }));
vi.mock("~/components/ui/input", () => ({ Input: () => null }));
vi.mock("~/components/ui/separator", () => ({ Separator: () => null }));
vi.mock("~/app/mail/components/email-editor/tag-input", () => ({ default: () => null }));
vi.mock("~/app/mail/components/email-editor/editor-menubar", () => ({ default: menu }));
vi.mock("~/components/ui/drawer", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => React.Children.toArray(children).filter(React.isValidElement);
  return { Drawer: passthrough, DrawerTrigger: passthrough, DrawerContent: passthrough,
    DrawerHeader: passthrough, DrawerTitle: passthrough };
});
vi.mock("~/hooks/use-threads", () => ({ default: () => selected }));
vi.mock("sonner", () => ({ toast: { success, error } }));
vi.mock("~/trpc/react", () => ({ api: { account: {
  sendEmail: { useMutation: () => ({ mutateAsync, isPending: mutation.isPending }) },
  getReplyDetails: { useQuery: () => ({ data: {
    subject: "Synthetic reply", reply: true, internetMessageId: "<target@example.test>",
    to: [{ address: "to@example.test", name: "Recipient" }], cc: [],
  } }) },
} } }));
vi.mock("~/app/mail/components/email-editor/email-editor", async (importOriginal) => {
  const { default: ActualEditor } = await importOriginal<typeof EditorModule>();
  return { default: function EditorProbe(props: EditorProps) {
    editorProps(props);
    return React.createElement(ActualEditor, props);
  } };
});

import EmailEditor from "~/app/mail/components/email-editor/email-editor";
import ComposeButton from "~/app/mail/components/compose-button";
import ReplyBox from "~/app/mail/components/reply-box/reply-box";

let root: Root;
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function renderEditor(isSending = false) {
  act(() => root.render(React.createElement(EmailEditor, {
    subject: "Subject", setSubject: vi.fn(), toValues: [], setToValues: vi.fn(),
    ccValues: [], setCCValues: vi.fn(), to: [], defaultToolBarExpanded: false,
    handleSend: send, isSending,
  })));
}
function renderCaller(kind: "compose" | "reply") {
  act(() => root.render(React.createElement(kind === "compose" ? ComposeButton : ReplyBox)));
}
function sendButton() {
  const props = button.mock.calls.filter(([props]) => props.children === "Send").at(-1)?.[0];
  if (!props?.onClick) throw new Error("Send button unavailable");
  return props as SendButtonProps & { onClick: () => Promise<void> };
}
function callerSend() {
  const callback = editorProps.mock.lastCall?.[0].handleSend;
  if (!callback) throw new Error("Caller send callback unavailable");
  return callback;
}
function expectLocked(locked: boolean) {
  expect(sendButton().disabled).toBe(locked);
  expect(body.editable).toBe(!locked);
  expect(hostProps.get("fieldset")?.disabled).toBe(locked);
  // Native fieldset disabling covers the existing toolbar's buttons.
  const toolbar = hostProps.get("fieldset")?.children;
  expect(React.isValidElement(toolbar) && toolbar.type).toBe(menu);
}

beforeEach(() => {
  body.html = "<p>Synthetic draft</p>";
  body.editable = true;
  mutation.isPending = false;
  selected.accountId = "account-send";
  selected.threadId = "thread-send";
  selected.account = { id: "account-send", name: "Synthetic", emailAddress: "self@example.test" };
  hostProps.clear();
  editor.getHTML.mockImplementation(() => body.html);
  editor.setEditable.mockImplementation(editable => { body.editable = editable; });
  editor.commands.clearContent.mockImplementation(() => { body.html = ""; });
  button.mockReturnValue(null);
  menu.mockReturnValue(null);
  send.mockResolvedValue(undefined);
  mutateAsync.mockResolvedValue(undefined);
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
  vi.unstubAllGlobals();
});

describe("UI-004 body send lifecycle", () => {
  it("locks synchronously, ignores rapid duplicates, and clears only after successful completion", async () => {
    const pending = deferred();
    send.mockReturnValue(pending.promise);
    renderEditor();
    const click = sendButton().onClick;
    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = click();
      expect(body.editable).toBe(false); // before any pending rerender
      duplicate = click();
    });
    await duplicate;
    expect(send).toHaveBeenCalledExactlyOnceWith("<p>Synthetic draft</p>");
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    expect(body.html).toBe("<p>Synthetic draft</p>");
    expectLocked(true);
    await act(async () => { pending.resolve(); await first; });
    expect(editor.commands.clearContent).toHaveBeenCalledOnce();
    expect(body.html).toBe("");
    expectLocked(false);

    body.html = "<p>Later draft</p>";
    send.mockResolvedValue(undefined);
    await act(async () => { await sendButton().onClick(); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("<p>Later draft</p>");
    expect(editor.commands.clearContent).toHaveBeenCalledTimes(2);
  });

  it("preserves failure drafts, releases the lock and allows a user-initiated retry only", async () => {
    const pending = deferred();
    send.mockReturnValue(pending.promise);
    renderEditor();
    let attempt!: Promise<void>;
    act(() => { attempt = sendButton().onClick(); });
    await act(async () => { pending.reject(new Error("Synthetic failure")); await attempt; });
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    expect(body.html).toBe("<p>Synthetic draft</p>");
    expect(send).toHaveBeenCalledOnce();
    expectLocked(false);
    send.mockResolvedValue(undefined);
    await act(async () => { await sendButton().onClick(); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(editor.commands.clearContent).toHaveBeenCalledOnce();
  });

  it("blocks sending and body/toolbar editing for caller-provided pending state", async () => {
    renderEditor(true);
    expectLocked(true);
    await act(async () => { await sendButton().onClick(); });
    expect(send).not.toHaveBeenCalled();
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    renderEditor(false);
    expectLocked(false);
  });

  it("does not unlock while the latest caller state remains pending after local completion", async () => {
    const pending = deferred();
    send.mockReturnValue(pending.promise);
    renderEditor();
    let attempt!: Promise<void>;
    act(() => { attempt = sendButton().onClick(); });
    renderEditor(true);
    await act(async () => { pending.resolve(); await attempt; });
    expectLocked(true);
    await act(async () => { await sendButton().onClick(); });
    expect(send).toHaveBeenCalledOnce();
    renderEditor(false);
    expectLocked(false);
  });

  it("restores editability even when an immediately resolved send is batched", async () => {
    renderEditor();
    await act(async () => { await sendButton().onClick(); });
    expect(editor.commands.clearContent).toHaveBeenCalledOnce();
    expectLocked(false);
  });

  it("rejects missing compose Account without sending or clearing the body", async () => {
    selected.account = undefined;
    renderCaller("compose");
    await expect(callerSend()(body.html)).rejects.toThrow("Unable to send email.");
    await act(async () => { await sendButton().onClick(); });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Error sending email");
    expect(success).not.toHaveBeenCalled();
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    expect(body.html).toBe("<p>Synthetic draft</p>");
    expectLocked(false);
  });

  it.each(["compose", "reply"] as const)("%s awaits the actual mutation before reporting success", async kind => {
    const pending = deferred();
    mutateAsync.mockReturnValue(pending.promise);
    renderCaller(kind);
    const resolved = vi.fn();
    const promise = callerSend()(body.html);
    void promise.then(resolved);
    await Promise.resolve();
    expect(mutateAsync).toHaveBeenCalledOnce();
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-send", body: "<p>Synthetic draft</p>" }));
    expect(resolved).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    pending.resolve();
    await promise;
    expect(resolved).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledWith("Email sent");
    expect(error).not.toHaveBeenCalled();
  });

  it.each(["compose", "reply"] as const)("%s propagates mutation rejection with generic feedback", async kind => {
    const pending = deferred();
    mutateAsync.mockReturnValue(pending.promise);
    renderCaller(kind);
    const failure = new Error("Synthetic provider failure");
    const promise = callerSend()(body.html);
    const rejection = expect(promise).rejects.toBe(failure);
    pending.reject(failure);
    await rejection;
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith("Error sending email");
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    expect(body.html).toBe("<p>Synthetic draft</p>");
    expect(mutateAsync).toHaveBeenCalledOnce();
  });

  it.each(["account", "thread"] as const)("rejects missing reply %s context and preserves the body", async missing => {
    if (missing === "account") selected.accountId = "";
    else selected.threadId = null;
    renderCaller("reply");
    await expect(callerSend()(body.html)).rejects.toThrow("Unable to send email.");
    await act(async () => { await sendButton().onClick(); });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(editor.commands.clearContent).not.toHaveBeenCalled();
    expect(body.html).toBe("<p>Synthetic draft</p>");
    expect(error).toHaveBeenCalledWith("Error sending email");
    expectLocked(false);
  });
});
