import { draft, rule, ruleSendLog, session, user, userInvite } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { avatarKey, draftUploadKey } from "../src/mail/blob-keys.ts";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { markNetworkStepsNotDue } from "./support/cron.ts";
import { ADMIN_ID, MAILBOX_ID, MEMBER_ID, OWNER_ID, seedBase } from "./support/seed.ts";

// The cron steps that remove internal rows and objects nobody sees once they
// can no longer change an outcome (issue #2): expired sessions, the rule-send
// log past its longest window, used invites past their expiry, and R2 uploads
// and avatars that nothing refers to.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A tick that is not on the hour: the R2 sweep stays idle.
const NOW = new Date(Date.UTC(2030, 0, 15, 12, 30, 0));

async function cron(at: Date = NOW): Promise<void> {
  await markNetworkStepsNotDue(e, at);
  await runCron(e, at);
}

// R2 is shared by every test in this file, so each test starts from an empty
// bucket.
async function emptyBucket(): Promise<void> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each page is listed after the last one is gone
    const page = await e.BLOBS.list({ limit: 1000 });
    if (!page.objects.length) return;
    // eslint-disable-next-line no-await-in-loop -- see above
    await e.BLOBS.delete(page.objects.map((o) => o.key));
  }
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await emptyBucket();
  await seedBase(db());
});

describe("cron step: prune-expired-sessions", () => {
  const sessionRow = (id: string, expiresAt: Date) => ({
    id,
    userId: OWNER_ID,
    token: `token-${id}`,
    expiresAt,
  });

  it("deletes sessions that have expired and keeps live ones", async () => {
    await db()
      .insert(session)
      .values([
        sessionRow("expired-long-ago", new Date(NOW.getTime() - 60 * DAY)),
        sessionRow("expired-just-now", new Date(NOW.getTime() - SECOND)),
        sessionRow("expires-at-tick", NOW),
        sessionRow("live", new Date(NOW.getTime() + 29 * DAY)),
      ]);

    await cron();

    const left = (await db().select({ id: session.id }).from(session)).map((r) => r.id);
    expect(left.toSorted()).toEqual(["expires-at-tick", "live"]);
  });

  it("measures expiry from the tick's own time, not the wall clock", async () => {
    await db()
      .insert(session)
      .values(sessionRow("live-now", new Date(NOW.getTime() + DAY)));

    await cron(new Date(NOW.getTime() + 2 * DAY));

    expect(await db().select().from(session)).toEqual([]);
  });
});

describe("cron step: prune-rule-send-log", () => {
  const RULE_ID = "rule-1";
  const sent = (id: string, ageMs: number) => ({
    id,
    mailboxId: MAILBOX_ID,
    ruleId: RULE_ID,
    kind: "autoReply" as const,
    recipient: "someone@example.org",
    // Stored with second precision.
    sentAt: new Date(NOW.getTime() - ageMs),
  });

  beforeEach(async () => {
    await db().insert(rule).values({
      id: RULE_ID,
      mailboxId: MAILBOX_ID,
      createdBy: OWNER_ID,
      name: "Away",
    });
  });

  it("deletes sends older than the four-day auto-reply window and keeps the rest", async () => {
    await db()
      .insert(ruleSendLog)
      .values([
        sent("month-old", 30 * DAY),
        sent("just-past-window", 4 * DAY + SECOND),
        sent("at-window-edge", 4 * DAY),
        sent("inside-window", 3 * DAY),
        sent("last-hour", 10 * MINUTE),
      ]);

    await cron();

    const left = (await db().select({ id: ruleSendLog.id }).from(ruleSendLog)).map((r) => r.id);
    expect(left.toSorted()).toEqual(["at-window-edge", "inside-window", "last-hour"]);
  });
});

describe("cron step: prune-used-invites", () => {
  const invite = (id: string, expiresAt: Date, usedAt: Date | null) => ({
    id,
    email: `${id}@example.org`,
    token: `token-${id}`,
    invitedByUserId: ADMIN_ID,
    expiresAt,
    usedAt,
  });

  it("deletes used invites once their link has expired", async () => {
    await db()
      .insert(userInvite)
      .values([
        invite("used-expired", new Date(NOW.getTime() - DAY), new Date(NOW.getTime() - 6 * DAY)),
        invite("used-still-valid", new Date(NOW.getTime() + DAY), new Date(NOW.getTime() - DAY)),
      ]);

    await cron();

    const left = (await db().select({ id: userInvite.id }).from(userInvite)).map((r) => r.id);
    expect(left).toEqual(["used-still-valid"]);
  });

  it("keeps unused invites, expired or not, because the admin still sees them", async () => {
    await db()
      .insert(userInvite)
      .values([
        invite("unused-expired", new Date(NOW.getTime() - 30 * DAY), null),
        invite("unused-valid", new Date(NOW.getTime() + DAY), null),
      ]);

    await cron();

    const left = (await db().select({ id: userInvite.id }).from(userInvite)).map((r) => r.id);
    expect(left.toSorted()).toEqual(["unused-expired", "unused-valid"]);
  });
});

