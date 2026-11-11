// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as FolderThreadRoute } from "../routes/app/folder/$folderId.t.$threadId.tsx";
import { Route as FolderRoute } from "../routes/app/folder/$folderId.tsx";
import { Route as MailboxThreadRoute } from "../routes/app/m/$mailboxId.t.$threadId.tsx";
import { Route as MailboxRoute } from "../routes/app/m/$mailboxId.tsx";
import { createQueryClient } from "./query-client.ts";

// The mail screens draw their own skeleton while a list or conversation loads,
// and their own error with a retry when it fails. A route loader that waited
// for the data would hold back the whole page instead: blank while the server
// is slow, and blank through every retry when it fails.

afterEach(() => {
  vi.unstubAllGlobals();
});

// A server that never answers.
function hangingServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
}

async function settlesAtOnce(result: unknown): Promise<boolean> {
  const timeout = new Promise((resolve) => setTimeout(() => resolve("waiting"), 100));
  return (await Promise.race([Promise.resolve(result).then(() => "done"), timeout])) === "done";
}

const params = { mailboxId: "all", folderId: "f1", threadId: "t1" };
const deps = { view: "inbox", unread: false };

describe("mail route loaders", () => {
  it.each([
    ["a mailbox list", MailboxRoute],
    ["a conversation in a mailbox", MailboxThreadRoute],
    ["a folder list", FolderRoute],
    ["a conversation in a folder", FolderThreadRoute],
  ])("do not wait for %s to load", async (_, route) => {
    hangingServer();
    const queryClient = createQueryClient(() => undefined);
    // biome-ignore lint/suspicious/noExplicitAny: the loader's full context type is the router's
    const loader = route.options.loader as (ctx: any) => unknown;

    const result = loader({ params, deps, context: { queryClient } });

    expect(await settlesAtOnce(result)).toBe(true);
    // It still starts the request, so the data is on its way.
    expect(fetch).toHaveBeenCalled();
  });
});
