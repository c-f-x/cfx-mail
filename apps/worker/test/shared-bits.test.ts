import { Flag, hasFlag, setFlag } from "@cfx-mail/shared/flags";
import {
  ALL_MAILBOX_KINDS,
  ALL_PERMS,
  describeKinds,
  describe as describePerms,
  grant,
  has,
  kindBit,
  MailboxKind,
  Perm,
  revoke,
} from "@cfx-mail/shared/permissions";
import {
  createRule,
  sendMessage,
  serviceSend,
  splitMessageIds,
  updateRule,
} from "@cfx-mail/shared/schemas";
import { describe, expect, it } from "vitest";

describe("message flags", () => {
  it("detects a set bit and rejects an unset one", () => {
    const flags = Flag.SEEN | Flag.STARRED;
    expect(hasFlag(flags, Flag.SEEN)).toBe(true);
    expect(hasFlag(flags, Flag.STARRED)).toBe(true);
    expect(hasFlag(flags, Flag.TRASH)).toBe(false);
  });

  it("sets and clears a bit without touching the others", () => {
    let flags = Flag.SEEN;
    flags = setFlag(flags, Flag.STARRED, true);
    expect(hasFlag(flags, Flag.SEEN)).toBe(true);
    expect(hasFlag(flags, Flag.STARRED)).toBe(true);

    flags = setFlag(flags, Flag.SEEN, false);
    expect(hasFlag(flags, Flag.SEEN)).toBe(false);
    expect(hasFlag(flags, Flag.STARRED)).toBe(true);
  });

  it("is idempotent", () => {
    expect(setFlag(Flag.SEEN, Flag.SEEN, true)).toBe(Flag.SEEN);
    expect(setFlag(0, Flag.SEEN, false)).toBe(0);
  });
});

describe("permission bits", () => {
  it("has() requires the exact bit", () => {
    expect(has(Perm.READ | Perm.WRITE, Perm.READ)).toBe(true);
    expect(has(Perm.READ, Perm.MANAGE)).toBe(false);
  });

  it("grant() adds bits, revoke() removes them", () => {
    const granted = grant(0, Perm.READ, Perm.WRITE);
    expect(has(granted, Perm.READ)).toBe(true);
    expect(has(granted, Perm.WRITE)).toBe(true);
    expect(has(granted, Perm.MANAGE)).toBe(false);

    const revoked = revoke(granted, Perm.WRITE);
    expect(has(revoked, Perm.WRITE)).toBe(false);
    expect(has(revoked, Perm.READ)).toBe(true);
  });

  it("ALL_PERMS carries every bit", () => {
    expect(has(ALL_PERMS, Perm.READ)).toBe(true);
    expect(has(ALL_PERMS, Perm.WRITE)).toBe(true);
    expect(has(ALL_PERMS, Perm.MANAGE)).toBe(true);
  });

  it("describe() lists set permissions in order", () => {
    expect(describePerms(ALL_PERMS)).toEqual(["read", "write", "manage"]);
    expect(describePerms(Perm.READ | Perm.MANAGE)).toEqual(["read", "manage"]);
    expect(describePerms(0)).toEqual([]);
  });
});

describe("mailbox kinds", () => {
  it("kindBit() maps names to bits and rejects unknowns", () => {
    expect(kindBit("personal")).toBe(MailboxKind.PERSONAL);
    expect(kindBit("temp")).toBe(MailboxKind.TEMP);
    // @ts-expect-error — exercising the runtime guard for an unknown kind
    expect(() => kindBit("bogus")).toThrow(/unknown mailbox kind/);
  });

  it("describeKinds() round-trips ALL_MAILBOX_KINDS", () => {
    expect(describeKinds(ALL_MAILBOX_KINDS)).toEqual(["personal", "group", "service", "temp"]);
    expect(describeKinds(MailboxKind.GROUP | MailboxKind.SERVICE)).toEqual(["group", "service"]);
    expect(describeKinds(0)).toEqual([]);
  });
});

describe("msg-id lists", () => {
  it("splits a References header on whitespace or commas", () => {
    expect(splitMessageIds("<a@x> <b@y>")).toEqual(["<a@x>", "<b@y>"]);
    expect(splitMessageIds("<a@x>,<b@y>")).toEqual(["<a@x>", "<b@y>"]);
    expect(splitMessageIds("<a@x>, <b@y>")).toEqual(["<a@x>", "<b@y>"]);
  });

  it("ignores phrases and malformed ids", () => {
    expect(splitMessageIds("Fred <fred@x>")).toEqual(["<fred@x>"]);
    expect(splitMessageIds("<no-at-sign> <b@y>")).toEqual(["<b@y>"]);
    expect(splitMessageIds("garbage")).toEqual([]);
  });

  it("flattens an unsplit chain a client copied out of a stored message", () => {
    const parsed = sendMessage.parse({
      mailboxId: "mailbox-1",
      to: [{ address: "peer@example.com" }],
      references: ["<a@x>,<b@y>", "<c@z>"],
    });
    expect(parsed.references).toEqual(["<a@x>", "<b@y>", "<c@z>"]);
  });
});

