import {
  domain,
  pushSubscription,
  rateLimit,
  rateLimitCounter,
  reminder,
} from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfig } from "../src/config.ts";
import { runCron } from "../src/cron.ts";
import { broadcastToUsers } from "../src/hub.ts";
import { bytesToB64url } from "../src/lib/encoding.ts";
import { TRACKER_LIST_KEY } from "../src/mail/trackers.ts";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { MAILBOX_ID, MEMBER_ID, OWNER_ID, seedBase, seedThread } from "./support/seed.ts";

// Two cron steps with no direct test: "reminders" (fires due reminders) and
// "prune-rate-limit-counters". Both are private to cron.ts, so the tests call
// the public entry point, runCron, as the scheduled handler does.
//
// runCron also rechecks DNS and refreshes the tracker list over the network.
// Those two steps are made idle here (the domain was checked just now, the
// tracker list is not due), so the only fetch a test sees is a push request.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
// Long enough that the DNS and tracker steps stay idle in every tick a test runs.
const QUIET_FOR = 30 * 24 * HOUR;
// Whole seconds: reminder times are stored with second precision.
const NOW = new Date(Math.floor(Date.now() / SECOND) * SECOND);

let threadId: string;
let pushRequests: { url: string; method: string | undefined; body: ArrayBuffer }[];
let unexpectedFetches: string[];

// A browser's push subscription keys, as the registration route would store them.
async function makeBrowser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    p256dh: bytesToB64url(pub),
    auth: bytesToB64url(auth.buffer as ArrayBuffer),
  };
}

function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(
    (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"),
  );
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string, len: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode(info) as BufferSource,
    },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

// What the user's device does with a push body (RFC 8291, aes128gcm).
async function decryptPush(body: ArrayBuffer, browser: Awaited<ReturnType<typeof makeBrowser>>) {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const idlen = bytes[20]!;
  const ephPub = bytes.slice(21, 21 + idlen);
  const ciphertext = bytes.slice(21 + idlen);
  const ephKey = await crypto.subtle.importKey(
    "raw",
    ephPub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: ephKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0],
      browser.privateKey,
      256,
    ),
  );
  const clientPub = b64urlToBytes(browser.p256dh);
  const info = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...clientPub,
    ...ephPub,
  ]);
  const ikmKey = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: b64urlToBytes(browser.auth) as BufferSource,
        info: info as BufferSource,
      },
      ikmKey,
      256,
    ),
  );
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aes,
      ciphertext as BufferSource,
    ),
  );
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  return JSON.parse(new TextDecoder().decode(record.slice(0, end))) as {
    title: string;
    body: string;
    url: string;
    threadId: string;
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 3000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let acc = "";
  while (!acc.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    const timed = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
    const result = await Promise.race([reader.read(), timed]);
    if (result === null) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    if (result.done) throw new Error(`stream ended before ${needle}; got: ${acc}`);
    acc += decoder.decode(result.value, { stream: true });
  }
  return acc;
}

async function subscribe(userId: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const stub = e.USER_HUB.get(e.USER_HUB.idFromName(userId));
  const res = await stub.fetch("https://hub/subscribe");
  if (!res.body) throw new Error("subscribe returned no body");
  return res.body.getReader();
}

// Everything the user's open tabs have been told so far. The sentinel travels
// through the same stream after the cron's events, so once it arrives, every
// earlier event has too.
async function eventsSoFar(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  await broadcastToUsers(e, [OWNER_ID], { type: "mailbox_expired", mailboxId: "sentinel" });
  return readUntil(reader, `"mailboxId":"sentinel"`);
}

function addReminder(over: Partial<typeof reminder.$inferInsert> = {}) {
  const id = over.id ?? `rem-${crypto.randomUUID()}`;
  return db()
    .insert(reminder)
    .values({
      id,
      userId: OWNER_ID,
      mailboxId: MAILBOX_ID,
      threadId,
      kind: "manual",
      remindAt: new Date(NOW.getTime() - MINUTE),
      subject: "Call the bank",
      ...over,
    })
    .then(() => id);
}

const counterKeys = async () =>
  (await db().select().from(rateLimitCounter)).map((r) => r.key).toSorted();

const reminderRow = (id: string) => db().query.reminder.findFirst({ where: eq(reminder.id, id) });

async function cron(at: Date = NOW): Promise<void> {
  await runCron(e, at);
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  ({ threadId } = await seedThread(db()));
  // No DNS recheck and no tracker download this tick.
  await db()
    .update(domain)
    .set({ lastCheckedAt: new Date(NOW.getTime() + QUIET_FOR) });
  await setConfig(
    db(),
    TRACKER_LIST_KEY,
    JSON.stringify({ version: 1, nextRefreshAt: NOW.getTime() + QUIET_FOR, sources: {} }),
  );
  pushRequests = [];
  unexpectedFetches = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://push.example.test/")) {
      unexpectedFetches.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }
    pushRequests.push({
      url,
      method: init?.method,
      body: await new Response(init?.body as BodyInit).arrayBuffer(),
    });
    return new Response(null, { status: 201 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(unexpectedFetches).toEqual([]);
});

