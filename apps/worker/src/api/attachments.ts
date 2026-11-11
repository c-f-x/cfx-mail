import { attachment, message } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { draftUploadKey, isOwnDraftUpload } from "../mail/blob-keys.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

export function attachmentsRoutes() {
  const r = new Hono<AppBindings>()
    .use("*", requireUser)

    .post("/upload", async (c) => {
      const user = c.get("user")!;
      const contentType = c.req.header("content-type") ?? "application/octet-stream";
      const filename = c.req.header("x-filename") ?? "upload.bin";

      const body = await c.req.raw.arrayBuffer();
      if (!body.byteLength) throw new HTTPException(400, { message: "empty" });
      if (body.byteLength > 25 * 1024 * 1024)
        throw new HTTPException(413, { message: "too large" });

      const key = draftUploadKey(user.id, crypto.randomUUID(), filename);
      await c.env.BLOBS.put(key, body, { httpMetadata: { contentType } });
      return c.json({ r2Key: key, filename, contentType, sizeBytes: body.byteLength });
    })

    // Serve a still-unsent draft blob inline, for the composer to preview an
    // embedded image across reloads. Ownership is the `draft/<userId>/` key
    // prefix (same contract as the send path). Restricted to raster images and
    // served nosniff so a draft blob can never execute as script in our origin.
    .get("/draft-blob", async (c) => {
      const user = c.get("user")!;
      const key = c.req.query("key") ?? "";
      if (!isOwnDraftUpload(user.id, key)) {
        throw new HTTPException(403, { message: "forbidden" });
      }
      const obj = await c.env.BLOBS.get(key);
      if (!obj) throw new HTTPException(404, { message: "not found" });
      const type = obj.httpMetadata?.contentType ?? "";
      if (!/^image\/(png|jpeg|gif|webp|avif)$/i.test(type)) {
        throw new HTTPException(415, { message: "unsupported" });
      }
      return new Response(obj.body, {
        headers: {
          "content-type": type,
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=300",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    })

    .get("/:id", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");

      const rows = await db
        .select({
          r2Key: attachment.r2Key,
          filename: attachment.filename,
          contentType: attachment.contentType,
          mailboxId: message.mailboxId,
        })
        .from(attachment)
        .innerJoin(message, eq(message.id, attachment.messageId))
        .where(eq(attachment.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) throw new HTTPException(404, { message: "not found" });

      await requirePerm(db, user.id, row.mailboxId, Perm.READ);
      const obj = await c.env.BLOBS.get(row.r2Key);
      if (!obj) throw new HTTPException(404, { message: "blob missing" });
      return new Response(obj.body, { headers: attachmentHeaders(row.contentType, row.filename) });
    });

  return r;
}

// The only content-types served as themselves: raster images and PDF, which is
// what the in-app preview shows (components/message/attachment-preview.tsx).
// The stored type is the sender's claim, and a script-capable one ("text/javascript",
// "text/html", "image/svg+xml") is a valid same-origin subresource or document
// on our origin, so everything else is served as opaque bytes.
const SERVED_AS_IS = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf)$/;

/**
 * Response headers for stored attachment bytes. With `inline`, a raster image or
 * PDF is shown in place; everything else, and every request without `inline`,
 * is a download as `application/octet-stream`. Always nosniff and sandboxed.
 */
export function attachmentHeaders(
  contentType: string,
  filename: string,
  { inline = false }: { inline?: boolean } = {},
): Record<string, string> {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const asIs = SERVED_AS_IS.test(base);
  const headers: Record<string, string> = {
    "content-type": asIs ? base : "application/octet-stream",
    // Mirror the image proxy: never sniff, never let the bytes act as anything.
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (!(inline && asIs)) {
    headers["content-disposition"] = `attachment; filename="${filename.replace(/"/g, "_")}"`;
  }
  return headers;
}
