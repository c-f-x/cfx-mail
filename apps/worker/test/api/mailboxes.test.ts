import { appPassword, contactKey, domain, mailbox, mailboxMember } from "@cfx-mail/db/schema";
import { MailboxKind, Perm } from "@cfx-mail/shared/permissions";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mailboxesRoutes } from "../../src/api/mailboxes.ts";
import { generateKeypair } from "../../src/mail/pgp.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  ADMIN_ID,
  admin,
  DOMAIN_ID,
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  OUTSIDER_ID,
  OWNER_ID,
  outsider,
  owner,
  seedBase,
  seedContactKey,
} from "../support/seed.ts";

const asOwner = () => mountApp(mailboxesRoutes, owner);
const asMember = () => mountApp(mailboxesRoutes, member);
const asOutsider = () => mountApp(mailboxesRoutes, outsider);
const asAdmin = () => mountApp(mailboxesRoutes, admin);
const asAnon = () => mountApp(mailboxesRoutes, null);

// ── Local seed helpers (kept in-file per harness convention) ────────────────

const SERVICE_MAILBOX_ID = "mailbox-service";
const TEMP_MAILBOX_ID = "mailbox-temp";

async function insertMailbox(
  id: string,
  overrides: Partial<typeof mailbox.$inferInsert> = {},
): Promise<void> {
  await db()
    .insert(mailbox)
    .values({
      id,
      domainId: DOMAIN_ID,
      localPart: id,
      type: "group",
      ownerUserId: OWNER_ID,
      ...overrides,
    });
}

async function setDomainKinds(kinds: number): Promise<void> {
  await db().update(domain).set({ allowedKinds: kinds }).where(eq(domain.id, DOMAIN_ID));
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("GET /", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("lists owned mailboxes with owner role and full perms", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailboxes: { id: string; role: string; perms: number; address: string }[];
    };
    expect(body.mailboxes).toHaveLength(2);
    for (const m of body.mailboxes) {
      expect(m.role).toBe("owner");
      expect(m.perms).toBe(7);
    }
    expect(body.mailboxes.map((m) => m.address)).toContain("team@example.com");
  });

  it("orders the list by domain, then personal before group before temp, then address", async () => {
    await db().insert(domain).values({ id: "domain-a", name: "alpha.example" });
    await db().delete(mailbox);
    // Inserted out of order on purpose: the order must not depend on it.
    await insertMailbox("m1", { localPart: "zoe", type: "group" });
    await insertMailbox("m2", { localPart: "t-1", type: "temp", domainId: "domain-a" });
    await insertMailbox("m3", { localPart: "bob", type: "personal" });
    await insertMailbox("m4", { localPart: "team", type: "group", domainId: "domain-a" });
    await insertMailbox("m5", { localPart: "amy", type: "group" });
    await insertMailbox("m6", { localPart: "Zed", type: "personal", domainId: "domain-a" });
    await insertMailbox("m7", { localPart: "ann", type: "personal", domainId: "domain-a" });

    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as { mailboxes: { address: string }[] };
    expect(body.mailboxes.map((m) => m.address)).toEqual([
      "ann@alpha.example",
      "Zed@alpha.example",
      "team@alpha.example",
      "t-1@alpha.example",
      "bob@example.com",
      "amy@example.com",
      "zoe@example.com",
    ]);
  });

  it("shows a shared mailbox with member role and granted perms", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "GET", "/");
    const body = (await res.json()) as { mailboxes: { id: string; role: string; perms: number }[] };
    expect(body.mailboxes).toHaveLength(1);
    expect(body.mailboxes[0]).toMatchObject({ id: MAILBOX_ID, role: "member", perms: Perm.READ });
  });

  it("hides service mailboxes from the listing", async () => {
    await insertMailbox(SERVICE_MAILBOX_ID, { type: "service" });
    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as { mailboxes: { id: string }[] };
    expect(body.mailboxes.map((m) => m.id)).not.toContain(SERVICE_MAILBOX_ID);
  });

  it("lists a mailbox being emptied and hides one being deleted", async () => {
    await db().update(mailbox).set({ pendingPurge: "empty" }).where(eq(mailbox.id, MAILBOX_ID));
    await db()
      .update(mailbox)
      .set({ pendingPurge: "delete" })
      .where(eq(mailbox.id, OTHER_MAILBOX_ID));
    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as { mailboxes: { id: string; unread: number }[] };
    expect(body.mailboxes).toEqual([expect.objectContaining({ id: MAILBOX_ID, unread: 0 })]);
  });

  it("returns an empty list for a user with no mailboxes", async () => {
    const res = await request(asOutsider(), "GET", "/");
    const body = (await res.json()) as { mailboxes: unknown[] };
    expect(body.mailboxes).toHaveLength(0);
  });
});

