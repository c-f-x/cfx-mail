import { message, thread } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared";
import { sql } from "drizzle-orm";

// Recounts a thread's unread inbound messages in SQL, to refresh the cached
// `thread.unreadCount` in one UPDATE. Used as `.set({ unreadCount: UNREAD_RECOUNT })`
// over `thread`. A trashed message does not count (same rule as
// `recomputeThreadUnread` in mail/threads.ts).
export const UNREAD_RECOUNT = sql`(select count(*) from ${message} m where m.thread_id = ${thread.id} and m.direction = 'in' and (m.flags & ${Flag.SEEN}) = 0 and (m.flags & ${Flag.TRASH}) = 0)`;
