import { describe, expect, it } from "vitest";
import { changesSubject, threadSubject } from "./thread-subject.ts";

describe("threadSubject", () => {
  it("shows the subject as sent, not the lowercased one kept for matching replies", () => {
    const thread = { subject: "Re: Quarterly Report Q3", subjectNorm: "quarterly report q3" };
    expect(threadSubject(thread)).toBe("Re: Quarterly Report Q3");
  });

  it("says so when there is no subject", () => {
    expect(threadSubject({ subject: "" })).toBe("(no subject)");
  });
});

describe("changesSubject", () => {
  const thread = { subject: "Lunch plans" };

  it("marks a reply that moved the conversation to a new subject", () => {
    expect(changesSubject({ subject: "Re: Dinner instead" }, 2, thread)).toBe(true);
  });

  it("does not mark a plain reply, whatever its prefix or case", () => {
    expect(changesSubject({ subject: "Re: Lunch plans" }, 1, thread)).toBe(false);
    expect(changesSubject({ subject: "AW: lunch PLANS" }, 1, thread)).toBe(false);
  });

  it("never marks the first message or one without a subject", () => {
    expect(changesSubject({ subject: "Something else" }, 0, thread)).toBe(false);
    expect(changesSubject({ subject: "  " }, 3, thread)).toBe(false);
  });
});
