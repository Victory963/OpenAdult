import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

describe("router type safety", () => {
  it("should have all required routers", () => {
    const procedures = appRouter._def.procedures;
    expect(procedures).toBeDefined();
    const keys = Object.keys(procedures);
    expect(keys.length).toBeGreaterThan(0);
    // Check that procedures exist (they're flattened with dots)
    const keysList = keys.join(",");
    expect(keysList).toContain("system");
  });
});
