import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, selectedAccount, select } = vi.hoisted(() => ({
  query: vi.fn(), selectedAccount: vi.fn(() => ({ accountId: "production-account" })),
  select: vi.fn<(props: { options?: { value: string; label: React.ReactNode }[];
    onChange: (values: { label: string; value: string }[]) => void }) => null>(() => null),
}));
vi.mock("~/hooks/use-threads", () => ({ default: selectedAccount }));
vi.mock("~/trpc/react", () => ({ api: { account: { getEmailAddressSuggesstions: { useQuery: query } } } }));
vi.mock("react-select", () => ({ default: select }));

import TagInput from "~/app/mail/components/email-editor/tag-input";
import { RecipientInput } from "~/app/mail/components/email-editor/recipient-input";

beforeEach(() => { query.mockReturnValue({ data: [{ address: "production@example.test" }] }); select.mockReturnValue(null); });

describe("DEMO-002 recipient presentation/adapters", () => {
  it("preserves the production account suggestion query and unchanged recipient callback", () => {
    const onChange = vi.fn();
    renderToString(React.createElement(TagInput, { label: "TO", placeholder: "Recipients", value: [], onChange }));
    expect(selectedAccount).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledExactlyOnceWith({ accountId: "production-account" });
    const props = select.mock.lastCall?.[0];
    expect(props?.options?.map(option => option.value)).toEqual(["production@example.test"]);
    expect(React.isValidElement(props?.options?.[0]?.label)).toBe(true);
    const values = [{ label: "Edited recipient", value: "edited@example.test" }];
    props?.onChange(values);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(values);
  });

  it("renders synthetic data without executing production hooks, queries or avatar presentation", () => {
    renderToString(React.createElement(RecipientInput, { label: "TO", placeholder: "Recipients", value: [], onChange: vi.fn(),
      suggestions: [{ address: "synthetic@example.test" }], showAvatars: false }));
    expect(select.mock.lastCall?.[0].options).toEqual([{ value: "synthetic@example.test", label: "synthetic@example.test" }]);
    expect(selectedAccount).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
});
