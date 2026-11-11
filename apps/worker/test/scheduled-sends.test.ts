import { draft, mailboxMember, rateLimitCounter, user } from "@cfx-mail/db/schema";
import { Perm } from "@cfx-mail/shared/permissions";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesRoutes } from "../src/api/messages.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "./support/app.ts";
import { markNetworkStepsNotDue, runCronOffline } from "./support/cron.ts";
import { grantMember, MAILBOX_ID, MEMBER_ID, OWNER_ID, owner, seedBase } from "./support/seed.ts";

const SENT_PREFIX = `raw/${MAILBOX_ID}/sent/`;
const MINUTE = 60_000;

const payload = {
  mailboxId: MAILBOX_ID,
  to: [{ address: "recipient@elsewhere.test" }],
  subject: "Later",
  text: "deferred hello",
};

// The EMAIL binding has no local simulation, so tests swap in a fake.
function emailOk(delayMs = 0): { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { messageId: "platform-mid" };
    }),
  };
}
function envWith(over: Partial<Record<keyof Env, unknown>>): Env {
  return { ...e, ...over } as Env;
}

async function seedScheduledDraft(over: Partial<typeof draft.$inferInsert> = {}): Promise<string> {
  const id = `draft-${crypto.randomUUID()}`;
  await db()
    .insert(draft)
    .values({
      id,
      mailboxId: MAILBOX_ID,
      userId: OWNER_ID,
      scheduledFor: new Date(Date.now() - MINUTE),
      scheduledPayload: payload,
      ...over,
    });
  return id;
}

const draftRow = (id: string) => db().query.draft.findFirst({ where: eq(draft.id, id) });

