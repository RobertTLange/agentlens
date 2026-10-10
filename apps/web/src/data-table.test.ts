import { describe, expect, it } from "vitest";
import { dataTableRows } from "./data-table.js";

describe("data table", () => {
  it("preserves nested fields, array indices, empty containers, and primitive values", () => {
    expect(dataTableRows({ payload: { content: [{ text: "hello\nworld" }], empty: [], object: {}, absent: null, count: 0, enabled: false } })).toEqual([
      { field: "$.payload.content[0].text", value: "hello\nworld" },
      { field: "$.payload.empty", value: "[]" },
      { field: "$.payload.object", value: "{}" },
      { field: "$.payload.absent", value: "null" },
      { field: "$.payload.count", value: "0" },
      { field: "$.payload.enabled", value: "false" },
    ]);
    expect(dataTableRows("root text")).toEqual([{ field: "$", value: "root text" }]);
  });
});
