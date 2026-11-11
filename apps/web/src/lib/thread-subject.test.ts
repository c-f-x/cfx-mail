import { describe, expect, it } from "vitest";
import { threadSubject } from "./thread-subject.ts";

describe("threadSubject", () => {
  it("shows the subject as sent, not the lowercased one kept for matching replies", () => {
    const thread = { subject: "Re: Quarterly Report Q3", subjectNorm: "quarterly report q3" };
    expect(threadSubject(thread)).toBe("Re: Quarterly Report Q3");
  });

  it("says so when there is no subject", () => {
    expect(threadSubject({ subject: "" })).toBe("(no subject)");
  });
});
