import { makeDB } from "@cfx-mail/db";
import { domain } from "@cfx-mail/db/schema";
import { setConfig } from "../../src/config.ts";
import { runCron } from "../../src/cron.ts";
import type { Env } from "../../src/env.ts";
import { TRACKER_LIST_KEY } from "../../src/mail/trackers.ts";

const A_DAY = 24 * 60 * 60 * 1000;

// Marks the two network steps of the cron (the domain DNS recheck and the tracker
// list download) as not due. Tests cannot reach the network, so those steps would
// only log a refused request. For tests that drive the cron without runCronOffline.
export async function markNetworkStepsNotDue(env: Env, now: Date): Promise<void> {
  const db = makeDB(env.DB);
  const later = new Date(now.getTime() + A_DAY);
  await db.update(domain).set({ lastCheckedAt: later });
  await setConfig(
    db,
    TRACKER_LIST_KEY,
    JSON.stringify({ version: 1, nextRefreshAt: later.getTime(), sources: {} }),
  );
}

// runCron with the network steps marked as not due, for tests about the other steps.
export async function runCronOffline(env: Env, now: Date): Promise<void> {
  await markNetworkStepsNotDue(env, now);
  await runCron(env, now);
}
