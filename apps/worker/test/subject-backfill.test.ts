import { message, thread } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { MAILBOX_ID, seedBase } from "./support/seed.ts";

// Migration 0051 marks stored out-of-office replies and gives every existing
// thread the subject delivery would have given it. Its UPDATE statements run
// here, as shipped, on rows written the way older code wrote them.

const MIGRATION = "0051_flippant_shockwave";

async function runBackfill(): Promise<void> {
  const migration = e.TEST_MIGRATIONS.find((m) => m.name.startsWith(MIGRATION));
  if (!migration) throw new Error(`migration ${MIGRATION} not found`);
  // Each query after the first still carries drizzle's breakpoint comment.
  const updates = migration.queries.filter((q) =>
    q
      .replace(/^(\s*--[^\n]*\n)*/, "")
      .trimStart()
      .startsWith("UPDATE"),
  );
  expect(updates).toHaveLength(2);
  await e.DB.batch(updates.map((q) => e.DB.prepare(q)));
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 9, minute));

async function seedThread(id: string, messages: [string, string, "in" | "out", Date][]) {
  await db().insert(thread).values({ id, mailboxId: MAILBOX_ID, msgCount: messages.length });
  await db()
    .insert(message)
    .values(
      messages.map(([mid, subject, direction, sentAt]) => ({
        id: mid,
        mailboxId: MAILBOX_ID,
        threadId: id,
        direction,
        fromAddr: "sender@elsewhere.test",
        subject,
        snippet: "",
        sentAt,
      })),
    );
}

const subjectOf = async (id: string) =>
  (await db().query.thread.findFirst({ where: eq(thread.id, id) }))?.subject;
const autoReplyOf = async (id: string) =>
  (await db().query.message.findFirst({ where: eq(message.id, id) }))?.autoReply;

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("migration 0051 backfill", () => {
  it("names a thread after its earliest message with a subject, as written", async () => {
    // Stored newest first, so row order cannot decide.
    await seedThread("th-1", [
      ["m-2", "Re: Lunch plans", "in", at(2)],
      ["m-1", "  Lunch plans ", "out", at(1)],
    ]);
    await runBackfill();
    expect(await subjectOf("th-1")).toBe("Lunch plans");
  });

  it("skips messages without a subject, and leaves a thread with none unnamed", async () => {
    await seedThread("th-late", [
      ["m-1", "", "in", at(1)],
      ["m-2", "Re: Found it", "in", at(2)],
    ]);
    await seedThread("th-blank", [["m-3", " ", "in", at(1)]]);
    await runBackfill();
    expect(await subjectOf("th-late")).toBe("Re: Found it");
    expect(await subjectOf("th-blank")).toBe("");
  });

  it("marks received out-of-office replies, and never lets one name a thread", async () => {
    await seedThread("th-ooo", [
      ["m-1", "", "out", at(1)],
      ["m-2", "Automatic reply: Lunch plans", "in", at(2)],
      ["m-3", "Re: Lunch plans", "in", at(3)],
    ]);
    await runBackfill();
    expect(await autoReplyOf("m-2")).toBe(true);
    expect(await autoReplyOf("m-3")).toBe(false);
    expect(await subjectOf("th-ooo")).toBe("Re: Lunch plans");
  });

  it("does not mark our own sent mail, whatever its subject", async () => {
    await seedThread("th-out", [["m-1", "Out of Office plans", "out", at(1)]]);
    await runBackfill();
    expect(await autoReplyOf("m-1")).toBe(false);
    expect(await subjectOf("th-out")).toBe("Out of Office plans");
  });
});
