import { describe, expect, it } from "vitest";
import { changesSubject, threadSubject } from "./thread-subject.ts";

describe("threadSubject", () => {
  it("shows the subject in its own case, without the reply prefix", () => {
    const thread = { subject: "Re: Quarterly Report Q3", subjectNorm: "quarterly report q3" };
    expect(threadSubject(thread)).toBe("Quarterly Report Q3");
    expect(threadSubject({ subject: "AW: Fwd: Angebot" })).toBe("Angebot");
  });

  it("says so when there is no subject", () => {
    expect(threadSubject({ subject: "" })).toBe("(no subject)");
  });
});

describe("changesSubject", () => {
  const thread = { subject: "Lunch plans" };
  const reply = (subject: string, autoReply = false) => ({ subject, autoReply });

  it("marks a reply that moved the conversation to a new subject", () => {
    expect(changesSubject(reply("Re: Dinner instead"), 2, thread)).toBe(true);
  });

  it("does not mark a plain reply, whatever its prefix or case", () => {
    expect(changesSubject(reply("Re: Lunch plans"), 1, thread)).toBe(false);
    expect(changesSubject(reply("AW: lunch PLANS"), 1, thread)).toBe(false);
  });

  it("does not mark an out-of-office reply's own subject", () => {
    expect(changesSubject(reply("Automatic reply: Lunch plans", true), 1, thread)).toBe(false);
  });

  it("never marks the first message or one without a subject", () => {
    expect(changesSubject(reply("Something else"), 0, thread)).toBe(false);
    expect(changesSubject(reply("  "), 3, thread)).toBe(false);
  });
});
