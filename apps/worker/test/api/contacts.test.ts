import { mailbox, message } from "@cfx-mail/db/schema";
import { Perm } from "@cfx-mail/shared/permissions";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contactsRoutes } from "../../src/api/contacts.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  DOMAIN_ID,
  grantMember,
  MAILBOX_ID,
  member,
  OWNER_ID,
  outsider,
  owner,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const asOwner = () => mountApp(contactsRoutes, owner);

type Contacts = { contacts: { address: string; name?: string }[] };

async function addresses(app = asOwner()): Promise<string[]> {
  const res = await request(app, "GET", "/");
  expect(res.status).toBe(200);
  return ((await res.json()) as Contacts).contacts.map((c) => c.address);
}

// A mailbox the owner holds, with one message that came from `from`.
async function mailboxWithMail(
  id: string,
  from: string,
  overrides: Pick<typeof mailbox.$inferInsert, "type" | "pendingPurge">,
): Promise<void> {
  const d = db();
  await d
    .insert(mailbox)
    .values({ id, domainId: DOMAIN_ID, localPart: id, ownerUserId: OWNER_ID, ...overrides });
  const { messageId } = await seedThread(d, id);
  await d.update(message).set({ fromAddr: from }).where(eq(message.id, messageId));
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("contacts", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(contactsRoutes, null), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("includes accessible mailbox directory addresses", async () => {
    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as Contacts;
    const addrs = body.contacts.map((c) => c.address);
    // Both owned mailboxes appear as directory entries.
    expect(addrs).toContain("team@example.com");
    expect(addrs).toContain("other@example.com");
  });

  it("harvests addresses from message history and dedupes case-insensitively", async () => {
    const d = db();
    const { messageId } = await seedThread(d);
    await d
      .update(message)
      .set({
        fromAddr: "Alice@Example.test",
        fromName: "Alice",
        toAddrs: [{ address: "bob@example.test", name: "Bob" }],
      })
      .where(eq(message.id, messageId));

    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as Contacts;
    const alice = body.contacts.find((c) => c.address === "alice@example.test");
    expect(alice).toBeDefined();
    expect(alice?.name).toBe("Alice");
    expect(body.contacts.find((c) => c.address === "bob@example.test")).toBeDefined();
  });

  it("does not leak addresses from mailboxes the caller can't access", async () => {
    await seedThread(db(), MAILBOX_ID);
    const res = await request(mountApp(contactsRoutes, outsider), "GET", "/");
    const body = (await res.json()) as Contacts;
    // Outsider owns/manages nothing, so no directory + no history.
    expect(body.contacts).toHaveLength(0);
  });

  // Service mailboxes are key-driven and never user-facing, and a purging
  // mailbox's mail is on its way out. Neither belongs in the composer.
  it("leaves out service mailboxes and mailboxes being purged", async () => {
    await mailboxWithMail("svc", "svc-sender@elsewhere.test", { type: "service" });
    await mailboxWithMail("emptying", "emptying-sender@elsewhere.test", {
      type: "group",
      pendingPurge: "empty",
    });
    await mailboxWithMail("deleting", "deleting-sender@elsewhere.test", {
      type: "group",
      pendingPurge: "delete",
    });

    const addrs = await addresses();

    expect(addrs).toContain("team@example.com");
    for (const gone of ["svc", "emptying", "deleting"]) {
      expect(addrs).not.toContain(`${gone}@example.com`);
      expect(addrs).not.toContain(`${gone}-sender@elsewhere.test`);
    }
  });

  it("leaves out a shared mailbox the member may not read", async () => {
    const d = db();
    await grantMember(d, Perm.WRITE);
    const { messageId } = await seedThread(d, MAILBOX_ID);
    await d
      .update(message)
      .set({ fromAddr: "private@elsewhere.test" })
      .where(eq(message.id, messageId));

    expect(await addresses(mountApp(contactsRoutes, member))).toEqual([]);
  });

  it("includes a shared mailbox the member may read", async () => {
    await grantMember(db(), Perm.READ);
    expect(await addresses(mountApp(contactsRoutes, member))).toContain("team@example.com");
  });
});
