import { blocklist, message } from "@cfmail/db/schema";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isSenderBlocked } from "../src/mail/blocklist.ts";
import { handleInbound } from "../src/mail/receive.ts";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { seedBase } from "./support/seed.ts";

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  const stale = (await e.BLOBS.list()).objects.map((o) => o.key);
  if (stale.length) await e.BLOBS.delete(stale);
  await seedBase(db());
  await db()
    .insert(blocklist)
    .values([
      { id: "b-email", type: "email", value: "spammer@bad.test" },
      { id: "b-domain", type: "domain", value: "evil.test" },
      { id: "b-sub", type: "domain", value: "mail.sub.nasty.test" },
    ]);
});

describe("isSenderBlocked", () => {
  it("blocks an exact address", async () => {
    expect(await isSenderBlocked(db(), ["spammer@bad.test"])).toBe(true);
  });

  it("does not block another address on the same domain as a blocked address", async () => {
    expect(await isSenderBlocked(db(), ["friend@bad.test"])).toBe(false);
  });

  it("blocks every address on a blocked domain", async () => {
    expect(await isSenderBlocked(db(), ["anyone@evil.test"])).toBe(true);
    expect(await isSenderBlocked(db(), ["other@evil.test"])).toBe(true);
  });

  it("blocks a subdomain of a blocked domain, at any depth", async () => {
    expect(await isSenderBlocked(db(), ["a@mail.evil.test"])).toBe(true);
    expect(await isSenderBlocked(db(), ["a@x.y.z.evil.test"])).toBe(true);
  });

  it("does not block the parent of a blocked subdomain", async () => {
    expect(await isSenderBlocked(db(), ["a@mail.sub.nasty.test"])).toBe(true);
    expect(await isSenderBlocked(db(), ["a@sub.nasty.test"])).toBe(false);
    expect(await isSenderBlocked(db(), ["a@nasty.test"])).toBe(false);
  });

  it("does not block a domain that only ends with the blocked name", async () => {
    expect(await isSenderBlocked(db(), ["a@notevil.test"])).toBe(false);
    expect(await isSenderBlocked(db(), ["a@evil.test.example"])).toBe(false);
  });

  it("ignores case and surrounding whitespace in the candidate", async () => {
    expect(await isSenderBlocked(db(), ["  SPAMMER@BAD.TEST "])).toBe(true);
    expect(await isSenderBlocked(db(), ["Someone@Mail.EVIL.test"])).toBe(true);
  });

  it("matches an address entry only as an address and a domain entry only as a domain", async () => {
    await db()
      .insert(blocklist)
      .values([
        { id: "b-wrong-1", type: "email", value: "wrongtype.test" },
        { id: "b-wrong-2", type: "domain", value: "someone@wrongdomain.test" },
      ]);
    expect(await isSenderBlocked(db(), ["a@wrongtype.test"])).toBe(false);
    expect(await isSenderBlocked(db(), ["someone@wrongdomain.test"])).toBe(false);
  });

  it("blocks when any one of several candidates is blocked", async () => {
    // The envelope sender is clean and the header From is blocked, or the other way round.
    expect(await isSenderBlocked(db(), ["bounce@clean.test", "spammer@bad.test"])).toBe(true);
    expect(await isSenderBlocked(db(), ["spammer@bad.test", "bounce@clean.test"])).toBe(true);
    expect(await isSenderBlocked(db(), ["bounce@clean.test", "friend@clean.test"])).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["no at sign", "evil.test"],
    ["a leading at sign", "@evil.test"],
    ["a trailing at sign", "spammer@"],
  ])("does not block a candidate that is %s", async (_name, candidate) => {
    expect(await isSenderBlocked(db(), [candidate])).toBe(false);
  });

  it("does not block anything when the list of candidates is empty", async () => {
    expect(await isSenderBlocked(db(), [])).toBe(false);
  });

  it("blocks nothing when the blocklist is empty", async () => {
    await e.DB.prepare("DELETE FROM blocklist").run();
    expect(await isSenderBlocked(db(), ["spammer@bad.test", "a@evil.test"])).toBe(false);
  });

  it("uses the part after the last at sign as the domain", async () => {
    expect(await isSenderBlocked(db(), ['"odd@name"@evil.test'])).toBe(true);
  });
});

async function storedMessages(): Promise<number> {
  const [rows, raws] = await Promise.all([
    db().select({ id: message.id }).from(message),
    e.BLOBS.list({ prefix: "raw/" }),
  ]);
  return rows.length + raws.objects.length;
}

describe("handleInbound with a blocked sender", () => {
  const TO = "other@example.com";

  function inbound(opts: { from: string; to?: string; headerFrom?: string }) {
    const raw = [
      `From: ${opts.headerFrom ?? opts.from}`,
      `To: ${opts.to ?? TO}`,
      "Subject: hello",
      "Message-ID: <blocked-test@sender.test>",
      "",
      "body",
      "",
    ].join("\r\n");
    const stub = {
      from: opts.from,
      to: opts.to ?? TO,
      headers: new Headers(),
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      rawSize: raw.length,
      rejected: undefined as string | undefined,
      setReject(reason: string) {
        this.rejected = reason;
      },
      async forward() {},
      async reply() {},
    };
    return stub as unknown as ForwardableEmailMessage & { rejected?: string };
  }

  it("rejects a blocked envelope sender with the same reason as an unknown address", async () => {
    const blocked = inbound({ from: "spammer@bad.test" });
    await handleInbound(blocked, e);

    const unknown = inbound({ from: "friend@clean.test", to: "nobody@example.com" });
    await handleInbound(unknown, e);

    expect(blocked.rejected).toBe("Address not found");
    expect(blocked.rejected).toBe(unknown.rejected);
    expect(await storedMessages()).toBe(0);
  });

  it.each(["anyone@evil.test", "anyone@deep.mail.evil.test"])(
    "rejects %s, a sender on a blocked domain",
    async (from) => {
      const msg = inbound({ from });
      await handleInbound(msg, e);
      expect(msg.rejected).toBe("Address not found");
      expect(await storedMessages()).toBe(0);
    },
  );

  it("rejects a blocked address in the header From when the envelope sender is clean", async () => {
    const msg = inbound({
      from: "bounce@clean.test",
      headerFrom: "Innocent Looking <spammer@bad.test>",
    });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Address not found");
    expect(await storedMessages()).toBe(0);
  });

  it("matches the blocked sender whatever its case in the envelope", async () => {
    const msg = inbound({ from: "SPAMMER@Bad.Test" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Address not found");
    expect(await storedMessages()).toBe(0);
  });

  it("delivers mail from a sender that is not blocked", async () => {
    const msg = inbound({ from: "friend@clean.test" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();
    expect(await storedMessages()).toBeGreaterThan(0);
  });
});
