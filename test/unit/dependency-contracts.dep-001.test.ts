import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { KBarProvider, KBarResults, useMatches, type ActionImpl } from "kbar";

// Exercise the real package's provider/action/result contract used by MindMail,
// not a KBar mock. This is not a browser keyboard/virtual-scroll E2E test.
describe("DEP-001 KBar React 18 dependency contract", () => {
  it("preserves navigation sections, shortcuts and executable actions", () => {
    const perform = vi.fn();
    let observed: ActionImpl | undefined;
    function Results() {
      const { results, rootActionId } = useMatches();
      expect(rootActionId).toBeNull();
      observed = results.find((item): item is ActionImpl => typeof item !== "string" && item.id === "inboxAction");
      return createElement("div", null, results.map((item) => typeof item === "string" ? item : item.name).join("|"));
    }
    const html = renderToString(createElement(KBarProvider, { actions: [{
      id: "inboxAction", name: "Inbox", shortcut: ["g", "i"], section: "Email Navigation", perform,
    }] }, createElement(Results)));
    expect(html).toContain("Email Navigation|Inbox");
    expect(observed?.shortcut).toEqual(["g", "i"]);
    if (observed) observed.perform?.(observed);
    expect(perform).toHaveBeenCalledOnce();
    expect(typeof KBarResults).toBe("function");
  });
});
