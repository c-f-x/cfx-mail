import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { AppError } from "../src/errors.ts";
import { performUnsubscribe, resolveUnsubscribe } from "../src/mail/unsubscribe.ts";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { MAILBOX_ID, seedBase } from "./support/seed.ts";

type Sent = {
  from: string | { name: string; email: string };
  to: string[];
  subject: string;
  text: string;
};

function envWithEmail(sent: Sent[]): Env {
  return {
    ...e,
    EMAIL: { send: async (m: Sent) => void sent.push(m) } as unknown as Env["EMAIL"],
  } as Env;
}

const msgFor = (listUnsubscribe: string, listUnsubscribePost: string | null = null) => ({
  mailboxId: MAILBOX_ID,
  deliveredTo: "team@example.com",
  listUnsubscribe,
  listUnsubscribePost,
});

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("performUnsubscribe — mailto", () => {
  it("sends nothing for the audited multi-recipient, sender-written mailto", async () => {
    const sent: Sent[] = [];
    const header =
      "<mailto:boss@corp.example,press@news.example?subject=I%20resign&body=Effective%20today.>";
    await expect(
      performUnsubscribe(envWithEmail(sent), db(), msgFor(header)),
    ).rejects.toMatchObject({ code: "unprocessable" });
    expect(sent).toEqual([]);
  });

  it("sends one mail with the fixed body to a single address and ignores the sender's body", async () => {
    const sent: Sent[] = [];
    const res = await performUnsubscribe(
      envWithEmail(sent),
      db(),
      msgFor("<mailto:unsub@news.example?subject=Remove%20me&body=Effective%20today.>"),
    );
    expect(res).toEqual({ status: "unsubscribed", method: "email" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ["unsub@news.example"],
      subject: "Remove me",
      text: "Please unsubscribe me from this list.",
    });
  });

  it("uses 'Unsubscribe' when the subject is absent", async () => {
    const sent: Sent[] = [];
    await performUnsubscribe(envWithEmail(sent), db(), msgFor("<mailto:unsub@news.example>"));
    expect(sent[0]?.subject).toBe("Unsubscribe");
  });

  it("falls back to 'Unsubscribe' for an over-long subject", async () => {
    const sent: Sent[] = [];
    await performUnsubscribe(
      envWithEmail(sent),
      db(),
      msgFor(`<mailto:unsub@news.example?subject=${"a".repeat(101)}>`),
    );
    expect(sent[0]?.subject).toBe("Unsubscribe");
  });

  it("keeps a subject of exactly 100 characters", async () => {
    const sent: Sent[] = [];
    await performUnsubscribe(
      envWithEmail(sent),
      db(),
      msgFor(`<mailto:unsub@news.example?subject=${"a".repeat(100)}>`),
    );
    expect(sent[0]?.subject).toBe("a".repeat(100));
  });

  it("falls back to 'Unsubscribe' when the subject carries control characters", async () => {
    const sent: Sent[] = [];
    await performUnsubscribe(
      envWithEmail(sent),
      db(),
      msgFor("<mailto:unsub@news.example?subject=Hi%0D%0ABcc:%20boss@corp.example>"),
    );
    expect(sent[0]?.subject).toBe("Unsubscribe");
  });

  it.each([
    "<mailto:not-an-address>",
    "<mailto:>",
    "<mailto:a@b.example,c@d.example>",
    "<mailto:a%40b.example%2Cc%40d.example>",
    "<mailto:Boss <boss@corp.example>>",
  ])("rejects %s as unprocessable", async (header) => {
    const sent: Sent[] = [];
    const err = await performUnsubscribe(envWithEmail(sent), db(), msgFor(header)).catch(
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("unprocessable");
    expect(sent).toEqual([]);
  });
});

describe("resolveUnsubscribe — what the user is shown before confirming", () => {
  it("names the single mailto address", () => {
    expect(resolveUnsubscribe("<mailto:Unsub@News.example?subject=x>", null)).toEqual({
      ok: true,
      plan: { method: "email", address: "Unsub@News.example", subject: "x" },
    });
  });

  it("names the host of a one-click https target", () => {
    expect(
      resolveUnsubscribe("<https://news.example/u/abc>", "List-Unsubscribe=One-Click"),
    ).toEqual({
      ok: true,
      plan: { method: "one-click", url: "https://news.example/u/abc", host: "news.example" },
    });
  });

  it("names the host of an https page that will be opened", () => {
    expect(resolveUnsubscribe("<https://news.example/u/abc>", null)).toEqual({
      ok: true,
      plan: { method: "link", url: "https://news.example/u/abc", host: "news.example" },
    });
  });

  it("reports a several-recipient mailto as unusable, never as a plan", () => {
    const r = resolveUnsubscribe("<mailto:a@b.example,c@d.example>", null);
    expect(r.ok).toBe(false);
  });

  it("reports a header with no supported target", () => {
    expect(resolveUnsubscribe("<http://plain.example/>", null).ok).toBe(false);
  });
});
