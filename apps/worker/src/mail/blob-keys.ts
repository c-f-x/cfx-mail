// Every R2 key layout, in one place (AGENTS.md invariant 6). Objects already in
// the bucket live under these exact shapes, so changing one needs a migration
// of the existing objects. test/blob-keys.test.ts pins each layout through the
// code that writes it.

/** Reduce a filename to `[a-z0-9._-]` and at most 128 characters, for use in a key. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 128);
}

/** `raw/<mailboxId>/<id>.eml`: a received or imported message. */
export function rawMessageKey(mailboxId: string, id: string): string {
  return `raw/${mailboxId}/${id}.eml`;
}

/** `raw/<mailboxId>/sent/<messageId>.eml`: a message sent from the app. */
export function sentMessageKey(mailboxId: string, messageId: string): string {
  return `raw/${mailboxId}/sent/${messageId}.eml`;
}

/** `plain/<mailboxId>/<id>.eml`: the decrypted copy of inbound PGP mail. */
export function plainMessageKey(mailboxId: string, id: string): string {
  return `plain/${mailboxId}/${id}.eml`;
}

/** `att/<messageId>/<index>-<filename>`: a stored attachment, received or sent. */
export function attachmentKey(messageId: string, index: number, filename: string): string {
  return `att/${messageId}/${index}-${sanitizeFilename(filename)}`;
}

/** `draft/<userId>/`: a user's composer uploads. A client may only refer to keys here. */
export function draftUploadPrefix(userId: string): string {
  return `draft/${userId}/`;
}

/** `draft/<userId>/<id>-<filename>`: one composer upload. */
export function draftUploadKey(userId: string, id: string, filename: string): string {
  return `${draftUploadPrefix(userId)}${id}-${sanitizeFilename(filename)}`;
}

/** Whether `key` is one of `userId`'s own composer uploads. */
export function isOwnDraftUpload(userId: string, key: string): boolean {
  return key.startsWith(draftUploadPrefix(userId));
}

/** `avatar/<userId>/`: a user's avatar images. */
export function avatarPrefix(userId: string): string {
  return `avatar/${userId}/`;
}

/** `avatar/<userId>/<id>`: one avatar image. */
export function avatarKey(userId: string, id: string): string {
  return `${avatarPrefix(userId)}${id}`;
}