async function sentBlobKeys(): Promise<string[]> {
  const listed = await e.BLOBS.list({ prefix: SENT_PREFIX });
  return listed.objects.map((o) => o.key);
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 2000;
  let acc = "";
  while (!acc.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    const timed = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
    const result = await Promise.race([reader.read(), timed]);
    if (result === null) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    if (result.done) throw new Error(`stream ended before ${needle}; got: ${acc}`);
    acc += decoder.decode(result.value, { stream: true });
  }
  return acc;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  const stale = await sentBlobKeys();
  await Promise.all(stale.map((key) => e.BLOBS.delete(key)));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled sends: sent once", () => {
  it("two overlapping cron runs send a due draft exactly once", async () => {
    const id = await seedScheduledDraft();
    const email = emailOk(50);
    const env = envWith({ EMAIL: email });
    const now = new Date();

    await Promise.all([runCronOffline(env, now), runCronOffline(env, now)]);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(await db().query.message.findMany()).toHaveLength(1);
    expect(await sentBlobKeys()).toHaveLength(1);
    expect(await draftRow(id)).toBeUndefined();
  });

  it("a cleanup failure after delivery does not send again on the next tick", async () => {
    const key = `draft/${OWNER_ID}/${crypto.randomUUID()}-note.txt`;
    await e.BLOBS.put(key, "note", { httpMetadata: { contentType: "text/plain" } });
    const id = await seedScheduledDraft({
      scheduledPayload: {
        ...payload,
        attachments: [{ r2Key: key, filename: "note.txt", contentType: "text/plain" }],
      },
    });
    // Storage that cannot delete the composer upload once the mail has left.
    const blobs = new Proxy(e.BLOBS, {
      get(target, prop) {
        if (prop === "delete") {
          return (k: string) =>
            k.startsWith("draft/")
              ? Promise.reject(new Error("R2 delete failed"))
              : target.delete(k);
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const email = emailOk();
    const env = envWith({ EMAIL: email, BLOBS: blobs });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCronOffline(env, new Date());
    await runCronOffline(env, new Date(Date.now() + 20 * MINUTE));

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(await db().query.message.findMany()).toHaveLength(1);
    expect(await draftRow(id)).toBeUndefined();
    expect(logged.mock.calls.some((c) => String(c[0]).includes("scheduled_send_cleanup"))).toBe(
      true,
    );
    await e.BLOBS.delete(key);
  });

  it("a draft that cannot be deleted after delivery is not sent again", async () => {
    const id = await seedScheduledDraft();
    // A database that refuses to delete the draft once the mail has left.
    await e.DB.exec(
      "CREATE TRIGGER keep_draft BEFORE DELETE ON draft BEGIN SELECT RAISE(ABORT, 'delete failed'); END",
    );
    const email = emailOk();
    const env = envWith({ EMAIL: email });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runCronOffline(env, new Date());
      await runCronOffline(env, new Date(Date.now() + 20 * MINUTE));
      await runCronOffline(env, new Date(Date.now() + 40 * MINUTE));
    } finally {
      await e.DB.exec("DROP TRIGGER keep_draft");
    }

    expect(email.send).toHaveBeenCalledTimes(1);
    // The draft stays as a plain draft: no longer scheduled, and not marked
    // as failed, because the mail did go out.
    const row = await draftRow(id);
    expect(row?.scheduledFor).toBeNull();
    expect(row?.scheduledPayload).toBeNull();
    expect(row?.scheduledError).toBeNull();
    expect(logged.mock.calls.some((c) => String(c[0]).includes("scheduled_send_cleanup"))).toBe(
      true,
    );
  });

  it("the scheduled handler finishes the tick before it returns", async () => {
    const id = await seedScheduledDraft();
    const email = emailOk(20);

    // Work left running after the handler returns is cut off by the platform.
    const env = envWith({ EMAIL: email });
    await markNetworkStepsNotDue(env, new Date());
    await worker.scheduled({} as ScheduledController, env);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(await draftRow(id)).toBeUndefined();
  });
});

describe("scheduled sends: by someone still allowed", () => {
  it("does not send for a member removed after scheduling, and hands the draft back", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const id = await seedScheduledDraft({ userId: MEMBER_ID });
    await db()
      .delete(mailboxMember)
      .where(and(eq(mailboxMember.mailboxId, MAILBOX_ID), eq(mailboxMember.userId, MEMBER_ID)));

    const stub = e.USER_HUB.get(e.USER_HUB.idFromName(MEMBER_ID));
    const res = await stub.fetch("https://hub/subscribe");
    const reader = res.body!.getReader();
    const email = emailOk();

    try {
      await runCronOffline(envWith({ EMAIL: email }), new Date());

      expect(email.send).not.toHaveBeenCalled();
      expect(await db().query.message.findMany()).toHaveLength(0);
      const row = await draftRow(id);
      expect(row?.scheduledFor).toBeNull();
      expect(row?.scheduledPayload).toBeNull();
      expect(row?.scheduledError).toBe("You no longer have access to send from this mailbox.");
      const received = await readUntil(reader, "event: scheduled_send_failed");
      expect(received).toContain(`"draftId":"${id}"`);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it("does not send for an author banned after scheduling, even from their own mailbox", async () => {
    const id = await seedScheduledDraft();
    await db().update(user).set({ banned: true }).where(eq(user.id, OWNER_ID));
    const email = emailOk();

    await runCronOffline(envWith({ EMAIL: email }), new Date());

    expect(email.send).not.toHaveBeenCalled();
    const row = await draftRow(id);
    expect(row?.scheduledFor).toBeNull();
    expect(row?.scheduledError).toBe("You no longer have access to send from this mailbox.");
  });
});

describe("scheduled sends: within the limit", () => {
  const sendKey = `send:${OWNER_ID}`;
  const counter = async () =>
    (await db().query.rateLimitCounter.findFirst({ where: eq(rateLimitCounter.key, sendKey) }))
      ?.count;

  it("defers the 61st send of the hour without counting a failed attempt", async () => {
    await db()
      .insert(rateLimitCounter)
      .values({ key: sendKey, count: 60, windowStart: Date.now() });
    const id = await seedScheduledDraft();
    const email = emailOk();
    const now = new Date();

    await runCronOffline(envWith({ EMAIL: email }), now);

    expect(email.send).not.toHaveBeenCalled();
    const row = await draftRow(id);
    expect(row?.scheduledPayload).not.toBeNull();
    expect(row?.scheduledAttempts).toBe(0);
    expect(row?.scheduledError).toBeNull();
    expect(row!.scheduledFor!.getTime()).toBeGreaterThan(now.getTime());
    expect(row!.scheduledFor!.getTime()).toBeLessThanOrEqual(now.getTime() + 10 * MINUTE);
  });

  it("counts a scheduled send in the same hourly bucket as an immediate send", async () => {
    await db()
      .insert(rateLimitCounter)
      .values({ key: sendKey, count: 59, windowStart: Date.now() });
    await seedScheduledDraft();
    const email = emailOk();
    const env = envWith({ EMAIL: email });

    await runCronOffline(env, new Date());
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(await counter()).toBe(60);

    const direct = await mountApp(messagesRoutes, owner).request(
      "/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(direct.status).toBe(429);
    expect(email.send).toHaveBeenCalledTimes(1);
  });
});