describe("service send headers", () => {
  const send = (headers: unknown) =>
    serviceSend.safeParse({ to: [{ address: "peer@example.com" }], subject: "Digest", headers });
  const HTTPS = "<https://app.example.org/unsubscribe?t=abc123>";
  const MAILTO = "<mailto:unsubscribe@example.org?subject=unsubscribe>";
  const ONE_CLICK = "List-Unsubscribe=One-Click";

  it("takes List-Unsubscribe and List-Unsubscribe-Post under their canonical names", () => {
    const parsed = send({ "List-Unsubscribe": HTTPS, "List-Unsubscribe-Post": ONE_CLICK });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.headers).toEqual({
      "List-Unsubscribe": HTTPS,
      "List-Unsubscribe-Post": ONE_CLICK,
    });
  });

  it("reads the names case-insensitively", () => {
    const parsed = send({ "list-unsubscribe": HTTPS, "LIST-UNSUBSCRIBE-POST": ONE_CLICK });
    expect(parsed.data?.headers).toEqual({
      "List-Unsubscribe": HTTPS,
      "List-Unsubscribe-Post": ONE_CLICK,
    });
  });

  it("takes an https and a mailto entry together, or a mailto alone", () => {
    expect(send({ "List-Unsubscribe": `${HTTPS}, ${MAILTO}` }).success).toBe(true);
    expect(send({ "List-Unsubscribe": `${MAILTO},${HTTPS}` }).success).toBe(true);
    expect(send({ "List-Unsubscribe": MAILTO }).success).toBe(true);
  });

  it("refuses every other header name", () => {
    for (const name of ["Bcc", "From", "X-Mailer", "List-Id", "Reply-To", "List-Unsubscribe2"]) {
      expect(send({ [name]: "x" }).success, name).toBe(false);
    }
  });

  it("refuses the same header given twice in different case", () => {
    expect(send({ "List-Unsubscribe": HTTPS, "list-unsubscribe": MAILTO }).success).toBe(false);
  });

  it("refuses a CR or LF anywhere, so no header can be injected", () => {
    expect(send({ "List-Unsubscribe": `${HTTPS}\r\nBcc: victim@example.com` }).success).toBe(false);
    expect(send({ "List-Unsubscribe": `${HTTPS}\n` }).success).toBe(false);
    expect(send({ "List-Unsubscribe": "<https://app.example.org/u?\rx>" }).success).toBe(false);
    expect(
      send({ "List-Unsubscribe": HTTPS, "List-Unsubscribe-Post": `${ONE_CLICK}\r\nX: y` }).success,
    ).toBe(false);
    expect(send({ "List-Unsubscribe\r\nBcc": HTTPS }).success).toBe(false);
  });

  it("refuses an http address, a bare URL and other schemes", () => {
    for (const value of [
      "<http://app.example.org/unsubscribe>",
      "https://app.example.org/unsubscribe",
      "<javascript:alert(1)>",
      "<ftp://example.org/u>",
      "<https://>",
      "<mailto:not-an-address>",
      "<https://app.example.org/a b>",
      "<https://app.example.org/ünsubscribe>",
      "",
    ]) {
      expect(send({ "List-Unsubscribe": value }).success, value).toBe(false);
    }
  });

  it("refuses more than two entries and a value over 2,048 characters", () => {
    expect(send({ "List-Unsubscribe": `${HTTPS}, ${MAILTO}, ${HTTPS}` }).success).toBe(false);
    const long = `<https://app.example.org/u?t=${"a".repeat(2_048)}>`;
    expect(send({ "List-Unsubscribe": long }).success).toBe(false);
  });

  it("refuses List-Unsubscribe-Post with any other value", () => {
    for (const value of ["list-unsubscribe=one-click", "List-Unsubscribe=One-Click ", "yes"]) {
      expect(send({ "List-Unsubscribe": HTTPS, "List-Unsubscribe-Post": value }).success).toBe(
        false,
      );
    }
  });

  it("refuses List-Unsubscribe-Post without an https List-Unsubscribe", () => {
    expect(send({ "List-Unsubscribe-Post": ONE_CLICK }).success).toBe(false);
    expect(send({ "List-Unsubscribe": MAILTO, "List-Unsubscribe-Post": ONE_CLICK }).success).toBe(
      false,
    );
  });

  it("refuses a header value that is not a string", () => {
    expect(send({ "List-Unsubscribe": ["<https://app.example.org/u>"] }).success).toBe(false);
  });

  it("is not part of the web app's own send", () => {
    const parsed = sendMessage.parse({
      mailboxId: "mailbox-1",
      to: [{ address: "peer@example.com" }],
      headers: { "List-Unsubscribe": HTTPS },
    });
    expect(parsed).not.toHaveProperty("headers");
  });
});

// A rule with one subject condition.
const ruleBody = (op: string, value: string) => ({
  mailboxId: "mailbox-1",
  name: "rule",
  conditions: [{ field: "subject", op, value }],
  actions: [{ type: "markRead" }],
});

describe("rule conditions", () => {
  it("refuses a regex that does not compile, naming the condition's value", () => {
    const res = createRule.safeParse(ruleBody("regex", "invoice (#\\d+"));
    expect(res.success).toBe(false);
    expect(res.error?.issues).toEqual([
      expect.objectContaining({
        path: ["conditions", 0, "value"],
        message: "not a valid regular expression",
      }),
    ]);
  });

  it("refuses it when a rule is edited too", () => {
    expect(updateRule.safeParse({ conditions: ruleBody("regex", "[a-z").conditions }).success).toBe(
      false,
    );
  });

  it("accepts a regex that compiles, and the same text under any other operator", () => {
    expect(createRule.safeParse(ruleBody("regex", "invoice #\\d+")).success).toBe(true);
    expect(createRule.safeParse(ruleBody("contains", "invoice (#\\d+")).success).toBe(true);
  });
});