describe("cron step: reminders", () => {
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const ownerStream = async () => {
    const r = await subscribe(OWNER_ID);
    readers.push(r);
    return r;
  };
  afterEach(async () => {
    await Promise.all(readers.splice(0).map((r) => r.cancel().catch(() => undefined)));
  });

  it("fires a due reminder: marks it fired, tells the open tabs, and pushes to the devices", async () => {
    const browser = await makeBrowser();
    await db().insert(pushSubscription).values({
      id: "sub-owner",
      userId: OWNER_ID,
      endpoint: "https://push.example.test/owner-device",
      p256dh: browser.p256dh,
      auth: browser.auth,
    });
    const stream = await ownerStream();
    const id = await addReminder({ note: "ask about the fee" });

    await cron();

    const row = await reminderRow(id);
    expect(row?.status).toBe("fired");
    expect(row?.firedAt?.getTime()).toBe(NOW.getTime());

    const events = await readUntil(stream, `"reminderId":"${id}"`);
    expect(events).toContain("event: reminder_fired");
    expect(events).toContain(`"threadId":"${threadId}"`);
    expect(events).toContain(`"mailboxId":"${MAILBOX_ID}"`);
    expect(events).toContain(`"subject":"Call the bank"`);
    expect(events).toContain(`"note":"ask about the fee"`);

    expect(pushRequests).toHaveLength(1);
    expect(pushRequests[0]).toMatchObject({
      url: "https://push.example.test/owner-device",
      method: "POST",
    });
    expect(await decryptPush(pushRequests[0]!.body, browser)).toEqual({
      title: "Reminder",
      body: "Call the bank",
      url: `/app/m/${MAILBOX_ID}/t/${threadId}`,
      threadId,
    });
  });

  it("titles a follow-up reminder 'No reply yet' and shows a placeholder for an empty subject", async () => {
    const browser = await makeBrowser();
    await db().insert(pushSubscription).values({
      id: "sub-owner",
      userId: OWNER_ID,
      endpoint: "https://push.example.test/owner-device",
      p256dh: browser.p256dh,
      auth: browser.auth,
    });
    await addReminder({ kind: "follow_up", subject: "" });

    await cron();

    expect(pushRequests).toHaveLength(1);
    expect(await decryptPush(pushRequests[0]!.body, browser)).toMatchObject({
      title: "No reply yet",
      body: "(no subject)",
    });
  });

  it("leaves a reminder that is not due yet pending, silent and un-pushed", async () => {
    const browser = await makeBrowser();
    await db().insert(pushSubscription).values({
      id: "sub-owner",
      userId: OWNER_ID,
      endpoint: "https://push.example.test/owner-device",
      p256dh: browser.p256dh,
      auth: browser.auth,
    });
    const stream = await ownerStream();
    const future = await addReminder({ remindAt: new Date(NOW.getTime() + MINUTE) });

    await cron();

    const row = await reminderRow(future);
    expect(row?.status).toBe("pending");
    expect(row?.firedAt).toBeNull();
    expect(await eventsSoFar(stream)).not.toContain("reminder_fired");
    expect(pushRequests).toHaveLength(0);
  });

  it("fires the due ones and only the due ones when both exist", async () => {
    const past = await addReminder({ remindAt: new Date(NOW.getTime() - HOUR) });
    const exactly = await addReminder({ remindAt: NOW });
    const future = await addReminder({ remindAt: new Date(NOW.getTime() + SECOND) });

    await cron();

    expect((await reminderRow(past))?.status).toBe("fired");
    expect((await reminderRow(exactly))?.status).toBe("fired");
    expect((await reminderRow(future))?.status).toBe("pending");
  });

  it("fires a reminder once, however many ticks follow", async () => {
    const browser = await makeBrowser();
    await db().insert(pushSubscription).values({
      id: "sub-owner",
      userId: OWNER_ID,
      endpoint: "https://push.example.test/owner-device",
      p256dh: browser.p256dh,
      auth: browser.auth,
    });
    const stream = await ownerStream();
    const id = await addReminder();

    await cron(NOW);
    await cron(new Date(NOW.getTime() + 5 * MINUTE));
    await cron(new Date(NOW.getTime() + 2 * HOUR));

    const row = await reminderRow(id);
    expect(row?.firedAt?.getTime()).toBe(NOW.getTime());
    expect(pushRequests).toHaveLength(1);
    const events = await eventsSoFar(stream);
    expect(events.split("event: reminder_fired").length - 1).toBe(1);
  });

  it.each(["fired", "done", "cancelled"] as const)(
    "does not fire a reminder that is already %s",
    async (status) => {
      const stream = await ownerStream();
      const id = await addReminder({ status });

      await cron();

      expect((await reminderRow(id))?.status).toBe(status);
      expect((await reminderRow(id))?.firedAt).toBeNull();
      expect(await eventsSoFar(stream)).not.toContain("reminder_fired");
    },
  );

  it("sends the notification only to the reminder's own user", async () => {
    const memberBrowser = await makeBrowser();
    await db().insert(pushSubscription).values({
      id: "sub-member",
      userId: MEMBER_ID,
      endpoint: "https://push.example.test/member-device",
      p256dh: memberBrowser.p256dh,
      auth: memberBrowser.auth,
    });
    const stream = await ownerStream();
    const memberStream = await subscribe(MEMBER_ID);
    readers.push(memberStream);
    const id = await addReminder({ userId: OWNER_ID });

    await cron();

    expect(await readUntil(stream, `"reminderId":"${id}"`)).toContain("reminder_fired");
    expect(pushRequests).toHaveLength(0);
    await broadcastToUsers(e, [MEMBER_ID], {
      type: "mailbox_expired",
      mailboxId: "member-sentinel",
    });
    expect(await readUntil(memberStream, "member-sentinel")).not.toContain("reminder_fired");
  });

  it("fires the oldest first when more are due than one tick handles, and the rest on the next", async () => {
    // 105 due reminders, one minute apart, oldest first by number.
    const ids = Array.from({ length: 105 }, (_, i) => `bulk-${String(i).padStart(3, "0")}`);
    // D1 allows 100 bound variables per statement: insert in chunks of ten rows.
    const rows = ids.map((id, i) => ({
      id,
      userId: OWNER_ID,
      mailboxId: MAILBOX_ID,
      threadId,
      kind: "manual" as const,
      remindAt: new Date(NOW.getTime() - (200 - i) * MINUTE),
      subject: id,
    }));
    await Promise.all(
      Array.from({ length: Math.ceil(rows.length / 10) }, (_, c) =>
        db()
          .insert(reminder)
          .values(rows.slice(c * 10, c * 10 + 10)),
      ),
    );

    await cron();

    const afterFirst = await db().select().from(reminder);
    const pending = afterFirst.filter((r) => r.status === "pending").map((r) => r.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(105);
    // What is left is the newest part of the queue.
    const firedIds = afterFirst.filter((r) => r.status === "fired").map((r) => r.id);
    expect(Math.max(...firedIds.map((i) => ids.indexOf(i)))).toBeLessThan(
      Math.min(...pending.map((i) => ids.indexOf(i))),
    );

    await cron(new Date(NOW.getTime() + MINUTE));

    const afterSecond = await db().select().from(reminder);
    expect(afterSecond.every((r) => r.status === "fired")).toBe(true);
  });
});

describe("cron step: prune-rate-limit-counters", () => {
  const counter = (key: string, ageMs: number) => ({
    key,
    count: 3,
    windowStart: NOW.getTime() - ageMs,
  });

  it("deletes counters whose window ended more than a day ago and keeps the rest", async () => {
    await db()
      .insert(rateLimitCounter)
      .values([
        counter("ip:old-week", 7 * 24 * HOUR),
        counter("ip:old-just-over", 24 * HOUR + 1),
        counter("ip:exactly-a-day", 24 * HOUR),
        counter("ip:recent", 23 * HOUR),
        counter("ip:current", 0),
        counter("ip:future", -HOUR),
      ]);

    await cron();

    expect(await counterKeys()).toEqual([
      "ip:current",
      "ip:exactly-a-day",
      "ip:future",
      "ip:recent",
    ]);
  });

  it("measures the day from the tick's own time, not the wall clock", async () => {
    await db()
      .insert(rateLimitCounter)
      .values([counter("send:a", 0), counter("send:b", 30 * HOUR)]);

    // Two days on, both rows are old.
    await cron(new Date(NOW.getTime() + 48 * HOUR));

    expect(await counterKeys()).toEqual([]);
  });

  it("runs on an empty table", async () => {
    await cron();
    expect(await counterKeys()).toEqual([]);
  });

  it("leaves Better Auth's own rate-limit table alone", async () => {
    await db()
      .insert(rateLimit)
      .values({ id: "ba-1", key: "203.0.113.7/sign-in", count: 1, lastRequest: 1 });

    await cron();

    expect(await db().select().from(rateLimit)).toHaveLength(1);
  });
});
