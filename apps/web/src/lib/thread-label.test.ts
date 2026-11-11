import { describe, expect, it } from "vitest";
import { counterpart } from "./thread-label.ts";

const own = new Set(["me@example.com"]);

describe("counterpart", () => {
  it("lists a conversation you started under the person you wrote to", () => {
    const participants = [{ address: "me@example.com" }, { name: "Ann", address: "ann@x.example" }];
    expect(counterpart(participants, own)).toEqual({ name: "Ann", address: "ann@x.example" });
  });

  it("counts a plus-address and another case as you", () => {
    const participants = [{ address: "Me+news@Example.com" }, { address: "bob@y.example" }];
    expect(counterpart(participants, own)?.address).toBe("bob@y.example");
  });

  it("falls back to the first participant when you are the only one", () => {
    expect(counterpart([{ address: "me@example.com" }], own)?.address).toBe("me@example.com");
  });

  it("keeps the sender first when someone else started it", () => {
    const participants = [{ address: "ann@x.example" }, { address: "me@example.com" }];
    expect(counterpart(participants, own)?.address).toBe("ann@x.example");
  });
});
