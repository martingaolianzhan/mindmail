import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Nav } from "~/app/mail/components/nav";

const { getNumThreads, nav } = vi.hoisted(() => ({
  getNumThreads: vi.fn(),
  nav: vi.fn<(props: ComponentProps<typeof Nav>) => null>(() => null),
}));

vi.mock("~/trpc/react", () => ({
  api: { account: { getNumThreads: { useQuery: getNumThreads } } },
}));
vi.mock("usehooks-ts", () => ({
  useLocalStorage: (key: string) => [key === "accountId" ? "account-sidebar" : "inbox"],
}));
// Inspect the real Sidebar's presentation contract without mounting the mail page.
vi.mock("~/app/mail/components/nav", () => ({ Nav: nav }));

import Sidebar from "~/app/mail/components/sidebar";

describe("UI-001 sidebar category counts", () => {
  it("queries each category independently and labels the matching navigation entry", () => {
    const counts = { inbox: 11, draft: 22, sent: 33 };
    getNumThreads.mockImplementation(({ tabCategory }: { tabCategory: keyof typeof counts }) => ({
      data: counts[tabCategory],
    }));

    renderToString(createElement(Sidebar, { isCollapsed: false }));

    expect(getNumThreads.mock.calls).toEqual([
      [{ accountId: "account-sidebar", tabCategory: "inbox" }],
      [{ accountId: "account-sidebar", tabCategory: "draft" }],
      [{ accountId: "account-sidebar", tabCategory: "sent" }],
    ]);
    expect(nav).toHaveBeenCalledOnce();
    expect(nav.mock.calls[0]?.[0].links.map(({ title, label }) => ({ title, label }))).toEqual([
      { title: "Inbox", label: "11" },
      { title: "Draft", label: "22" },
      { title: "Sent", label: "33" },
    ]);
  });
});
