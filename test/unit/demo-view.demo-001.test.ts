import { createElement, type PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenDemoCalls, forbiddenAccountApi } from "../helpers/demo-isolation";

vi.mock("~/trpc/react", async () => ({ api: { account: (await import("../helpers/demo-isolation")).forbiddenAccountApi } }));
vi.mock("~/lib/aurinko", async () => ({ getAurinkoAuthURL: () => import("../helpers/demo-isolation").then(({ forbiddenDemoCall }) => forbiddenDemoCall("OAuth")) }));
vi.mock("@clerk/nextjs", async () => new Proxy({}, { get: () => { throw new Error("Demo must not use Clerk identity UI"); } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/demo" }));
vi.mock("usehooks-ts", () => ({ useLocalStorage: () => { throw new Error("Demo must not use production storage hooks"); } }));
vi.mock("~/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: PropsWithChildren) => children,
  ResizablePanel: ({ children }: PropsWithChildren) => children,
  ResizableHandle: () => null,
}));

import DemoPage from "~/app/demo/[[...path]]/page";
import KBar from "~/app/mail/components/kbar";
import { demoAccounts, demoThreads, searchDemoThreads } from "~/demo/fixtures";

beforeEach(() => { forbiddenDemoCalls.length = 0; });
afterEach(() => { expect(forbiddenDemoCalls).toEqual([]); });

describe("DEMO-001 synthetic presentation and hard API isolation", () => {
  it("renders real shared Mail layout/toolbar and useful synthetic reading content anonymously", () => {
    const html = renderToString(createElement(KBar, null, createElement(DemoPage)));
    expect(html).toContain("Synthetic portfolio demo");
    expect(html).toContain("avery@example.test");
    expect(html).toContain("Aurora launch plan");
    expect(html).toContain("Saturday ceramics workshop");
    expect(html).toContain("Thursday&#x27;s design review");
    expect(html).toMatch(/data-state="active"[^>]*>Active<\/button>/);
    for (const label of ["Archive", "ArchiveX", "Delete", "Snooze", "More actions"]) {
      const button = [...html.matchAll(/<button\b([^>]*)>/g)].find(match => match[1]?.includes(`aria-label="${label} (unavailable)"`));
      expect(button?.[1]).toContain('disabled=""');
    }
    expect(html).not.toMatch(/AI Smart Compose|Cmd \+ J|>Send<\/button>|>Compose<\/button>|>Reply<\/button>|>Add account</);
    expect(html).toContain("Read-only: composing and replying are not available here");
  });

  it("provides all six category/status combinations for both fictional accounts", () => {
    expect(demoAccounts).toHaveLength(2);
    expect(demoThreads).toHaveLength(14);
    for (const account of demoAccounts) {
      expect(account.address).toMatch(/@example\.test$/);
      for (const category of ["inbox", "sent", "draft"] as const) {
        for (const done of [false, true]) {
          expect(demoThreads.some(thread => thread.accountId === account.id && thread.category === category && thread.done === done)).toBe(true);
        }
      }
    }
    expect(demoThreads.some(thread => thread.messages.length >= 3)).toBe(true);
    expect(new Set(demoThreads.flatMap(thread => thread.messages.map(message => message.from))).size).toBeGreaterThan(3);
    expect(JSON.stringify(demoThreads)).not.toMatch(/accessToken|userId/);
  });

  it("searches only local synthetic content with known and unmatched terms", () => {
    expect(searchDemoThreads("demo-avery", "  AURORA  ").map(thread => thread.id)).toEqual(["demo-avery-aurora"]);
    expect(searchDemoThreads("demo-avery", "nonexistent-needle")).toEqual([]);
    expect(searchDemoThreads("demo-robin", "Aurora").map(thread => thread.id)).toEqual(["demo-robin-aurora"]);
  });

  it("installs a fail-fast account API guard covering current and future procedures", () => {
    for (const name of ["getAccounts", "getNumThreads", "getThreads", "getReplyDetails", "getEmailAddressSuggesstions", "getSearchResults", "sendEmail", "getSyncStatus", "futureOperation"]) {
      expect(() => { Reflect.get(forbiddenAccountApi, name); }).toThrow(`api.account.${name}`);
    }
    forbiddenDemoCalls.length = 0; // These explicit guard self-checks are not Demo interactions.
  });

  it("retains the test harness's network denial", async () => {
    await expect(fetch("https://mailbox-provider.example.test/")).rejects.toThrow("Network access is denied");
  });
});
