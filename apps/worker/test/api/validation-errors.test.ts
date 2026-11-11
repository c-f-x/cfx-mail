import { mailbox } from "@cfx-mail/db/schema";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { applyMigrationsOnce, db, resetDb } from "../support/app.ts";
import { DOMAIN_ID, seedBase } from "../support/seed.ts";
import { call, createUser, type Jar, signIn } from "../support/session.ts";

// A request that fails validation answers 400 with the app's own error shape,
// `{ error: "<sentence>" }`, so the web app can show the person what to fix.
// The sentence is the first problem zod found, starting with a capital letter
// and ending with a full stop.

const app = buildApi();
let jar: Jar;

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await seedBase(db());
  const userId = await createUser("rules@example.com", "a-long-test-password");
  await db().insert(mailbox).values({
    id: "mailbox-validation",
    domainId: DOMAIN_ID,
    localPart: "rules",
    type: "personal",
    ownerUserId: userId,
  });
  ({ jar } = await signIn(app, "rules@example.com", "a-long-test-password"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const rule = (value: string) => ({
  mailboxId: "mailbox-validation",
  name: "Invoices",
  conditions: [{ field: "subject", op: "regex", value }],
  actions: [{ type: "markRead" }],
});

describe("validation errors", () => {
  it("saves a rule whose regular expression compiles", async () => {
    const res = await call(app, jar, "POST", "/api/rules", rule("^invoice \\d+$"));
    expect(res.status).toBe(201);
  });

  it("answers a rule with an invalid regular expression with that sentence", async () => {
    const res = await call(app, jar, "POST", "/api/rules", rule("(unclosed"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not a valid regular expression." });
  });

  it("answers a label without its required name with zod's message for it", async () => {
    const res = await call(app, jar, "POST", "/api/labels", { mailboxId: "mailbox-validation" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid input: expected string, received undefined.",
    });
  });

  it("answers a search with a malformed date with that sentence", async () => {
    const res = await call(app, jar, "GET", "/api/search?after=notadate");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Expected YYYY-MM-DD." });
  });
});
