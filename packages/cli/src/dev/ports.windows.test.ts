// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { sweepStaleDevPorts, tryBind } from "./ports";

requireWindows();

/**
 * #701 item 3, on a Windows host — the sweep is asserted by reaping, not by a recorder.
 *
 * The reproduction: a `workerd` that outlived a crashed `pithy dev` keeps the pinned port, and a sweep
 * that cannot see it leaves every later startup dying on "port in use" naming no pid. This plants exactly
 * that process — a copy of this test runner's own node renamed to `workerd.exe`, listening on a free
 * port on **both** loopback families — and runs the production sweep against it: no stubbed `lsof`, no
 * stubbed kill. Both families matter: `netstat -ano -p TCP`, the first attempt, sees only IPv4, and a
 * listener on `[::1]` alone sailed through it. The safety half is the second file below: the same
 * listener under a stranger's name must survive the sweep, to be reported by `verifyPinnedPort`, not
 * silently killed.
 *
 * Liveness is read with `tasklist`, not `process.kill(pid, 0)` — the measured Windows rule from
 * `killTree.windows.test.ts`: a terminated child whose handle is still open answers a signal-0 probe
 * as alive.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isLive(pid: number): boolean {
  const tasklist = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
  const query = spawnSync(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return (query.stdout ?? "").includes(`"${pid}"`);
}

async function freePort(): Promise<number> {
  for (let port = 21000 + (process.pid % 900); port < 22000; port += 1) {
    if ((await tryBind(port, "127.0.0.1")) && (await tryBind(port, "::1"))) return port;
  }
  throw new Error("no free dev-scope port found");
}

let workDir: string | null = null;
const children: number[] = [];

afterAll(async () => {
  for (const pid of children) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 4 });
});

/**
 * Plant a live listener on `port`, under the executable name `name` — a copy of this runner's node,
 * because the sweep's scope filter reads the *name*, and the CIM command line of a copied node names
 * the copy. The server binds both families, like a real dev server, and idles.
 */
async function plant(name: string, port: number): Promise<number> {
  workDir ??= await mkdtemp(join(tmpdir(), "pithy-sweep-"));
  const exe = join(workDir, `${name}.exe`);
  await copyFile(process.execPath, exe);
  const script = join(workDir, `${name}.server.cjs`);
  await writeFile(
    script,
    `const net = require("node:net");
net.createServer().listen(${port}, "127.0.0.1");
net.createServer().listen(${port}, "::1");
setInterval(() => {}, 1000);
`,
  );
  const child = spawn(exe, [script], { stdio: "ignore" });
  if (!child.pid) throw new Error(`no pid for planted ${name}`);
  children.push(child.pid);
  // The port is taken on both families before the sweep is asked to find its holder.
  for (let waited = 0; ; waited += 250) {
    if (!(await tryBind(port, "127.0.0.1")) && !(await tryBind(port, "::1"))) break;
    if (waited > 15_000) throw new Error(`planted ${name} never bound port ${port}`);
    await sleep(250);
  }
  return child.pid;
}

describe("sweepStaleDevPorts on a Windows host", () => {
  test("reaps a workerd-named listener on both families, with the production defaults", async () => {
    const port = await freePort();
    const pid = await plant("workerd", port);

    const reaped = await sweepStaleDevPorts([port]);
    expect(reaped).toEqual([pid]);

    for (let waited = 0; isLive(pid); waited += 250) {
      if (waited > 15_000) throw new Error(`pid ${pid} outlived the reap`);
      await sleep(250);
    }
    expect(await tryBind(port, "127.0.0.1")).toBe(true);
    expect(await tryBind(port, "::1")).toBe(true);
  }, 90_000);

  test("leaves a stranger on the port alone, to be named by the verify that follows", async () => {
    const port = await freePort();
    const pid = await plant("nvim", port);

    const reaped = await sweepStaleDevPorts([port]);
    expect(reaped).toEqual([]);
    expect(isLive(pid)).toBe(true);
  }, 90_000);
});
