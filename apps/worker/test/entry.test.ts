import { describe, expect, it } from "vitest";
import * as entry from "../src/index.ts";

// AGENTS.md invariant 1: one Worker. A new protocol is a new handler on this
// module, not a new service, and the only class the runtime binds is the
// UserHub Durable Object. Changing either list is an architecture decision.
const isClass = (value: unknown) =>
  typeof value === "function" && /^class\b/.test(Function.prototype.toString.call(value));

describe("the Worker module", () => {
  it("handles exactly fetch, email, connect and scheduled", () => {
    expect(Object.keys(entry.default).toSorted()).toEqual([
      "connect",
      "email",
      "fetch",
      "scheduled",
    ]);
  });

  it("exports exactly one class, the UserHub Durable Object", () => {
    const classes = Object.entries(entry)
      .filter(([, value]) => isClass(value))
      .map(([name]) => name);
    expect(classes).toEqual(["UserHub"]);
  });
});
