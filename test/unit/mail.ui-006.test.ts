import { createElement, type PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ done: false }));
vi.mock("usehooks-ts", () => ({
  useLocalStorage: (key: string, initial: unknown) => [key === "thread-done" ? state.done : initial, vi.fn()],
}));
// Same narrow layout/leaf boundaries as UI-002; Mail and Radix Tabs stay real.
vi.mock("~/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: PropsWithChildren) => children,
  ResizablePanel: ({ children }: PropsWithChildren) => children,
  ResizableHandle: () => null,
}));
vi.mock("~/app/mail/components/account-switcher", () => ({ default: () => null }));
vi.mock("~/app/mail/components/sidebar", () => ({ default: () => null }));
vi.mock("~/app/mail/components/thread-list", () => ({ default: () => null }));
vi.mock("~/app/mail/components/thread-display", () => ({ default: () => null }));
vi.mock("~/app/mail/components/email-search/search-bar", () => ({ default: () => null }));

import Mail from "~/app/mail/mail";

describe("UI-006 rendered status-tab classes", () => {
  it.each([false, true])("preserves Active/Done triggers and values with done=%s", done => {
    state.done = done;
    const html = renderToString(createElement(Mail, {
      defaultLayout: undefined, navCollapseSize: 4, defaultCollapsed: false,
    }));
    const triggers = [...html.matchAll(/<button\b([^>]*)>(Active|Done)<\/button>/g)];
    expect(triggers.map(match => match[2])).toEqual(["Active", "Done"]);
    for (const [, attributes = "", label] of triggers) {
      const classes = /\bclass="([^"]*)"/.exec(attributes)?.[1]?.split(/\s+/);
      expect(classes).toContain("text-zinc-600");
      expect(classes).not.toContain("text-xinc-600");
      expect(classes).toContain("dark:text-zinc-200");
      const value = label === "Active" ? "active" : "done";
      expect(attributes).toContain('role="tab"');
      // Radix derives trigger/content IDs from the actual value prop.
      expect(attributes).toMatch(new RegExp(`\\bid="[^"]*-trigger-${value}"`));
      expect(attributes).toMatch(new RegExp(`aria-controls="[^"]*-content-${value}"`));
      expect(attributes).toContain(`aria-selected="${done === (value === "done")}"`);
    }
  });
});