describe("POST /", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", "/", {});
    expect(res.status).toBe(401);
  });

  it("400s an invalid body (bad local part)", async () => {
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "bad+part",
      type: "personal",
    });
    expect(res.status).toBe(400);
  });

  it("400s creating a service mailbox (admin-only path)", async () => {
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "svc",
      type: "service",
    });
    expect(res.status).toBe(400);
  });

  it("400s when the domain does not allow the kind", async () => {
    // allowedKinds defaults to 0 → no kind permitted.
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "nope",
      type: "personal",
    });
    expect(res.status).toBe(400);
  });

  it("403s a non-admin without a domain grant", async () => {
    await setDomainKinds(MailboxKind.PERSONAL);
    const res = await request(asOutsider(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "mine",
      type: "personal",
    });
    expect(res.status).toBe(403);
  });

  // A temp mailbox always deletes itself: an hour after creation unless asked
  // otherwise, and never later than 7 days, the same rule as POST /api/temp.
  // Other kinds never expire.
  it.each([
    ["no expiry asked for", undefined, 3600],
    ["a 6-hour expiry", 6 * 3600, 6 * 3600],
    ["the 7-day maximum", 7 * 24 * 3600, 7 * 24 * 3600],
  ])("gives a temp mailbox an expiry with %s", async (_, ttlSeconds, expected) => {
    await setDomainKinds(MailboxKind.TEMP);
    const before = Date.now();
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "throwaway",
      type: "temp",
      ...(ttlSeconds ? { ttlSeconds } : {}),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, id) });
    const seconds = ((row?.expiresAt?.getTime() ?? 0) - before) / 1000;
    expect(seconds).toBeGreaterThan(expected - 60);
    expect(seconds).toBeLessThanOrEqual(expected + 60);
  });

  it("refuses a temp mailbox that would live longer than 7 days", async () => {
    await setDomainKinds(MailboxKind.TEMP);
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "too-long",
      type: "temp",
      ttlSeconds: 30 * 24 * 3600,
    });
    expect(res.status).toBe(400);
  });

  it("gives a personal mailbox no expiry, even when one is sent", async () => {
    await setDomainKinds(MailboxKind.PERSONAL);
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "keeper",
      type: "personal",
      ttlSeconds: 3600,
    });
    const { id } = (await res.json()) as { id: string };
    expect(
      (await db().query.mailbox.findFirst({ where: eq(mailbox.id, id) }))?.expiresAt,
    ).toBeNull();
  });

  it("answers 409 for an address that is already in use", async () => {
    await setDomainKinds(MailboxKind.PERSONAL);
    const body = { domainId: DOMAIN_ID, localPart: "twice", type: "personal" };
    expect((await request(asAdmin(), "POST", "/", body)).status).toBe(201);

    const again = await request(asAdmin(), "POST", "/", body);

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "address already in use" });
  });

  it("creates a mailbox as admin when the domain allows the kind", async () => {
    await setDomainKinds(MailboxKind.PERSONAL);
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "MixedCase",
      type: "personal",
      displayName: "Mine",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, id) });
    expect(row?.localPart).toBe("mixedcase"); // lowercased
    expect(row?.ownerUserId).toBe(ADMIN_ID);
  });
});