describe("cron step: sweep-orphan-blobs", () => {
  // R2 stamps each object with the real upload time, so the tests age objects
  // by running the tick that many days later. On the hour: the sweep runs.
  const onTheHour = (daysAfterUpload: number) => {
    const at = new Date(Date.now() + daysAfterUpload * DAY);
    at.setUTCMinutes(0, 0, 0);
    return at;
  };
  const keys = async (prefix: string) =>
    (await e.BLOBS.list({ prefix })).objects.map((o) => o.key).toSorted();

  async function upload(key: string): Promise<string> {
    await e.BLOBS.put(key, "bytes");
    return key;
  }

  const attachmentRef = (r2Key: string) => ({
    r2Key,
    filename: "file.pdf",
    contentType: "application/pdf",
    sizeBytes: 5,
  });

  it("deletes composer uploads no draft refers to, once they are over seven days old", async () => {
    const onDraft = await upload(draftUploadKey(OWNER_ID, "a", "on-draft.pdf"));
    const onSchedule = await upload(draftUploadKey(OWNER_ID, "b", "scheduled.pdf"));
    const orphan = await upload(draftUploadKey(OWNER_ID, "c", "orphan.pdf"));
    const otherUsersOrphan = await upload(draftUploadKey(MEMBER_ID, "d", "orphan.pdf"));
    await db()
      .insert(draft)
      .values([
        {
          id: "draft-1",
          mailboxId: MAILBOX_ID,
          userId: OWNER_ID,
          attachments: [attachmentRef(onDraft)],
        },
        {
          id: "draft-2",
          mailboxId: MAILBOX_ID,
          userId: OWNER_ID,
          scheduledFor: new Date(Date.now() + 30 * DAY),
          scheduledPayload: {
            mailboxId: MAILBOX_ID,
            to: [{ address: "someone@example.org" }],
            subject: "Later",
            text: "Later",
            attachments: [
              { r2Key: onSchedule, filename: "scheduled.pdf", contentType: "application/pdf" },
            ],
          },
        },
      ]);

    await cron(onTheHour(8));

    expect(await keys("draft/")).toEqual([onDraft, onSchedule].toSorted());
    expect(await e.BLOBS.head(orphan)).toBeNull();
    expect(await e.BLOBS.head(otherUsersOrphan)).toBeNull();
  });

  it("keeps an unreferenced upload for seven days, since an open composer may not have saved it yet", async () => {
    const fresh = await upload(draftUploadKey(OWNER_ID, "a", "fresh.pdf"));

    await cron(onTheHour(6));

    expect(await keys("draft/")).toEqual([fresh]);
  });

  it("deletes avatars no user shows, once they are over seven days old", async () => {
    const shown = await upload(avatarKey(OWNER_ID, "current"));
    const replaced = await upload(avatarKey(OWNER_ID, "previous"));
    const deletedUsers = await upload(avatarKey("user-gone", "pic"));
    await db()
      .update(user)
      .set({ image: `/api/avatar/${OWNER_ID}/current` })
      .where(eq(user.id, OWNER_ID));

    await cron(onTheHour(8));

    expect(await keys("avatar/")).toEqual([shown]);
    expect(await e.BLOBS.head(replaced)).toBeNull();
    expect(await e.BLOBS.head(deletedUsers)).toBeNull();
  });

  it("leaves mail and attachments alone", async () => {
    const raw = await upload(`raw/${MAILBOX_ID}/m1.eml`);
    const att = await upload("att/m1/0-file.pdf");

    await cron(onTheHour(400));

    expect(await keys("")).toEqual([att, raw].toSorted());
  });

  it("runs only on the hour, so the bucket is listed once an hour", async () => {
    const orphan = await upload(draftUploadKey(OWNER_ID, "a", "orphan.pdf"));
    const offTheHour = onTheHour(8);
    offTheHour.setUTCMinutes(1);

    await cron(offTheHour);
    expect(await keys("draft/")).toEqual([orphan]);

    await cron(onTheHour(8));
    expect(await keys("draft/")).toEqual([]);
  });
});
