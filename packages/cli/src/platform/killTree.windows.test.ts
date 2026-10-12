// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { defaultKillFor } from "./killTree";

requireWindows();

/**
 * #701 item 2, on a Windows host — the tree kill is asserted by killing, not by a recorder.
 *
 * The shape is the one the reproduction left behind: a `.cmd` launcher that starts a long-lived child
 * and idles. A plain `process.kill` on the launcher ends the launcher and the child keeps its port;
 * the tree kill ends the chain, and the port comes free. This is what keeps the port-release claim on
 * CI (#703) and off a single machine, and it doubles as the measurement the review asked for: it
 * fails, loudly, if `/T` alone ever comes back (the ask form: exit 128, "can only be terminated
 * forcefully" — a Windows host says so).
 *
 * The temp directory name carries a space: the child command is built inside a batch file, and the
 * quoting that survives there is the quoting that survives a Windows home directory — the common case.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms));

/**
 * Is the pid in the live process table? `process.kill(pid, 0)` is not this on Windows: a terminated
 * child whose process handle is still open answers the probe as alive, so the launcher of a kill we
 * issued ourselves can poll true forever. `tasklist /FI "PID eq N"` reads the table, passively —
 * measured on this host: the CSV row when present, `INFO: No tasks are running` when not. (Not
 * `taskkill /FI` without `/F`, which is not a query — it *attempts the kill*, the same measured
 * ask-the-console-process refuses with "can only be terminated forcefully".)
 */
function isAlive(pid: number): boolean {
  const tasklist = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
  const query = spawnSync(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return (query.stdout ?? "").includes(`,"${pid}",`); // the CSV row: name,"pid",session,studio,mem
}

async function gone(pid: number, withinMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

async function portFree(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

describe("the tree kill on a Windows host", () => {
  test("killing the launcher's tree ends the launcher and the child holding the port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tree kill-")); // a space in the path, by design
    try {
      // The child: a server on an ephemeral port, its pid and port recorded when bound.
      await writeFile(
        join(dir, "server.js"),
        "const fs=require('fs');const s=require('net').createServer();" +
          "s.listen(0,'127.0.0.1',()=>fs.writeFileSync('pids.json',JSON.stringify({pid:process.pid,port:s.address().port})));" +
          "setInterval(()=>{},1000);\n",
      );
      // The launcher: starts the child through the runner that owns this test host, then idles —
      // a `.cmd` with a live grandchild, the exact shape of `wrangler.cmd` over its `workerd`.
      const runner = process.execPath.replace(/\\/g, "\\\\");
      await writeFile(
        join(dir, "launcher.cmd"),
        `@echo off\r\nstart /b "" "${runner}" server.js\r\nping -n 600 127.0.0.1 >nul\r\n`,
      );
      const cmd = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      // The launcher is a command **word**, caret-armed exactly as `command.ts` arms a shim word:
      // `/s` strips the outer quotes off the `/c` payload, a path with a space then splits in cmd's
      // tokenizer, and `start /b` inherits cwd — `server.js` resolves in the launcher's directory.
      const caret = (word: string) => word.replace(/([()[\]%!^"`<>&|;, *?])/g, "^$1");
      const launcher = spawn(cmd, ["/d", "/s", "/c", `"${caret(join(dir, "launcher.cmd"))}"`], {
        cwd: dir,
        windowsVerbatimArguments: true,
        stdio: "ignore",
      });
      const launcherPid = launcher.pid;
      if (launcherPid === undefined) throw new Error("the launcher never started");
      try {
        const child = await (async () => {
          const deadline = Date.now() + 20_000;
          for (;;) {
            try {
              return JSON.parse(await readFile(join(dir, "pids.json"), "utf8")) as { pid: number; port: number };
            } catch {
              if (Date.now() > deadline) throw new Error("the child never bound a port");
              await sleep(100);
            }
          }
        })();
        expect(isAlive(child.pid)).toBe(true); // the chain is up: a child the session does not hold a handle to, by pid

        defaultKillFor(process.platform)(launcherPid, "SIGKILL");

        expect(await gone(child.pid), "the port-holding child survives the tree kill").toBe(true);
        expect(await gone(launcherPid), "the launcher survives the tree kill").toBe(true);
        expect(await portFree(child.port), "the port the child held is free").toBe(true);
      } finally {
        // The tree kill already fired on the pass path; this is the guard for the failure paths, so a
        // red run leaves no server behind on a CI box.
        defaultKillFor(process.platform)(launcherPid, "SIGKILL");
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});
