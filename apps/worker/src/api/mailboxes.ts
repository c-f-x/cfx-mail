import type { DB } from "@cfx-mail/db";
import {
  appPassword,
  contactKey,
  domain,
  mailbox,
  mailboxMember,
  message,
  thread,
  threadFolder,
  user,
} from "@cfx-mail/db/schema";
import { Flag } from "@cfx-mail/shared/flags";
import { grant, Perm } from "@cfx-mail/shared/permissions";
import type {
  ContactKeysDto,
  MailboxListDto,
  MailboxMembersDto,
  MailboxSettingsDto,
  PgpKeyResultDto,
} from "@cfx-mail/shared/responses";
import {
  addContactKey,
  createMailbox,
  grantMember,
  importPgpKey,
  type PgpMode,
  TEMP_TTL_DEFAULT_SECONDS,
  updateMailboxSettings,
  verifyContactKey,
} from "@cfx-mail/shared/schemas";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getOrCreatePgpMasterKey } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { isUniqueViolation, wrapUnique } from "../errors.ts";
import { ingestRaw, MAX_EMAIL_BYTES } from "../mail/ingest.ts";
import { bodyForIndex, parseMime } from "../mail/mime.ts";
import {
  generateKeypair,
  importPrivateKey,
  type MailboxKeyMaterial,
  readPublicKeyInfo,
  wrapSecret,
} from "../mail/pgp.ts";
import { authorizeMailboxCreate } from "../mailbox-access.ts";
import { markMailboxPurge } from "../mailbox-purge.ts";
import { requireUser } from "../middleware.ts";
import { listedMailboxes, mailboxNotPurging, requirePerm, resolveAccess } from "../permissions.ts";
import { zValidator } from "./validate.ts";

const TYPE_RANK: Record<string, number> = { personal: 0, group: 1, temp: 2 };

function compareMailboxes(
  a: { address: string; type: string },
  b: { address: string; type: string },
): number {
  const [aLocal = "", aDomain = ""] = a.address.toLowerCase().split("@");
  const [bLocal = "", bDomain = ""] = b.address.toLowerCase().split("@");
  if (aDomain !== bDomain) return aDomain < bDomain ? -1 : 1;
  const rank = (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9);
  if (rank !== 0) return rank;
  return aLocal < bLocal ? -1 : aLocal > bLocal ? 1 : 0;
}

