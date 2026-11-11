import type { MailView } from "@cfx-mail/shared";
import {
  FileText,
  Inbox,
  type LucideIcon,
  Mails,
  Send,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { VIEW_LABEL } from "@/lib/accounts.ts";

/** Each view's name, icon and empty-list sentence. */
export const VIEW_META: Record<MailView, { label: string; icon: LucideIcon; empty: string }> = {
  inbox: { label: VIEW_LABEL.inbox, icon: Inbox, empty: "No conversations yet." },
  marked: { label: VIEW_LABEL.marked, icon: Star, empty: "No starred conversations." },
  sent: { label: VIEW_LABEL.sent, icon: Send, empty: "Nothing sent yet." },
  drafts: { label: VIEW_LABEL.drafts, icon: FileText, empty: "No drafts." },
  spam: { label: VIEW_LABEL.spam, icon: ShieldAlert, empty: "No spam." },
  trash: { label: VIEW_LABEL.trash, icon: Trash2, empty: "Trash is empty." },
  all: { label: VIEW_LABEL.all, icon: Mails, empty: "No mail." },
};

/** One row of the rail. Shared by the views and the folders so they line up. */
export const railRowClass =
  "relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring/45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** The row you are on: the brand tint and a 2 px marker, as in the list. */
export const railRowActiveClass =
  "bg-primary/10 font-semibold text-foreground hover:bg-primary/10 before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary [&_svg]:text-primary";
