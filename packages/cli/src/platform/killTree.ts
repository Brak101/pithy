// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
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
 * `taskkill /PID <pid> /T` walks the child tree by pid and takes the pid as an argument, so nothing is
 * built through a shell string; `/F` joins it for the force path, mirroring SIGTERM-then-SIGKILL: the
 * polite close first, the kill in the grace window's timeout. A pid already gone exits non-zero and is
 * swallowed — "already exited" is not a failure to signal, same as `ESRCH` on POSIX.
 *
 * Off Windows this is `process.kill`, verbatim, negative pids (process groups) included.
 */
export type KillProcess = (pid: number, signal: NodeJS.Signals) => void;

/** The run seam — real `execFile` in production, a recorder in tests. Takes argv; the binary is named by the default, at its call site. */
export type RunKill = (args: string[]) => Promise<unknown>;

const runProcess = promisify(execFile);

/**
 * Build the kill for `platform`. `run` is the seam that starts `taskkill`, so a test can prove the tree
 * kill — with `/T`, the pid as its own argument, no shell — is the one used on `win32`.
 */
export function defaultKillFor(
  platform: NodeJS.Platform = process.platform,
  deps: { run?: RunKill } = {},
): KillProcess {
  if (platform !== "win32") {
    return (pid, signal) => void process.kill(pid, signal);
  }
  // The literal `"taskkill"` sits at the spawn call site, where `ci/childProcesses.ts` reads it: the
  // kill is bounded the same way `ps` and `lsof` are, and a bounded executable is spelled there.
  const run: RunKill = deps.run ?? ((args) => runProcess("taskkill", args));
  return (pid, signal) => {
    const args = signal === "SIGKILL" ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    // Fire-and-forget, like `process.kill` is: the caller watches the child's own exit, and a taskkill
    // that fails has failed on a process that is already going.
    void run(args).catch(() => {});
  };
}