export function mailboxesRoutes() {
  const r = new Hono<AppBindings>()

    .use("*", requireUser)

    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;

      // Which mailboxes the user sees, and with which bits, is permissions.ts's
      // call (owned + shared, no service mailboxes, none being deleted).
      const grants = await listedMailboxes(db, u.id);
      const rows = grants.length
        ? await db
            .select({
              id: mailbox.id,
              localPart: mailbox.localPart,
              displayName: mailbox.displayName,
              type: mailbox.type,
              expiresAt: mailbox.expiresAt,
              domainName: domain.name,
              pgpMode: mailbox.pgpMode,
              excludeFromAll: mailbox.excludeFromAll,
            })
            .from(mailbox)
            .innerJoin(domain, eq(mailbox.domainId, domain.id))
            .where(
              inArray(
                mailbox.id,
                grants.map((g) => g.mailboxId),
              ),
            )
            .limit(1000)
        : [];
      const byId = new Map(rows.map((m) => [m.id, m]));

      const all = grants.flatMap((g) => {
        const m = byId.get(g.mailboxId);
        if (!m) return [];
        return [
          {
            id: m.id,
            address: `${m.localPart}@${m.domainName}`,
            displayName: m.displayName,
            type: m.type,
            expiresAt: m.expiresAt,
            pgpMode: m.pgpMode,
            excludeFromAll: m.excludeFromAll,
            role: g.isOwner ? ("owner" as const) : ("member" as const),
            perms: g.perms,
          },
        ];
      });

      // A defined order, so the account switcher and the composer's default From
      // do not shift between requests: by domain, then personal before group
      // before temp, then by address. Case-insensitive.
      all.sort(compareMailboxes);

      // Unread badge per mailbox: active (non-trash/spam) threads with unread
      // inbound mail. `unreadCount > 0` already implies an unseen inbound message.
      // Threads the user filed into a custom folder are "moved away" and excluded.
      const ids = all.map((m) => m.id);
      const unreadRows = ids.length
        ? await db
            .select({ mailboxId: thread.mailboxId, c: count() })
            .from(thread)
            // Join the mailbox so an empty-pending one reads as zero unread at once.
            .innerJoin(mailbox, eq(thread.mailboxId, mailbox.id))
            .where(
              and(
                inArray(thread.mailboxId, ids),
                mailboxNotPurging,
                eq(thread.trashed, false),
                eq(thread.spam, false),
                gt(thread.unreadCount, 0),
                sql`not exists (select 1 from ${threadFolder} where ${threadFolder.threadId} = ${thread.id} and ${threadFolder.userId} = ${u.id})`,
              ),
            )
            .groupBy(thread.mailboxId)
        : [];
      const unreadMap = new Map(unreadRows.map((row) => [row.mailboxId, row.c]));

      return c.json({
        mailboxes: all.map((m) => ({
          ...m,
          expiresAt: m.expiresAt?.toISOString() ?? null,
          unread: unreadMap.get(m.id) ?? 0,
        })),
      } satisfies MailboxListDto);
    })

    .post("/", zValidator("json", createMailbox), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const body = c.req.valid("json");

      if (body.type === "service") {
        throw new HTTPException(400, { message: "service mailboxes are created from Admin" });
      }
      await authorizeMailboxCreate(db, u, body.domainId, body.type);

      const id = crypto.randomUUID();
      // A temp mailbox always expires, so the cron deletes it; no other kind does.
      const expiresAt =
        body.type === "temp"
          ? new Date(Date.now() + (body.ttlSeconds ?? TEMP_TTL_DEFAULT_SECONDS) * 1000)
          : null;

      await wrapUnique(
        () =>
          db.insert(mailbox).values({
            id,
            domainId: body.domainId,
            localPart: body.localPart.toLowerCase(),
            displayName: body.displayName ?? null,
            type: body.type,
            ownerUserId: u.id,
            signature: body.signature ?? null,
            replyTo: body.replyTo ?? null,
            expiresAt,
          }),
        "address already in use",
      );

      return c.json({ id }, 201);
    })

    .get("/:id/settings", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      await requirePerm(db, u.id, id, Perm.READ);
      const mb = await db.query.mailbox.findFirst({
        where: eq(mailbox.id, id),
        columns: {
          id: true,
          displayName: true,
          signature: true,
          replyTo: true,
          type: true,
          spamFilter: true,
          pgpMode: true,
          pgpFingerprint: true,
          pgpPublicKey: true,
          pgpAutoFetch: true,
          excludeFromAll: true,
        },
      });
      if (!mb) throw new HTTPException(404, { message: "not found" });
      return c.json({
        id: mb.id,
        type: mb.type,
        displayName: mb.displayName,
        signature: mb.signature,
        replyTo: mb.replyTo,
        spamFilter: mb.spamFilter,
        pgpMode: mb.pgpMode,
        pgpFingerprint: mb.pgpFingerprint,
        pgpPublicKey: mb.pgpPublicKey,
        pgpConfigured: Boolean(mb.pgpPublicKey),
        pgpAutoFetch: mb.pgpAutoFetch,
        excludeFromAll: mb.excludeFromAll,
      } satisfies MailboxSettingsDto);
    })

    .patch("/:id/settings", zValidator("json", updateMailboxSettings), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");
      await requirePerm(db, u.id, id, Perm.MANAGE);

      const mb = await db.query.mailbox.findFirst({
        where: eq(mailbox.id, id),
        columns: { type: true, pgpPublicKey: true },
      });
      if (!mb) throw new HTTPException(404, { message: "not found" });
      if (mb.type === "temp") {
        throw new HTTPException(400, { message: "temp mailboxes are not editable" });
      }

      // Spam filter level is admin-only (see /api/admin/mailboxes/:id/settings);
      // owners can edit identity fields but not the spam policy applied to their mailbox.
      const patch: Partial<{
        displayName: string | null;
        signature: string | null;
        replyTo: string | null;
        pgpMode: PgpMode;
        pgpAutoFetch: boolean;
        excludeFromAll: boolean;
      }> = {};
      if (body.displayName !== undefined) {
        // Trimmed, and empty means none, by the schema (senderName).
        patch.displayName = body.displayName;
      }
      if (body.signature !== undefined) {
        patch.signature = body.signature?.trim() ? body.signature : null;
      }
      if (body.replyTo !== undefined) {
        patch.replyTo = body.replyTo ? body.replyTo : null;
      }
      if (body.pgpMode !== undefined) {
        // Can't sign/encrypt without a keypair — make the owner add one first.
        if (body.pgpMode !== "off" && !mb.pgpPublicKey) {
          throw new HTTPException(400, { message: "generate or import a PGP key first" });
        }
        patch.pgpMode = body.pgpMode;
      }
      if (body.pgpAutoFetch !== undefined) {
        patch.pgpAutoFetch = body.pgpAutoFetch;
      }
      if (body.excludeFromAll !== undefined) {
        patch.excludeFromAll = body.excludeFromAll;
      }
      if (Object.keys(patch).length === 0) return c.json({ ok: true });

      await db.update(mailbox).set(patch).where(eq(mailbox.id, id));
      return c.json({ ok: true });
    })

    // ─── Gateway PGP key management (owner, Perm.MANAGE) ──────────────────────

    // Generate a fresh keypair for the mailbox. Returns the fingerprint + public
    // key once; the private key never leaves the server (wrapped at rest).
    .post("/:id/pgp/generate", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      const mb = await loadPgpTarget(db, id);
      const addr = `${mb.localPart}@${mb.domainName}`;
      const km = await generateKeypair(mb.displayName ?? addr, addr);
      await storeKeypair(db, id, km);
      return c.json({
        fingerprint: km.fingerprint,
        publicKey: km.publicArmored,
      } satisfies PgpKeyResultDto);
    })

    // Import an existing armored private key. Re-wrapped under our own passphrase.
    .post("/:id/pgp/import", zValidator("json", importPgpKey), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      await loadPgpTarget(db, id);
      let km: Awaited<ReturnType<typeof importPrivateKey>>;
      try {
        km = await importPrivateKey(body.privateKey, body.passphrase);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : "invalid private key",
        });
      }
      await storeKeypair(db, id, km);
      return c.json({
        fingerprint: km.fingerprint,
        publicKey: km.publicArmored,
      } satisfies PgpKeyResultDto);
    })

    // Remove the keypair and disable PGP.
    .delete("/:id/pgp", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      await db
        .update(mailbox)
        .set({
          pgpMode: "off",
          pgpPublicKey: null,
          pgpPrivateKeyWrapped: null,
          pgpPassphraseWrapped: null,
          pgpFingerprint: null,
        })
        .where(eq(mailbox.id, id));
      return c.json({ ok: true });
    })

    // ─── Contact (correspondent) public keys ──────────────────────────────────

    .get("/:id/contacts", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      await requirePerm(db, u.id, id, Perm.READ);
      const rows = await db.query.contactKey.findMany({
        where: eq(contactKey.mailboxId, id),
        columns: {
          id: true,
          email: true,
          fingerprint: true,
          source: true,
          verified: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      return c.json({
        keys: rows.map((row) => ({
          id: row.id,
          email: row.email,
          fingerprint: row.fingerprint,
          source: row.source,
          verified: row.verified,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
      } satisfies ContactKeysDto);
    })

    .post("/:id/contacts", zValidator("json", addContactKey), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      let info: Awaited<ReturnType<typeof readPublicKeyInfo>>;
      try {
        info = await readPublicKeyInfo(body.publicKey);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : "invalid public key",
        });
      }
      const email = (body.email ?? info.emails[0])?.toLowerCase();
      if (!email) throw new HTTPException(400, { message: "no email in key; provide one" });
      // An owner pasting a key is an explicit trust decision — mark it verified.
      const expiresAt = info.expiresAt ? new Date(info.expiresAt) : null;
      await db
        .insert(contactKey)
        .values({
          id: crypto.randomUUID(),
          mailboxId: id,
          email,
          publicKey: info.publicArmored,
          fingerprint: info.fingerprint,
          source: "import",
          verified: true,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [contactKey.mailboxId, contactKey.email],
          set: {
            publicKey: info.publicArmored,
            fingerprint: info.fingerprint,
            source: "import",
            verified: true,
            expiresAt,
          },
        });
      return c.json({ ok: true }, 201);
    })

    // Mark a contact key verified/unverified — the owner confirming a fingerprint
    // out-of-band. Lifts an auto-captured (tofu/wkd) key to fully trusted.
    .patch("/:id/contacts/:contactId", zValidator("json", verifyContactKey), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const contactId = c.req.param("contactId");
      const body = c.req.valid("json");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      await db
        .update(contactKey)
        .set({ verified: body.verified })
        .where(and(eq(contactKey.id, contactId), eq(contactKey.mailboxId, id)));
      return c.json({ ok: true });
    })

    .delete("/:id/contacts/:contactId", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const contactId = c.req.param("contactId");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      await db
        .delete(contactKey)
        .where(and(eq(contactKey.id, contactId), eq(contactKey.mailboxId, id)));
      return c.json({ ok: true });
    })

    // Import a single exported message (raw .eml bytes). The browser extracts
    // .eml/.mbox/.zip client-side and POSTs one message per request, which keeps
    // each call within Worker CPU/memory/body limits regardless of archive size.
    .post("/:id/import", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      await requirePerm(db, u.id, id, Perm.WRITE);

      const mb = await db.query.mailbox.findFirst({
        where: eq(mailbox.id, id),
        columns: { id: true, localPart: true, domainId: true, type: true },
      });
      if (!mb) throw new HTTPException(404, { message: "not found" });
      if (mb.type === "service") {
        throw new HTTPException(400, { message: "cannot import into a service mailbox" });
      }

      const raw = await c.req.raw.arrayBuffer();
      if (!raw.byteLength) throw new HTTPException(400, { message: "empty" });
      if (raw.byteLength > MAX_EMAIL_BYTES) throw new HTTPException(413, { message: "too large" });

      const parsed = await parseMime(raw);

      // Skip content-free fragments. An mbox split can emit stray separators or
      // truncated tails that parse into a message with no subject, no body, and no
      // attachments — importing those just litters the mailbox with blank rows.
      const isEmpty =
        !parsed.subject?.trim() &&
        !bodyForIndex(parsed.text, parsed.html).trim() &&
        !(parsed.attachments?.length ?? 0);
      if (isEmpty) return c.json({ skipped: true });

      // Dedup by Message-ID within this mailbox so re-importing is idempotent.
      if (parsed.messageId) {
        const dup = await db.query.message.findFirst({
          where: and(eq(message.mailboxId, id), eq(message.messageIdHdr, parsed.messageId)),
          columns: { id: true },
        });
        if (dup) return c.json({ duplicate: true });
      }

      const dom = await db.query.domain.findFirst({
        where: eq(domain.id, mb.domainId),
        columns: { name: true },
      });
      const ownAddr = dom ? `${mb.localPart}@${dom.name}`.toLowerCase() : "";
      const fromAddr = (parsed.from?.address ?? "").trim().toLowerCase();
      // Mail this mailbox sent is filed as outbound; everything else is inbound.
      const direction = fromAddr && fromAddr === ownAddr ? "out" : "in";

      const parsedDate = parsed.date ? new Date(parsed.date) : null;
      const when = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date();

      // Optional per-message state hints (e.g. a Proton export carries read/star
      // and folder placement in sidecar metadata). Absent for plain .eml/.mbox,
      // where mail defaults to read so it doesn't inflate badges.
      const seen = c.req.query("seen") !== "0";
      const starred = c.req.query("starred") === "1";
      const wantTrash = c.req.query("trashed") === "1";
      const wantSpam = c.req.query("spam") === "1" && !wantTrash;

      let flags = direction === "out" ? Flag.SENT : 0;
      if (seen) flags |= Flag.SEEN;
      if (starred) flags |= Flag.STARRED;

      let result: Awaited<ReturnType<typeof ingestRaw>>;
      try {
        result = await ingestRaw(c.env, db, {
          mailboxId: id,
          raw,
          parsed,
          direction,
          deliveredTo: direction === "in" ? ownAddr || null : null,
          flags,
          receivedAt: direction === "in" ? when : null,
          sentAt: direction === "out" ? when : null,
          spam: null,
        });
      } catch (err) {
        // Two imports of one message that arrive together both pass the lookup
        // above. A unique index lets one in, and ingestRaw has undone the
        // other. Look again, so no other failure passes for a duplicate.
        if (parsed.messageId && isUniqueViolation(err)) {
          const dup = await db.query.message.findFirst({
            where: and(eq(message.mailboxId, id), eq(message.messageIdHdr, parsed.messageId)),
            columns: { id: true },
          });
          if (dup) return c.json({ duplicate: true });
        }
        throw err;
      }

      // Trash and spam are thread-level, mutually-exclusive buckets (see threads.ts).
      if (wantTrash || wantSpam) {
        await db
          .update(thread)
          .set({ trashed: wantTrash, trashedAt: wantTrash ? when : null, spam: wantSpam })
          .where(eq(thread.id, result.threadId));
      }

      return c.json({ messageId: result.messageId, threadId: result.threadId, duplicate: false });
    })

    .delete("/:id", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      // Owner only by design: no member bit, MANAGE included, may delete a mailbox.
      const access = await resolveAccess(db, u.id, id);
      if (!access) throw new HTTPException(404, { message: "not found" });
      if (!access.isOwner) throw new HTTPException(403, { message: "owner only" });
      // A mailbox others use is not one person's to delete: only an admin may.
      const shared = await db.query.mailboxMember.findFirst({
        where: eq(mailboxMember.mailboxId, id),
        columns: { userId: true },
      });
      if (shared) {
        const me = await db.query.user.findFirst({
          where: eq(user.id, u.id),
          columns: { role: true },
        });
        if (me?.role !== "admin") {
          throw new HTTPException(409, {
            message: "This mailbox is shared with others. Ask an admin to delete it.",
          });
        }
      }
      // Mark for background purge; the cron drains threads/blobs, then drops the
      // row. The mailbox reads as gone immediately (mailboxNotDeletePending).
      await markMailboxPurge(db, id, "delete");
      return c.body(null, 204);
    })

    .get("/:id/members", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      const rows = await db
        .select({
          userId: mailboxMember.userId,
          perms: mailboxMember.perms,
          email: user.email,
          name: user.name,
        })
        .from(mailboxMember)
        .innerJoin(user, eq(user.id, mailboxMember.userId))
        .where(eq(mailboxMember.mailboxId, id));
      return c.json({ members: rows } satisfies MailboxMembersDto);
    })

    .post("/:id/members", zValidator("json", grantMember), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");
      await requirePerm(db, u.id, id, Perm.MANAGE);

      let perms = 0;
      if (body.read) perms = grant(perms, Perm.READ);
      if (body.write) perms = grant(perms, Perm.WRITE);
      if (body.manage) perms = grant(perms, Perm.MANAGE);

      const found = await db.query.user.findFirst({
        where: eq(user.id, body.userId),
        columns: { id: true },
      });
      if (!found) throw new HTTPException(404, { message: "user not found" });

      await db
        .insert(mailboxMember)
        .values({ mailboxId: id, userId: found.id, perms })
        .onConflictDoUpdate({
          target: [mailboxMember.mailboxId, mailboxMember.userId],
          set: { perms },
        });
      return c.json({ ok: true, userId: found.id });
    })

    .delete("/:id/members/:userId", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const uid = c.req.param("userId");
      await requirePerm(db, u.id, id, Perm.MANAGE);
      // Their app passwords for this mailbox go with the membership.
      await db.batch([
        db
          .delete(mailboxMember)
          .where(and(eq(mailboxMember.mailboxId, id), eq(mailboxMember.userId, uid))),
        db
          .delete(appPassword)
          .where(and(eq(appPassword.mailboxId, id), eq(appPassword.userId, uid))),
      ]);
      return c.body(null, 204);
    });

  return r;
}