describe("GET /:id/settings", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(401);
  });

  it("403s an outsider", async () => {
    const res = await request(asOutsider(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(403);
  });

  it("403s a missing mailbox (requirePerm runs before the row lookup)", async () => {
    const res = await request(asOwner(), "GET", "/does-not-exist/settings");
    expect(res.status).toBe(403);
  });

  it("returns settings to the owner and never leaks the private key", async () => {
    await db()
      .update(mailbox)
      .set({ pgpPublicKey: "PUB", pgpPrivateKeyWrapped: "SECRET", pgpFingerprint: "FPR" })
      .where(eq(mailbox.id, MAILBOX_ID));
    const res = await request(asOwner(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("Wrapped");
    const body = JSON.parse(text) as { pgpConfigured: boolean; pgpPublicKey: string };
    expect(body.pgpConfigured).toBe(true);
    expect(body.pgpPublicKey).toBe("PUB");
  });

  it("lets a member with READ view settings", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(200);
  });
});

describe("PATCH /:id/settings", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "PATCH", `/${MAILBOX_ID}/settings`, { displayName: "x" });
    expect(res.status).toBe(401);
  });

  it("400s an invalid body (bad spam filter level)", async () => {
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/settings`, {
      spamFilter: "loud",
    });
    expect(res.status).toBe(400);
  });

  it("403s a member with READ only", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "PATCH", `/${MAILBOX_ID}/settings`, { displayName: "x" });
    expect(res.status).toBe(403);
  });

  it("updates identity fields for a member with MANAGE", async () => {
    await grantMember(db(), Perm.READ | Perm.MANAGE);
    const res = await request(asMember(), "PATCH", `/${MAILBOX_ID}/settings`, {
      displayName: "  Team Inbox  ",
    });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.displayName).toBe("Team Inbox"); // trimmed
  });

  it("400s a temp mailbox", async () => {
    await insertMailbox(TEMP_MAILBOX_ID, { type: "temp" });
    const res = await request(asOwner(), "PATCH", `/${TEMP_MAILBOX_ID}/settings`, {
      displayName: "x",
    });
    expect(res.status).toBe(400);
  });

  it("400s enabling a pgp mode without a keypair", async () => {
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/settings`, { pgpMode: "sign" });
    expect(res.status).toBe(400);
  });

  it("allows a pgp mode once a key exists", async () => {
    await db().update(mailbox).set({ pgpPublicKey: "PUB" }).where(eq(mailbox.id, MAILBOX_ID));
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/settings`, { pgpMode: "sign" });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pgpMode).toBe("sign");
  });
});

describe("PGP key management", () => {
  it("401s generate for an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", `/${MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(401);
  });

  it("403s generate for a member without MANAGE", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(403);
  });

  it("400s generate on a temp mailbox", async () => {
    await insertMailbox(TEMP_MAILBOX_ID, { type: "temp" });
    const res = await request(asOwner(), "POST", `/${TEMP_MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(400);
  });

  it("generates a keypair, persists it wrapped, and returns only public material", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { fingerprint: string; publicKey: string };
    expect(body.fingerprint.length).toBeGreaterThan(0);
    expect(body.publicKey).toContain("BEGIN PGP PUBLIC KEY");
    expect(text).not.toContain("PRIVATE KEY");

    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pgpPublicKey).toBeTruthy();
    expect(row?.pgpPrivateKeyWrapped).toBeTruthy();
    expect(row?.pgpPassphraseWrapped).toBeTruthy();
    expect(row?.pgpFingerprint).toBe(body.fingerprint);
  });

  it("400s import of an invalid private key", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/pgp/import`, {
      privateKey: "not a real key",
    });
    expect(res.status).toBe(400);
  });

  it("400s import with a missing body", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/pgp/import`, {});
    expect(res.status).toBe(400);
  });

  it("403s import for a member without MANAGE", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/pgp/import`, {
      privateKey: "x",
    });
    expect(res.status).toBe(403);
  });

  it("deletes the keypair and disables pgp", async () => {
    await db()
      .update(mailbox)
      .set({
        pgpMode: "sign",
        pgpPublicKey: "PUB",
        pgpPrivateKeyWrapped: "SECRET",
        pgpFingerprint: "FPR",
      })
      .where(eq(mailbox.id, MAILBOX_ID));
    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/pgp`);
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pgpMode).toBe("off");
    expect(row?.pgpPublicKey).toBeNull();
    expect(row?.pgpPrivateKeyWrapped).toBeNull();
    expect(row?.pgpFingerprint).toBeNull();
  });

  it("403s delete for a member without MANAGE", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}/pgp`);
    expect(res.status).toBe(403);
  });
});

