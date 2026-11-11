import { AppError } from "../errors.ts";
import { isOwnDraftUpload } from "./blob-keys.ts";

// Client-supplied attachment r2Keys must live in the caller's own upload
// namespace (attachments.ts always writes `draft/<userId>/...`). Without this
// check a user could reference any key in the bucket — reading other tenants'
// raw mail on send, or deleting it on draft delete (AGENTS.md invariant 6).
export function assertOwnedAttachmentKeys(
  userId: string,
  attachments: ReadonlyArray<{ r2Key: string }> | undefined,
): void {
  for (const att of attachments ?? []) {
    if (!isOwnDraftUpload(userId, att.r2Key)) {
      throw new AppError("bad_request", "invalid attachment key");
    }
  }
}
