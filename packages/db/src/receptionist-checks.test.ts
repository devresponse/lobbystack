import { describe, expect, it } from "vitest";

import { describeReceptionistData, type ReceptionistDataReport } from "./receptionist-checks";

const clean: ReceptionistDataReport = { mismatchedSharedSettings: [], withoutDefault: [], unfilled: { calls: 0, conversations: 0, inbox_items: 0 } };

// checkReceptionistData itself runs against a database in
// packages/domain/src/server/receptionistRecords.integration.test.ts.
describe("the migrate service's receptionist data lines", () => {
  it("passes a deployment whose data is in order, and says what the backfill has left", () => {
    expect(describeReceptionistData({ ...clean, unfilled: { calls: 12_000, conversations: 40, inbox_items: 0 } })).toEqual({
      failures: [],
      warnings: [],
      info: "Records naming no receptionist yet, which the worker's backfill fills: calls 12000, conversations 40, inbox_items 0.",
    });
  });

  it("fails the deploy when a business and its default receptionist disagree on a shared setting", () => {
    const { failures, warnings } = describeReceptionistData({ ...clean, mismatchedSharedSettings: ["b1", "b2"] });
    expect(failures).toEqual(["The shared receptionist settings differ between the business and its default receptionist for 2 business(es): b1, b2"]);
    expect(warnings).toEqual([]);
  });

  it("only warns about a business with no default receptionist yet", () => {
    const { failures, warnings } = describeReceptionistData({ ...clean, withoutDefault: ["seed"] });
    expect(failures).toEqual([]);
    expect(warnings).toEqual(["1 business(es) have no default receptionist yet; their first settings save creates it: seed"]);
  });

  it("names the first 20 businesses and counts the rest", () => {
    const ids = Array.from({ length: 23 }, (_, index) => `b${index + 1}`);
    const [failure] = describeReceptionistData({ ...clean, mismatchedSharedSettings: ids }).failures;
    expect(failure).toContain(`: ${ids.slice(0, 20).join(", ")} and 3 more`);
    expect(failure).not.toContain("b21");
  });
});