describe("contact keys", () => {
  it("401s listing for an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", `/${MAILBOX_ID}/contacts`);
    expect(res.status).toBe(401);
  });

  it("403s an outsider listing", async () => {
    const res = await request(asOutsider(), "GET", `/${MAILBOX_ID}/contacts`);
    expect(res.status).toBe(403);
  });

  it("lists contact keys for a member with READ", async () => {
    await grantMember(db(), Perm.READ);
    await seedContactKey(db(), MAILBOX_ID, "alice@elsewhere.test");
    const res = await request(asMember(), "GET", `/${MAILBOX_ID}/contacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { email: string; fingerprint: string }[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.email).toBe("alice@elsewhere.test");
  });

  it("400s adding an invalid public key", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/contacts`, {
      publicKey: "garbage",
    });
    expect(res.status).toBe(400);
  });

  it("400s adding with no public key (validator)", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/contacts`, {});
    expect(res.status).toBe(400);
  });

  it("403s a member without MANAGE adding a key", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/contacts`, { publicKey: "x" });
    expect(res.status).toBe(403);
  });

  it("adds a contact key from valid armored material", async () => {
    const km = await generateKeypair("Contact", "contact@elsewhere.test");
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/contacts`, {
      publicKey: km.publicArmored,
    });
    expect(res.status).toBe(201);
    const row = await db().query.contactKey.findFirst({
      where: eq(contactKey.mailboxId, MAILBOX_ID),
    });
    expect(row?.email).toBe("contact@elsewhere.test");
    expect(row?.verified).toBe(true);
    expect(row?.source).toBe("import");
  });

  it("verifies and unverifies a contact key", async () => {
    const id = await seedContactKey(db(), MAILBOX_ID, "bob@elsewhere.test", { verified: false });
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/contacts/${id}`, {
      verified: true,
    });
    expect(res.status).toBe(200);
    const row = await db().query.contactKey.findFirst({ where: eq(contactKey.id, id) });
    expect(row?.verified).toBe(true);
  });

  it("400s verify with a bad body", async () => {
    const id = await seedContactKey(db(), MAILBOX_ID, "carol@elsewhere.test");
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/contacts/${id}`, {
      verified: "yes",
    });
    expect(res.status).toBe(400);
  });

  it("403s a member without MANAGE verifying", async () => {
    await grantMember(db(), Perm.READ);
    const id = await seedContactKey(db(), MAILBOX_ID, "dan@elsewhere.test");
    const res = await request(asMember(), "PATCH", `/${MAILBOX_ID}/contacts/${id}`, {
      verified: true,
    });
    expect(res.status).toBe(403);
  });

  it("deletes a contact key", async () => {
    const id = await seedContactKey(db(), MAILBOX_ID, "erin@elsewhere.test");
    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/contacts/${id}`);
    expect(res.status).toBe(200);
    const row = await db().query.contactKey.findFirst({ where: eq(contactKey.id, id) });
    expect(row).toBeUndefined();
  });

  it("403s a member without MANAGE deleting", async () => {
    await grantMember(db(), Perm.READ);
    const id = await seedContactKey(db(), MAILBOX_ID, "fred@elsewhere.test");
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}/contacts/${id}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /:id/import", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", `/${MAILBOX_ID}/import`, "raw");
    expect(res.status).toBe(401);
  });

  it("403s a member with READ only (needs WRITE)", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/import`, "raw");
    expect(res.status).toBe(403);
  });

  it("400s an empty body", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/import`);
    expect(res.status).toBe(400);
  });

  it("400s importing into a service mailbox", async () => {
    await insertMailbox(SERVICE_MAILBOX_ID, { type: "service" });
    const res = await request(asOwner(), "POST", `/${SERVICE_MAILBOX_ID}/import`, "raw bytes");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /:id", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "DELETE", `/${MAILBOX_ID}`);
    expect(res.status).toBe(401);
  });

  it("404s a missing mailbox", async () => {
    const res = await request(asOwner(), "DELETE", "/does-not-exist");
    expect(res.status).toBe(404);
  });

  // The same answer as a missing mailbox, so a stranger learns nothing.
  it("404s a stranger", async () => {
    const res = await request(asOutsider(), "DELETE", `/${MAILBOX_ID}`);
    expect(res.status).toBe(404);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pendingPurge).toBeNull();
  });

  it("403s a member with MANAGE (owner-only route)", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE | Perm.MANAGE);
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}`);
    expect(res.status).toBe(403);
  });

  it("lets the owner delete their mailbox (marked for background purge)", async () => {
    const res = await request(asOwner(), "DELETE", `/${OTHER_MAILBOX_ID}`);
    expect(res.status).toBe(204);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, OTHER_MAILBOX_ID) });
    expect(row?.pendingPurge).toBe("delete");
  });
});

describe("members", () => {
  it("401s listing members for an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", `/${MAILBOX_ID}/members`);
    expect(res.status).toBe(401);
  });

  it("403s a member with READ listing members (needs MANAGE)", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "GET", `/${MAILBOX_ID}/members`);
    expect(res.status).toBe(403);
  });

  it("lists members for the owner", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asOwner(), "GET", `/${MAILBOX_ID}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { userId: string; email: string }[] };
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({ userId: member.id, email: member.email });
  });

  it("removing a member also removes their app passwords for that mailbox only", async () => {
    await grantMember(db(), Perm.READ);
    await grantMember(db(), Perm.READ, OTHER_MAILBOX_ID);
    await db()
      .insert(appPassword)
      .values([
        { id: "ap-here", userId: member.id, mailboxId: MAILBOX_ID, name: "phone", hash: "h1" },
        {
          id: "ap-other",
          userId: member.id,
          mailboxId: OTHER_MAILBOX_ID,
          name: "phone",
          hash: "h2",
        },
        { id: "ap-owner", userId: owner.id, mailboxId: MAILBOX_ID, name: "laptop", hash: "h3" },
      ]);

    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/members/${member.id}`);

    expect(res.status).toBe(204);
    const left = await db().select({ id: appPassword.id }).from(appPassword);
    expect(left.map((r) => r.id).sort()).toEqual(["ap-other", "ap-owner"]);
  });

  it("400s granting with a missing body field", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
    });
    expect(res.status).toBe(400);
  });

  it("404s granting to an unknown user", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
      userId: "ghost",
      read: true,
    });
    expect(res.status).toBe(404);
  });

  it("403s a member without MANAGE granting", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
      userId: OUTSIDER_ID,
      read: true,
    });
    expect(res.status).toBe(403);
  });

  it("grants a member with the requested perms", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
      userId: OUTSIDER_ID,
      read: true,
      write: true,
    });
    expect(res.status).toBe(200);
    const row = await db().query.mailboxMember.findFirst({
      where: and(eq(mailboxMember.mailboxId, MAILBOX_ID), eq(mailboxMember.userId, OUTSIDER_ID)),
    });
    expect(row?.perms).toBe(Perm.READ | Perm.WRITE);
  });

  it("removes a member", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/members/${member.id}`);
    expect(res.status).toBe(204);
    const row = await db().query.mailboxMember.findFirst({
      where: and(eq(mailboxMember.mailboxId, MAILBOX_ID), eq(mailboxMember.userId, member.id)),
    });
    expect(row).toBeUndefined();
  });

  it("403s a member without MANAGE removing", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}/members/${OUTSIDER_ID}`);
    expect(res.status).toBe(403);
  });
});
