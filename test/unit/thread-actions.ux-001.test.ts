import { createElement, forwardRef, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type * as ButtonModule from "~/components/ui/button";

const { selection, buttons } = vi.hoisted(() => ({
  selection: { threadId: "synthetic-thread" as string | null },
  buttons: vi.fn<(props: ComponentProps<typeof ButtonModule.Button>) => void>(),
}));
const thread = {
  id: "synthetic-thread",
  emails: [{ id: "synthetic-email", subject: "Selected synthetic thread",
    from: { name: "Synthetic Sender", address: "sender@example.test" },
    sentAt: new Date("2026-01-01T00:00:00Z") }],
};
vi.mock("~/hooks/use-threads", () => ({ default: () => ({ threadId: selection.threadId, threads: [thread] }) }));
vi.mock("~/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof ButtonModule>();
  return { ...actual, Button: forwardRef<HTMLButtonElement, ComponentProps<typeof actual.Button>>(
    function ObservedButton(props, ref) {
      buttons(props);
      return createElement(actual.Button, { ...props, ref });
    },
  ) };
});
vi.mock("~/app/mail/components/email-search/search-bar", async () => ({
  isSearchingAtom: (await import("jotai")).atom(false),
}));
vi.mock("~/app/mail/components/email-search/search-display", () => ({ default: () => null }));
vi.mock("~/app/mail/components/email-display", () => ({ default: () => null }));
vi.mock("~/app/mail/components/reply-box/reply-box", () => ({ default: () => null }));

import ThreadDisplay from "~/app/mail/components/thread-display";

describe("UX-001 unavailable thread actions", () => {
  it.each([true, false])("keeps mutation controls unavailable with selected=%s", selected => {
    selection.threadId = selected ? thread.id : null;
    // Real ThreadDisplay, Button and Radix menu; only data and unrelated leaves
    // are isolated. In particular, a selected thread really matches the fixture.
    const html = renderToString(createElement(ThreadDisplay));
    if (selected) expect(html).toContain("Selected synthetic thread");
    else expect(html).toContain("No message selected.");

    expect(buttons.mock.calls).toHaveLength(5);
    for (const [props] of buttons.mock.calls) {
      expect(props.disabled).toBe(true);
      expect(props.onClick).toBeUndefined();
      expect(props.onSelect).toBeUndefined();
      // More receives Radix's own guarded menu-navigation handlers, not a mail
      // mutation. The four standalone actions have no executable handlers.
      if (props["aria-label"] !== "More actions (unavailable)") {
        expect(props.onPointerDown).toBeUndefined();
        expect(props.onKeyDown).toBeUndefined();
      }
    }

    const rendered = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1] ?? "");
    expect(rendered).toHaveLength(5);
    expect(rendered.map(attributes => /aria-label="([^"]*)"/.exec(attributes)?.[1])).toEqual([
      "Archive (unavailable)", "ArchiveX (unavailable)", "Delete (unavailable)",
      "Snooze (unavailable)", "More actions (unavailable)",
    ]);
    for (const attributes of rendered) {
      expect(attributes).toContain('disabled=""');
      expect(attributes).toContain("disabled:opacity-50");
      expect(attributes).toContain("disabled:pointer-events-none");
    }
    const more = rendered[4];
    expect(more).toContain('data-disabled=""');
    expect(more).toContain('aria-haspopup="menu"');
    expect(more).toContain('aria-expanded="false"');
  });
});
