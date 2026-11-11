import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { openRunScope, processStartTime, sweepDeadRuns } from "./run-scope.mjs";

// This test file's own root. It is created here and removed here, so the
// sweeps below act only on folders this file made.
const ROOT = path.join(os.tmpdir(), `cfx-mail-run-scope-test-${randomUUID()}`);
const BIN = path.join(ROOT, "bin");
mkdirSync(BIN, { recursive: true });
after(() => rmSync(ROOT, { recursive: true, force: true }));

// Processes a failing test might leave running. Each test that starts one adds
// it here, so a failure still leaves nothing behind.
const strays = [];
const stopAfterTests = (pid) => strays.push(pid);
after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, as it should be.
    }
  }
});

// Moves a folder into this test's own bin instead of the owner's Trash. The sweep
// still really moves it; only the destination differs.
function trashIntoBin(target) {
  renameSync(target, path.join(BIN, randomUUID()));
}

const RUN_SCOPE = new URL("./run-scope.mjs", import.meta.url).href;

// A shell, started as the leader of its own process group, that starts a long
// sleep in the background and prints the sleep's pid. With `leaderStays` the
// shell waits for the sleep; without, it exits at once and leaves the sleep
// behind, as a launcher script does when it starts a server and returns.
// wrangler dev is like this: the server it starts outlives a killed parent.
const GROUP_SCRIPT = {
  leaderStays: "sleep 600 >/dev/null 2>&1 & echo $!; wait",
  leaderExits: "sleep 600 >/dev/null 2>&1 & echo $!",
};

// A child run: opens a scope under `root`, starts a long sleep it records as
// its own process, and a process group with a grandchild sleep it records as
// a group. Prints both pids and waits to be killed.
function startChildRun(root) {
  const code = `
    import { spawn } from "node:child_process";
    import { openRunScope } from ${JSON.stringify(RUN_SCOPE)};
    const scope = openRunScope({ root: ${JSON.stringify(root)}, trash: () => {} });
    const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
    scope.recordChild(sleeper.pid);
    const group = spawn("sh", ["-c", ${JSON.stringify(GROUP_SCRIPT.leaderStays)}], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    scope.recordChild(group.pid, { group: true });
    group.stdout.once("data", (chunk) => {
      const grandchild = Number(String(chunk).trim());
      console.log(JSON.stringify({ dir: scope.dir, sleeper: sleeper.pid, grandchild }));
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n")[0];
      if (out.includes("\n")) resolve({ child, ...JSON.parse(line) });
    });
    child.once("exit", (exit) => reject(new Error(`child run exited early with ${exit}`)));
  });
}

// A killed process this test did not start sends no event here, so its end is
// seen by asking until it is gone. The timeout catches a hang.
async function gone(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (processStartTime(pid) !== null) {
    if (Date.now() > deadline) return false;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
    else child.once("exit", () => resolve(undefined));
  });
}

test("a run killed part-way leaves nothing after the next run", async () => {
  const root = path.join(ROOT, "killed");
  const { child, dir, sleeper, grandchild } = await startChildRun(root);
  stopAfterTests(grandchild);
  assert.ok(existsSync(dir), "the child run created its scope");
  assert.notEqual(processStartTime(sleeper), null, "the child's process runs");

  child.removeAllListeners("exit");
  child.kill("SIGKILL");
  await waitForExit(child);
  assert.ok(existsSync(dir), "a killed run cannot clean up after itself");

  const next = openRunScope({ root, trash: trashIntoBin });
  assert.deepEqual(next.swept, [dir]);
  assert.equal(existsSync(dir), false, "the next run swept the dead run's folder");
  assert.ok(await gone(sleeper), "the next run stopped the dead run's process");
  assert.ok(await gone(grandchild), "the next run stopped every process in the dead run's group");

  assert.deepEqual((await next.close()).leftovers, []);
  assert.deepEqual(readdirSync(root), [], "nothing is left under the root");
});

test("a run that ends normally removes its own folder and processes", async () => {
  const root = path.join(ROOT, "normal");
  const scope = openRunScope({ root, trash: trashIntoBin });
  const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
  scope.recordChild(sleeper.pid);
  assert.ok(existsSync(scope.dir));

  assert.deepEqual((await scope.close()).leftovers, []);
  assert.equal(existsSync(scope.dir), false);
  assert.equal(processStartTime(sleeper.pid), null);
});

// Starts a process group whose leader exits at once, leaving its grandchild
// sleep running. Resolves with the leader's and the grandchild's pids.
function startLeftBehindGroup() {
  const leader = spawn("sh", ["-c", GROUP_SCRIPT.leaderExits], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve) => {
    leader.stdout.once("data", (chunk) => {
      resolve({ leader: leader.pid, grandchild: Number(String(chunk).trim()) });
    });
  });
}

test("a run that ends normally stops a recorded group's processes, even after its leader exited", async () => {
  const root = path.join(ROOT, "group");
  const scope = openRunScope({ root, trash: trashIntoBin });
  const { leader, grandchild } = await startLeftBehindGroup();
  stopAfterTests(grandchild);
  scope.recordChild(leader, { group: true });
  assert.ok(await gone(leader), "the leader exits on its own");
  assert.notEqual(processStartTime(grandchild), null, "its grandchild still runs");

  assert.deepEqual((await scope.close()).leftovers, []);
  assert.ok(await gone(grandchild), "closing the scope stopped the grandchild");
});

test("a live run's folder is never swept", async () => {
  const root = path.join(ROOT, "live");
  const first = openRunScope({ root, trash: trashIntoBin });
  const second = openRunScope({ root, trash: trashIntoBin });
  assert.deepEqual(second.swept, []);
  assert.ok(existsSync(first.dir));
  await first.close();
  await second.close();
});

test("a recorded pid now used by another process is not killed", () => {
  const root = path.join(ROOT, "reused");
  const killed = [];
  const scope = openRunScope({ root, trash: trashIntoBin });
  // Pretend the run died and its child's pid now belongs to this test process,
  // which started at a different time than the one recorded.
  scope.recordChild(process.pid);
  const swept = sweepDeadRuns(root, {
    startTimeOf: (pid) => (pid === process.pid ? "a different start time" : null),
    trash: trashIntoBin,
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(swept, [scope.dir]);
  assert.deepEqual(killed, []);
});

test("a recorded group whose leader pid is now another process's is not killed", () => {
  const root = path.join(ROOT, "reused-group");
  const killed = [];
  const scope = openRunScope({ root, trash: trashIntoBin });
  scope.recordChild(process.pid, { group: true });
  const swept = sweepDeadRuns(root, {
    startTimeOf: (pid) => (pid === process.pid ? "a different start time" : null),
    trash: trashIntoBin,
    kill: (pid) => killed.push(pid),
    groupAlive: () => true,
  });
  assert.deepEqual(swept, [scope.dir]);
  assert.deepEqual(killed, []);
});
