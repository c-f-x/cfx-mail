import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// A run scope is the one place a run (tests, a script, a local server) keeps
// what it creates. The run removes it on every ending it can see. A run that is
// killed outright cannot clean up, so every new run first sweeps the scopes of
// runs that died: it stops the processes they recorded and moves their folders
// to the Trash.
//
// Copied from cfanalytics' scripts/lib/run-scope.mjs, the shape the c-f-x
// kit's `check run-scope` will take. The kit's copy replaces this one once it
// is published (decision D-17).

export const DEFAULT_ROOT = path.join(os.tmpdir(), "cfmail-runs");

const OWNER = "owner.json";
const PENDING = ".pending-";
const POLL_MS = 20;
const GONE_TIMEOUT_MS = 10_000;

/**
 * When the process started, as `ps` prints it, or null when no such process
 * runs. A zombie has exited and only waits for its parent, so it counts as gone.
 */
export function processStartTime(pid) {
  try {
    const line = execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    if (line === "" || line.startsWith("Z")) return null;
    return line.slice(line.indexOf(" ") + 1).trim();
  } catch {
    return null;
  }
}

/** Moves a path to the Trash. Folders of other runs are never deleted outright. */
export function trashPath(target) {
  execFileSync("trash", [target]);
}

/** Whether any process still belongs to process group `pgid`. */
export function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// A group record is killed through its group id, so a grandchild whose parent
// has already died is stopped too.
function killProcess(pid, group = false) {
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch {
    // It ended between the check and the kill.
  }
}

// A recorded process is ours only while it runs with the start time we
// recorded. A pid the system has given to another process is left alone.
function isSame(record, startTimeOf) {
  return record.startedAt !== null && startTimeOf(record.pid) === record.startedAt;
}

// A recorded group is ours while its leader runs with the recorded start time,
// or, once the leader is gone, while any process is left in the group. The
// system gives no new process the group's id while the group exists. A leader
// pid now used by another process means the group is not ours.
function isRunning(record, startTimeOf, groupAlive) {
  if (!record.group) return isSame(record, startTimeOf);
  const leader = startTimeOf(record.pid);
  if (leader !== null) return record.startedAt !== null && leader === record.startedAt;
  return groupAlive(record.pid);
}

// A process this run did not start sends no exit event, so its end is seen by
// asking `ps` until it is gone. The timeout catches a process that will not die.
async function waitUntilGone(records, startTimeOf, groupAlive) {
  const deadline = Date.now() + GONE_TIMEOUT_MS;
  while (records.some((r) => isRunning(r, startTimeOf, groupAlive)) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, OWNER), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Sweeps the scopes under `root` whose run has died. Returns the folders it
 * moved to the Trash. `startTimeOf`, `trash`, `kill` and `groupAlive` are
 * passed in so a test can watch them; by default they act on the real system.
 */
export function sweepDeadRuns(
  root,
  {
    startTimeOf = processStartTime,
    trash = trashPath,
    kill = killProcess,
    groupAlive = processGroupAlive,
  } = {},
) {
  if (!existsSync(root)) return [];
  const swept = [];
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    const owner = readOwner(dir);
    if (owner === null) {
      // A run that died between creating its folder and writing its owner file.
      // Its pid is in the folder's name.
      const pid = name.startsWith(PENDING) ? Number(name.slice(PENDING.length)) : Number.NaN;
      if (Number.isInteger(pid) && startTimeOf(pid) !== null) continue;
      trash(dir);
      swept.push(dir);
      continue;
    }
    if (isSame(owner, startTimeOf)) continue;
    for (const child of owner.children ?? []) {
      if (isRunning(child, startTimeOf, groupAlive)) kill(child.pid, child.group === true);
    }
    trash(dir);
    swept.push(dir);
  }
  return swept;
}

/**
 * Opens this run's scope: sweeps dead runs, then creates a folder that only
 * this run uses. Await `close()` at the end; `installExitHandlers` also stops
 * the run's processes and removes its folder on a normal exit, SIGINT or SIGTERM.
 */
export function openRunScope({
  root = DEFAULT_ROOT,
  startTimeOf = processStartTime,
  trash = trashPath,
  kill = killProcess,
  groupAlive = processGroupAlive,
  installExitHandlers = false,
} = {}) {
  mkdirSync(root, { recursive: true });
  const swept = sweepDeadRuns(root, { startTimeOf, trash, kill, groupAlive });

  /** @type {{ pid: number, startedAt: string | null, children: { pid: number, startedAt: string | null, group: boolean }[] }} */
  const owner = { pid: process.pid, startedAt: startTimeOf(process.pid), children: [] };
  const pending = path.join(root, `${PENDING}${process.pid}`);
  const dir = path.join(root, randomUUID());
  mkdirSync(pending);
  writeFileSync(path.join(pending, OWNER), JSON.stringify(owner));
  renameSync(pending, dir);

  let stopped = false;

  /**
   * Records a process this run started. With `group`, the process leads its
   * own process group (spawned with `detached: true`), and the whole group is
   * stopped with it: use this for anything that starts processes of its own,
   * such as wrangler dev.
   */
  function recordChild(pid, { group = false } = {}) {
    owner.children.push({ pid, startedAt: startTimeOf(pid), group });
    writeFileSync(path.join(dir, OWNER), JSON.stringify(owner));
  }

  // Kills this run's processes and removes its folder. Synchronous, so the
  // process "exit" handler can use it.
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const child of owner.children) {
      if (isRunning(child, startTimeOf, groupAlive)) kill(child.pid, child.group);
    }
    // This run created the folder, so it may remove it outright.
    rmSync(dir, { recursive: true, force: true });
  }

  /** Stops this run's processes, removes its folder, and reports anything left. */
  async function close() {
    stop();
    await waitUntilGone(owner.children, startTimeOf, groupAlive);
    const leftovers = [];
    if (existsSync(dir)) leftovers.push(dir);
    for (const child of owner.children) {
      if (isRunning(child, startTimeOf, groupAlive)) {
        leftovers.push(`${child.group ? "process group" : "process"} ${child.pid}`);
      }
    }
    return { leftovers };
  }

  if (installExitHandlers) {
    process.once("exit", () => stop());
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        stop();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }

  return { dir, swept, recordChild, close };
}
