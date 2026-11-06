import { folder, message, thread, threadFolder } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { foldersRoutes } from "../../src/api/folders.ts";
import { threadsRoutes } from "../../src/api/threads.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { MAILBOX_ID, OWNER_ID, owner, seedBase } from "../support/seed.ts";

// A thread stores only its normalised subject ("quarterly report"), which is
// for matching replies, not for showing. Lists show the subject of the
// thread's first message as it was sent, the same line the reading pane uses
// as its heading.

const THREAD = "th-subject";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 9, minute));

async function seedConversation(): Promise<void> {
  await db().insert(thread).values({
    id: THREAD,
    mailboxId: MAILBOX_ID,
    subjectNorm: "quarterly report q3",
    msgCount: 3,
  });
  // Inserted out of order: the first message is the oldest, not the first row.
  for (const [id, subject, minute] of [
    ["m-2", "Re: Quarterly Report Q3", 2],
    ["m-1", "Quarterly Report Q3", 1],
    ["m-3", "RE: Re: Quarterly Report Q3 (final)", 3],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- three rows, in this order
    await db()
      .insert(message)
      .values({
        id,
        mailboxId: MAILBOX_ID,
        threadId: THREAD,
        direction: "in",
        fromAddr: "sender@elsewhere.test",
        subject,
        snippet: "",
        createdAt: at(minute),
      });
  }
}

type Listed = { threads: { id: string; subject: string }[] };

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  await seedConversation();
});

describe("thread subject", () => {
  it("lists a thread under its first message's subject, as sent", async () => {
    const lists = await Promise.all(
      [MAILBOX_ID, "all"].map(async (scope) => {
        const res = await request(mountApp(threadsRoutes, owner), "GET", `/?mailboxId=${scope}`);
        expect(res.status).toBe(200);
        return (await res.json()) as Listed;
      }),
    );
    for (const body of lists) {
      expect(body.threads.map((t) => [t.id, t.subject])).toEqual([[THREAD, "Quarterly Report Q3"]]);
    }
  });

  it("lists a filed thread under the same subject", async () => {
    await db().insert(folder).values({ id: "fold-1", userId: OWNER_ID, name: "Filed" });
    await db()
      .insert(threadFolder)
      .values({ threadId: THREAD, userId: OWNER_ID, folderId: "fold-1" });
    const res = await request(mountApp(foldersRoutes, owner), "GET", "/fold-1/threads");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Listed;
    expect(body.threads.map((t) => t.subject)).toEqual(["Quarterly Report Q3"]);
  });

  it("still pages a folder newest first", async () => {
    await db().insert(folder).values({ id: "fold-1", userId: OWNER_ID, name: "Filed" });
    const ids = ["older", "middle", "newest"];
    await db()
      .insert(thread)
      .values(
        ids.map((id, i) => ({
          id,
          mailboxId: MAILBOX_ID,
          subjectNorm: id,
          lastMsgAt: new Date(Date.UTC(2026, 9, 1, i)),
        })),
      );
    await db()
      .insert(threadFolder)
      .values(ids.map((threadId) => ({ threadId, userId: OWNER_ID, folderId: "fold-1" })));
    const app = mountApp(foldersRoutes, owner);
    const first = (await (
      await request(app, "GET", "/fold-1/threads?limit=2")
    ).json()) as Listed & {
      nextCursor: string;
    };
    const cursor = encodeURIComponent(first.nextCursor);
    const second = (await (
      await request(app, "GET", `/fold-1/threads?limit=2&cursor=${cursor}`)
    ).json()) as Listed;
    expect([...first.threads, ...second.threads].map((t) => t.id)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
  });

  it("gives the opened thread the subject its reading pane shows", async () => {
    const res = await request(mountApp(threadsRoutes, owner), "GET", `/${THREAD}`);
    const body = (await res.json()) as {
      thread: { subject: string };
      messages: { subject: string }[];
    };
    expect(body.thread.subject).toBe("Quarterly Report Q3");
    expect(body.messages[0]!.subject).toBe(body.thread.subject);
  });

  it("names a thread that started without a subject after the first reply that has one", async () => {
    await db().update(message).set({ subject: " " }).where(eq(message.id, "m-1"));
    const listed = (await (
      await request(mountApp(threadsRoutes, owner), "GET", `/?mailboxId=${MAILBOX_ID}`)
    ).json()) as Listed;
    expect(listed.threads.map((t) => t.subject)).toEqual(["Re: Quarterly Report Q3"]);
    const opened = (await (
      await request(mountApp(threadsRoutes, owner), "GET", `/${THREAD}`)
    ).json()) as { thread: { subject: string } };
    expect(opened.thread.subject).toBe("Re: Quarterly Report Q3");
  });
});
