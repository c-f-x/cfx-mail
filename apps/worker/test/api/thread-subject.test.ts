import { folder, message, thread, threadFolder } from "@cfx-mail/db/schema";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { foldersRoutes } from "../../src/api/folders.ts";
import { threadsRoutes } from "../../src/api/threads.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { MAILBOX_ID, OWNER_ID, owner, seedBase } from "../support/seed.ts";

// A thread stores its subject as people wrote it (`subject`) beside the
// lowercased key that matches replies (`subjectNorm`). Lists and the reading
// pane show the stored subject, the same line in both places. Delivery sets it
// (test/threads.test.ts, test/receive.test.ts); migration 0051 filled it in for
// older threads (test/subject-backfill.test.ts).

const THREAD = "th-subject";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 9, minute));

async function seedConversation(): Promise<void> {
  await db().insert(thread).values({
    id: THREAD,
    mailboxId: MAILBOX_ID,
    subject: "Quarterly Report Q3",
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
  it("lists a thread under its stored subject, as written", async () => {
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

  it("shows the subject the thread took, not its first message's", async () => {
    // A conversation that started without a subject, named by a later reply.
    await db()
      .insert(thread)
      .values({
        id: "th-named-late",
        mailboxId: MAILBOX_ID,
        subject: "Re: Lunch plans",
        subjectNorm: "lunch plans",
        lastMsgAt: at(30),
      });
    await db().insert(message).values({
      id: "m-blank",
      mailboxId: MAILBOX_ID,
      threadId: "th-named-late",
      direction: "in",
      fromAddr: "sender@elsewhere.test",
      subject: "",
      snippet: "",
    });
    const listed = (await (
      await request(mountApp(threadsRoutes, owner), "GET", `/?mailboxId=${MAILBOX_ID}`)
    ).json()) as Listed;
    expect(listed.threads.map((t) => [t.id, t.subject])).toContainEqual([
      "th-named-late",
      "Re: Lunch plans",
    ]);
    const opened = (await (
      await request(mountApp(threadsRoutes, owner), "GET", "/th-named-late")
    ).json()) as { thread: { subject: string } };
    expect(opened.thread.subject).toBe("Re: Lunch plans");
  });
});