// Load a mailbox for PGP key ops and resolve its full address. Rejects temp
// mailboxes (no durable identity to bind a key to).
async function loadPgpTarget(db: DB, id: string) {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, id),
    columns: { id: true, localPart: true, domainId: true, displayName: true, type: true },
  });
  if (!mb) throw new HTTPException(404, { message: "not found" });
  if (mb.type === "temp") throw new HTTPException(400, { message: "temp mailboxes can't use PGP" });
  const dom = await db.query.domain.findFirst({
    where: eq(domain.id, mb.domainId),
    columns: { name: true },
  });
  if (!dom) throw new HTTPException(500, { message: "domain missing" });
  return { ...mb, domainName: dom.name };
}

// Wrap the private key + passphrase under the master key and persist. The public
// key + fingerprint are stored in the clear (they're public).
async function storeKeypair(db: DB, id: string, km: MailboxKeyMaterial): Promise<void> {
  const masterKey = await getOrCreatePgpMasterKey(db);
  const [privateKeyWrapped, passphraseWrapped] = await Promise.all([
    wrapSecret(masterKey, km.privateArmored),
    wrapSecret(masterKey, km.passphrase),
  ]);
  await db
    .update(mailbox)
    .set({
      pgpPublicKey: km.publicArmored,
      pgpPrivateKeyWrapped: privateKeyWrapped,
      pgpPassphraseWrapped: passphraseWrapped,
      pgpFingerprint: km.fingerprint,
    })
    .where(eq(mailbox.id, id));
}
