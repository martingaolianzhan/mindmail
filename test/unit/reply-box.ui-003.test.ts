import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type EmailEditor from "~/app/mail/components/email-editor/email-editor";
import type { RouterInputs, RouterOutputs } from "~/trpc/react";

type Details = RouterOutputs["account"]["getReplyDetails"];
const { selected, editor, editorMount, mutate, getReplyDetails } = vi.hoisted(() => ({
  selected: { threadId: "A", accountId: "account-reply", threads: [{ id: "A" }] },
  editorMount: vi.fn(),
  editor: vi.fn<(props: ComponentProps<typeof EmailEditor>) => null>(() => null),
  mutate: vi.fn<(input: RouterInputs["account"]["sendEmail"]) => Promise<void>>(),
  getReplyDetails: vi.fn(),
}));
vi.mock("~/hooks/use-threads", () => ({ default: () => selected }));
vi.mock("~/trpc/react", () => ({ api: { account: {
  getReplyDetails: { useQuery: getReplyDetails },
  sendEmail: { useMutation: () => ({ mutateAsync: mutate, isPending: false }) },
} } }));
vi.mock("~/app/mail/components/email-editor/email-editor", () => ({ default: editor }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ReplyBox from "~/app/mail/components/reply-box/reply-box";

const addresses = (...values: string[]) => values.map(address => ({
  id: `address-${address}`, accountId: "account-reply", address, name: address, raw: null,
}));
const namedAddresses = (...entries: [string, string | null][]) => entries.map(([address, name]) => ({
  id: `address-${address}`, accountId: "account-reply", address, name, raw: null,
}));
const tags = (...values: string[]) => values.map(value => ({ value, label: value }));
const payloadRecipients = (...values: string[]) => values.map(address => ({ address, name: address }));
function details(overrides: Partial<Details> = {}): Details {
  return {
    reply: true, subject: "Thread A", internetMessageId: "<A1@example.test>",
    from: { name: "Account", address: "self@example.test" },
    to: addresses("alice@example.test", "bob@example.test"),
    cc: addresses("cc-old@example.test", "cc-keep@example.test"),
    ...overrides,
  };
}

let root: Root;
let currentDetails: Details;
function render(nextDetails = currentDetails) {
  currentDetails = nextDetails;
  getReplyDetails.mockReturnValue({ data: currentDetails });
  act(() => root.render(React.createElement(ReplyBox)));
}
function props() {
  const value = editor.mock.lastCall?.[0];
  if (!value) throw new Error("Reply editor was not rendered");
  return value;
}
function edit() {
  act(() => {
    props().setSubject("Edited A subject");
    props().setToValues(tags("bob@example.test", "carol@example.test"));
    props().setCCValues(tags("cc-keep@example.test", "cc-new@example.test"));
  });
}
function send() {
  act(() => { void props().handleSend("<p>Synthetic reply body</p>"); });
  return mutate.mock.lastCall?.[0];
}
function expectEditedContext() {
  expect(props().subject).toBe("Edited A subject");
  expect(props().toValues).toEqual(tags("bob@example.test", "carol@example.test"));
  expect(props().ccValues).toEqual(tags("cc-keep@example.test", "cc-new@example.test"));
  expect(props().to).toEqual(["bob@example.test", "carol@example.test"]);
  expect(send()).toEqual({
    accountId: "account-reply", threadId: "A", body: "<p>Synthetic reply body</p>",
    subject: "Edited A subject", inReplyTo: "<A1@example.test>",
    to: payloadRecipients("bob@example.test", "carol@example.test"),
    cc: payloadRecipients("cc-keep@example.test", "cc-new@example.test"),
  });
}

beforeEach(() => {
  selected.threadId = "A";
  selected.threads = [{ id: "A" }];
  currentDetails = details();
  mutate.mockResolvedValue(undefined);
  editor.mockImplementation(function EditorProbe() {
    React.useEffect(() => { editorMount(); }, []);
    return null;
  });
  // The mocked editor returns null, so ReactDOM needs only a root/event host,
  // not a DOM implementation. Real React state, effects and updates still run.
  // Keep this scaffolding local; no browser environment or hook emulation.
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

describe("UI-003 reply metadata lifecycle", () => {
  it("sends named initial recipients once with independent To and CC names", () => {
    render(details({
      to: namedAddresses(["shared@example.test", "To Alice"]),
      cc: namedAddresses(["shared@example.test", "CC Alice"]),
    }));
    expect(send()).toMatchObject({
      to: [{ address: "shared@example.test", name: "To Alice" }],
      cc: [{ address: "shared@example.test", name: "CC Alice" }],
    });
  });

  it("uses edited addresses with pinned names, never refreshed names or option labels", () => {
    render(details({
      to: namedAddresses(["alice@example.test", "Alice"], ["bob@example.test", "Bob Original"]),
      cc: namedAddresses(["cc-old@example.test", "Old CC"], ["cc-keep@example.test", "CC Original"]),
    }));
    edit();
    act(() => {
      props().setToValues(tags("bob@example.test", "carol@example.test").map(tag => ({ ...tag, label: "Rendered To label" })));
      props().setCCValues(tags("cc-keep@example.test", "cc-new@example.test").map(tag => ({ ...tag, label: "Rendered CC label" })));
    });
    const expected = {
      subject: "Edited A subject", inReplyTo: "<A1@example.test>",
      to: [{ address: "bob@example.test", name: "Bob Original" }, { address: "carol@example.test", name: "carol@example.test" }],
      cc: [{ address: "cc-keep@example.test", name: "CC Original" }, { address: "cc-new@example.test", name: "cc-new@example.test" }],
    };
    expect(send()).toMatchObject(expected);
    render(details({ internetMessageId: "<A2@example.test>",
      to: namedAddresses(["bob@example.test", "Bob Refreshed"], ["carol@example.test", "New incoming Carol"]),
      cc: namedAddresses(["cc-keep@example.test", "CC Refreshed"], ["cc-new@example.test", "New incoming CC"]),
    }));
    expect(send()).toMatchObject(expected);
    expect(props().to).toEqual(["bob@example.test", "carol@example.test"]);
  });

  it("replaces recipient names on thread selection without retaining A name metadata", () => {
    render(details({
      to: namedAddresses(["a-to@example.test", "A To"]),
      cc: namedAddresses(["a-cc@example.test", "A CC"]),
    }));
    selected.threadId = "B";
    render(details({ internetMessageId: "<B1@example.test>",
      to: namedAddresses(["b-to@example.test", "B To"]),
      cc: namedAddresses(["b-cc@example.test", "B CC"]),
    }));
    expect(send()).toMatchObject({ threadId: "B", inReplyTo: "<B1@example.test>",
      to: [{ address: "b-to@example.test", name: "B To" }],
      cc: [{ address: "b-cc@example.test", name: "B CC" }],
    });
    act(() => {
      props().setToValues(tags("b-to@example.test", "a-to@example.test"));
      props().setCCValues(tags("b-cc@example.test", "a-cc@example.test"));
    });
    expect(send()).toMatchObject({
      to: [{ address: "b-to@example.test", name: "B To" }, { address: "a-to@example.test", name: "a-to@example.test" }],
      cc: [{ address: "b-cc@example.test", name: "B CC" }, { address: "a-cc@example.test", name: "a-cc@example.test" }],
    });
  });

  it.each([null, "", "   "])("falls back to the address for unusable initial name %s", name => {
    render(details({
      to: namedAddresses(["to@example.test", name]),
      cc: namedAddresses(["cc@example.test", name]),
    }));
    expect(send()).toMatchObject({ to: payloadRecipients("to@example.test"), cc: payloadRecipients("cc@example.test") });
  });

  it.each([
    [true, "Thread A", "Re: Thread A"],
    [true, "Re: Existing subject", "Re: Existing subject"],
    [false, "Latest self-only subject", "Latest self-only subject"],
  ])("initializes reply=%s subject=%s and sends initial recipients once", (reply, subject, expected) => {
    render(details({ reply, subject }));
    expect(props().subject).toBe(expected);
    expect(props().toValues).toEqual(tags("alice@example.test", "bob@example.test"));
    expect(props().ccValues).toEqual(tags("cc-old@example.test", "cc-keep@example.test"));
    expect(send()).toMatchObject({
      subject: expected, inReplyTo: "<A1@example.test>",
      to: payloadRecipients("alice@example.test", "bob@example.test"),
      cc: payloadRecipients("cc-old@example.test", "cc-keep@example.test"),
    });
  });

  it.each([true, false])("uses only edited To/CC and summary for reply=%s", reply => {
    render(details({ reply }));
    edit();
    expectEditedContext();
  });

  it("preserves edits and A1 target when selected A receives newer A2 details", () => {
    render();
    edit();
    render(details({ subject: "New incoming A2", internetMessageId: "<A2@example.test>",
      to: addresses("a2-to@example.test"), cc: addresses("a2-cc@example.test") }));
    expectEditedContext();
  });

  it("preserves edits and target across a same-thread object-identity refresh", () => {
    render();
    edit();
    render({ ...currentDetails, to: [...currentDetails.to], cc: [...currentDetails.cc] });
    expectEditedContext();
  });

  it("ignores an unrelated new mailbox thread while A remains selected", () => {
    render();
    edit();
    selected.threads.push({ id: "B" });
    render();
    expectEditedContext();
  });

  it.each([
    [false, "B self-only", "B self-only"],
    [true, "Re: B prefixed", "Re: B prefixed"],
  ])("rebuilds metadata and target on selected A -> B (reply=%s)", (reply, subject, expected) => {
    render();
    edit();
    selected.threadId = "B";
    render(details({ reply, subject, internetMessageId: "<B1@example.test>",
      to: addresses("b-to@example.test"), cc: addresses("b-cc@example.test") }));
    expect(editorMount).toHaveBeenCalledOnce();
    expect(props().subject).toBe(expected);
    expect(props().toValues).toEqual(tags("b-to@example.test"));
    expect(props().ccValues).toEqual(tags("b-cc@example.test"));
    expect(props().to).toEqual(["b-to@example.test"]);
    expect(send()).toEqual({ accountId: "account-reply", threadId: "B", body: "<p>Synthetic reply body</p>",
      subject: expected, inReplyTo: "<B1@example.test>",
      to: payloadRecipients("b-to@example.test"), cc: payloadRecipients("b-cc@example.test") });
  });
});
