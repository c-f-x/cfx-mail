import {
  appPassword,
  domain,
  domainGrant,
  mailbox,
  mailboxMember,
  session,
  user,
  userInvite,
} from "@cfx-mail/db/schema";
import {
  acceptInvite,
  adminCreateUser,
  adminUpdateUser,
  createUserInvite,
  deleteUser,
  upsertDomainGrant,
} from "@cfx-mail/shared/schemas";
import { and, asc, count, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { BAN_REASON_PENDING_DELETE } from "../auth.ts";
import { getConfig } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { randomToken } from "../lib/encoding.ts";
import { sendMail } from "../mail/notify.ts";
import { handOverMailbox } from "../mailbox-owner.ts";
import { markMailboxPurge } from "../mailbox-purge.ts";
import { requireAdmin, requireUser } from "../middleware.ts";
import { mailboxNotPurging } from "../permissions.ts";
import { clientIp, enforceRateLimit } from "../rate-limit.ts";
import { createUserWithPassword } from "./bootstrap.ts";
import { zValidator } from "./validate.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const notPendingDelete = or(isNull(user.banReason), ne(user.banReason, BAN_REASON_PENDING_DELETE));

export function usersRoutes() {
  const r = new Hono<AppBindings>()

    // Public invite acceptance — token-gated, no session required.
    .post("/invites/accept", zValidator("json", acceptInvite), async (c) => {
      const db = dbFromCtx(c);
      const body = c.req.valid("json");

      // Unauthenticated + creates accounts — throttle token guessing per IP.
      await enforceRateLimit(db, "invite-accept", clientIp(c.req.raw.headers), 10, 60_000);

      const inv = await db.query.userInvite.findFirst({
        where: eq(userInvite.token, body.token),
      });
      if (!inv) throw new HTTPException(404, { message: "invite not found" });
      if (inv.usedAt) throw new HTTPException(410, { message: "invite already used" });
      if (inv.expiresAt.getTime() < Date.now()) {
        throw new HTTPException(410, { message: "invite expired" });
      }

      await createUserWithPassword(db, {
        email: inv.email,
        name: body.name,
        password: body.password,
        role: inv.role,
      });
      await db.update(userInvite).set({ usedAt: new Date() }).where(eq(userInvite.id, inv.id));

      return c.json({ ok: true });
    })

    // Look up an invite by token without consuming it — for the accept page.
    .get("/invites/by-token/:token", async (c) => {
      const db = dbFromCtx(c);
      const token = c.req.param("token");
      const inv = await db.query.userInvite.findFirst({
        where: eq(userInvite.token, token),
        columns: { email: true, role: true, usedAt: true, expiresAt: true },
      });
      if (!inv) throw new HTTPException(404, { message: "invite not found" });
      return c.json({
        email: inv.email,
        role: inv.role,
        used: !!inv.usedAt,
        expired: inv.expiresAt.getTime() < Date.now(),
      });
    })

    // Minimal user directory for member selection — any signed-in user, no admin.
    // Used by the group-mailbox members panel to pick existing accounts.
    .get("/directory", requireUser, async (c) => {
      const db = dbFromCtx(c);
      const rows = await db
        .select({ id: user.id, email: user.email, name: user.name })
        .from(user)
        .where(eq(user.banned, false))
        .orderBy(asc(user.email))
        .limit(1000);
      return c.json({ users: rows });
    })

    // Everything below requires admin.
    .use("*", requireUser, requireAdmin)

    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const rows = await db
        .select({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          banned: user.banned,
          createdAt: user.createdAt,
        })
        .from(user)
        .where(notPendingDelete)
        .orderBy(asc(user.createdAt))
        .limit(1000);
      return c.json({ users: rows });
    })

    .post("/", zValidator("json", adminCreateUser), async (c) => {
      const db = dbFromCtx(c);
      const body = c.req.valid("json");
      const created = await createUserWithPassword(db, {
        email: body.email,
        name: body.name,
        password: body.password,
        role: body.role,
      });
      return c.json({ id: created.id }, 201);
    })

    .patch("/:id", zValidator("json", adminUpdateUser), async (c) => {
      const db = dbFromCtx(c);
      const me = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");

      if (id === me.id && body.role && body.role !== "admin") {
        throw new HTTPException(400, { message: "cannot demote yourself" });
      }

      const patch: Partial<{ role: "admin" | "user"; banned: boolean }> = {};
      if (body.role !== undefined) patch.role = body.role;
      if (body.banned !== undefined) patch.banned = body.banned;
      if (Object.keys(patch).length === 0) return c.json({ ok: true });

      // A deleted user's mail is already being destroyed, so their ban is final.
      const update = db
        .update(user)
        .set({ ...patch, updatedAt: new Date() })
        .where(patch.banned === false ? and(eq(user.id, id), notPendingDelete) : eq(user.id, id));
      // A ban is a revocation, not a flag: the user's sessions and app passwords
      // go in the same batch, so nothing they already hold keeps working.
      const [res] = patch.banned
        ? await db.batch([
            update,
            db.delete(session).where(eq(session.userId, id)),
            db.delete(appPassword).where(eq(appPassword.userId, id)),
          ])
        : [await update];
      if (res.meta.changes === 0) {
        const row = await db.query.user.findFirst({
          where: eq(user.id, id),
          columns: { id: true },
        });
        if (!row) throw new HTTPException(404, { message: "not found" });
        throw new HTTPException(409, { message: "This user is being deleted." });
      }
      return c.json({ ok: true });
    })

    // The mailboxes a user owns, for the delete dialog: the admin ticks which
    // go with the user. `sharedWith` counts the other people who use each one.
    .get("/:id/mailboxes", async (c) => {
      const db = dbFromCtx(c);
      const id = c.req.param("id");
      const rows = await db
        .select({
          id: mailbox.id,
          localPart: mailbox.localPart,
          domainName: domain.name,
          type: mailbox.type,
        })
        .from(mailbox)
        .innerJoin(domain, eq(domain.id, mailbox.domainId))
        .where(and(eq(mailbox.ownerUserId, id), mailboxNotPurging))
        .orderBy(asc(domain.name), asc(mailbox.localPart));
      const shared = rows.length
        ? await db
            .select({ mailboxId: mailboxMember.mailboxId, n: count() })
            .from(mailboxMember)
            .where(
              inArray(
                mailboxMember.mailboxId,
                rows.map((r) => r.id),
              ),
            )
            .groupBy(mailboxMember.mailboxId)
        : [];
      const sharedWith = new Map(shared.map((s) => [s.mailboxId, s.n]));
      return c.json({
        mailboxes: rows.map((r) => ({
          id: r.id,
          address: `${r.localPart}@${r.domainName}`,
          type: r.type,
          sharedWith: sharedWith.get(r.id) ?? 0,
        })),
      });
    })

    // Deleting is staged. The mailboxes the admin ticked are marked for the
    // background purge; every other mailbox the user owns is handed to the
    // admin, mail and members intact. Their access ends at once; the cron
    // drops the user row once the ticked mailboxes are gone
    // (deletePurgedUsers). Deleting the row here would cascade through all
    // their mail in one statement and strand its blobs.
    .delete("/:id", zValidator("json", deleteUser), async (c) => {
      const db = dbFromCtx(c);
      const me = c.get("user")!;
      const id = c.req.param("id");
      const { deleteMailboxIds } = c.req.valid("json");
      if (id === me.id) throw new HTTPException(400, { message: "cannot delete yourself" });
      const row = await db.query.user.findFirst({ where: eq(user.id, id), columns: { id: true } });
      if (!row) throw new HTTPException(404, { message: "not found" });
      const owned = await db
        .select({ id: mailbox.id, pendingPurge: mailbox.pendingPurge })
        .from(mailbox)
        .where(eq(mailbox.ownerUserId, id));
      const ownedIds = new Set(owned.map((mb) => mb.id));
      if (deleteMailboxIds.some((mbId) => !ownedIds.has(mbId))) {
        throw new HTTPException(400, {
          message: "Only mailboxes this user owns can go with them.",
        });
      }
      const toDelete = new Set(deleteMailboxIds);
      // Mailboxes first: if a step fails, the user is still listed and the
      // admin can delete again. The other order could hide a half-deleted user.
      // A mailbox already being purged stays on that path.
      await Promise.all(
        owned.map((mb) =>
          toDelete.has(mb.id) || mb.pendingPurge
            ? markMailboxPurge(db, mb.id, "delete")
            : handOverMailbox(db, mb.id, id, me.id),
        ),
      );
      await db.batch([
        db
          .update(user)
          .set({
            banned: true,
            banReason: BAN_REASON_PENDING_DELETE,
            banExpires: null,
            updatedAt: new Date(),
          })
          .where(eq(user.id, id)),
        db.delete(session).where(eq(session.userId, id)),
        db.delete(appPassword).where(eq(appPassword.userId, id)),
      ]);
      return c.body(null, 204);
    })

    .get("/invites", async (c) => {
      const db = dbFromCtx(c);
      const rows = await db
        .select()
        .from(userInvite)
        .orderBy(asc(userInvite.createdAt))
        .limit(1000);
      // Each invite's link, so the admin can pass it on again by hand.
      const baseUrl = c.get("baseUrl");
      return c.json({
        invites: rows.map(({ token, ...row }) => ({ ...row, url: inviteUrl(baseUrl, token) })),
      });
    })

    .post("/invites", zValidator("json", createUserInvite), async (c) => {
      const db = dbFromCtx(c);
      const me = c.get("user")!;
      const body = c.req.valid("json");
      const email = body.email.toLowerCase();

      const existingUser = await db.query.user.findFirst({
        where: eq(user.email, email),
        columns: { id: true },
      });
      if (existingUser) throw new HTTPException(409, { message: "user exists" });

      const token = randomToken(32);
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

      await db
        .insert(userInvite)
        .values({
          id,
          email,
          role: body.role,
          token,
          invitedByUserId: me.id,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: userInvite.email,
          set: { token, role: body.role, invitedByUserId: me.id, expiresAt, usedAt: null },
        });

      const baseUrl = c.get("baseUrl");
      const url = inviteUrl(baseUrl, token);
      const from = await getConfig(db, "auth_from_address");
      // sentEmail tells the admin whether to share the link by hand, so it must
      // say whether the send worked, and notSentReason why not.
      const sentEmail = from
        ? await sendMail(c.env, {
            from,
            to: email,
            subject: "You've been invited",
            text: `You've been invited to join. Set your password:\n\n${url}\n\nThis link expires in 7 days.`,
          })
        : false;
      const notSentReason: "no_sender" | "send_failed" | null = sentEmail
        ? null
        : from
          ? "send_failed"
          : "no_sender";

      return c.json({ ok: true, id, url, sentEmail, notSentReason }, 201);
    })

    .delete("/invites/:id", async (c) => {
      const db = dbFromCtx(c);
      const id = c.req.param("id");
      const res = await db.delete(userInvite).where(eq(userInvite.id, id));
      if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
      return c.body(null, 204);
    })

    // Per-user domain grants — controls which mailbox kinds a user may create
    // on a given domain. Admins bypass.
    .get("/:id/domain-grants", async (c) => {
      const db = dbFromCtx(c);
      const id = c.req.param("id");
      const rows = await db
        .select({
          domainId: domainGrant.domainId,
          domainName: domain.name,
          allowedKinds: domainGrant.allowedKinds,
        })
        .from(domainGrant)
        .innerJoin(domain, eq(domain.id, domainGrant.domainId))
        .where(eq(domainGrant.userId, id));
      return c.json({ grants: rows });
    })

    .put("/:id/domain-grants/:domainId", zValidator("json", upsertDomainGrant), async (c) => {
      const db = dbFromCtx(c);
      const userId = c.req.param("id");
      const domainId = c.req.param("domainId");
      const body = c.req.valid("json");

      await db
        .insert(domainGrant)
        .values({ domainId, userId, allowedKinds: body.allowedKinds })
        .onConflictDoUpdate({
          target: [domainGrant.domainId, domainGrant.userId],
          set: { allowedKinds: body.allowedKinds },
        });
      return c.json({ ok: true });
    })

    .delete("/:id/domain-grants/:domainId", async (c) => {
      const db = dbFromCtx(c);
      const userId = c.req.param("id");
      const domainId = c.req.param("domainId");
      await db
        .delete(domainGrant)
        .where(and(eq(domainGrant.userId, userId), eq(domainGrant.domainId, domainId)));
      return c.body(null, 204);
    });

  return r;
}

function inviteUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/accept-invite?token=${encodeURIComponent(token)}`;
}
