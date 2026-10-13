// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

/**
 * The default for a kill seam: signal a process, on Windows killing its whole child tree (#701 item 2).
 *
 * **On Windows, signaling the pid signals the shim.** A `pithy dev` worker runs as
 * `node_modules\.bin\wrangler.cmd` → `node …/wrangler.js` → `workerd.exe` (×2 in a real run, both
 * verified on a Windows host). `process.kill(pid)` terminates exactly one pid, so the `.cmd` shim dies
 * and the Workers reparent to the session root: they keep the pinned ports and outlive the session.
 * `kill(-pid)` — the POSIX group signal the orchestrator sends under `setsid` — has no Windows
 * equivalent, and `detached: true` there detaches the console, it does not create a killable group.
 *
 * **The tree kill reaches the children this session started and holds a handle to — nowhere else.**
 * Node keeps a child's process handle open until it exits, so a pid it spawned cannot have been
 * recycled; a pid read from a crashed session's state file can belong to anything, and Windows reuses
 * pids fast. That is the orchestrator's split: `signalChild` tree-kills, `stopPreviousSession`
 * signals plainly. A stale pid earns one process killed, not a stranger's whole tree.
 *
 * `taskkill /PID <pid> /T /F` walks the child tree by pid and takes the pid as an argument, so nothing
 * is built through a shell string. **`/F` is on every signal, and the measurement is why** (a Windows
 * host, a `.cmd` launcher over a console `node`):
 *
 * ```text
 * > taskkill /PID <launcher> /T
 * ERROR: The process with PID 78324 (child process of PID 72124) could not be terminated.
 * Reason: This process can only be terminated forcefully (with /F option).
 * ```
 *
 * Exit 128, launcher and grandchild alive: without `/F` the walk asks, a console process with no
 * window of its own refuses, and the refusal exits non-zero into the swallow below — a graceful step
 * that is a silent no-op, so every teardown would burn its grace window and the reap would kill
 * nothing. Node's own Windows `SIGTERM`/`SIGINT` are `TerminateProcess` anyway — unconditional — so
 * the ask/kill asymmetry POSIX has, Windows does not, and there is nothing to preserve by asking.
 * A pid already gone exits non-zero and is swallowed — "already exited" is not a failure to signal,
 * same as `ESRCH` on POSIX.
 *
 * Off Windows this is `process.kill`, verbatim, negative pids (process groups) included.
 */
export type KillProcess = (pid: number, signal: NodeJS.Signals) => void;

/** The run seam — real `execFile` in production, a recorder in tests. Takes argv; the binary is named by the default, at its call site. */
export type RunKill = (args: string[]) => Promise<unknown>;

const runProcess = promisify(execFile);

/** Find `name` in `env` by name regardless of case — Windows spells it `SystemRoot`, a copied env is a plain object. */
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * The system copy of a Windows binary, by full path: `%SystemRoot%\System32\<name>.exe`, and the
 * bare name when `SystemRoot` is absent — which it is on no real Windows. The census reads this
 * helper's literal argument as the spelled name of the executable (`ci/childProcesses.ts`).
 */
export function systemExecutable(name: string): string {
  const root = environmentValue(process.env, "SystemRoot");
  return root ? win32.join(root, "System32", `${name}.exe`) : name;
}

/**
 * Build the kill for `platform`. `run` is the seam that starts `taskkill`, so a test can prove the tree
 * kill — with `/T /F`, the pid as its own argument, no shell — is the one used on `win32`.
 */
export function defaultKillFor(
  platform: NodeJS.Platform = process.platform,
  deps: { run?: RunKill } = {},
): KillProcess {
  if (platform !== "win32") {
    return (pid, signal) => void process.kill(pid, signal);
  }
  // The kill binary is named by full path: CreateProcess looks up a bare name in the *working
  // directory* before PATH, and the working directory is the project's — a `taskkill.exe` planted
  // there would own every teardown. The census (ci/childProcesses.ts) reads
  // `systemExecutable("taskkill")` as a spelled call site: the helper's argument is the literal.
  const run: RunKill = deps.run ?? ((args) => runProcess(systemExecutable("taskkill"), args));
  return (pid) => {
    // Fire-and-forget, like `process.kill` is: the caller watches the child's own exit, and a taskkill
    // that fails has failed on a process that is already going.
    void run(["/PID", String(pid), "/T", "/F"]).catch(() => {});
  };
}
