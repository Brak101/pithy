// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import {
  isReapableDevCommand,
  parseNetstatListening,
  sweepStaleDevPorts,
  verifyPinnedPort,
  waitForExit,
} from "./ports";

describe("verifyPinnedPort", () => {
  test("returns when the port is free on both families", async () => {
    const bind = vi.fn().mockResolvedValue(true);
    await expect(verifyPinnedPort("api", 8787, bind)).resolves.toBeUndefined();
    expect(bind).toHaveBeenCalledWith(8787, "127.0.0.1");
    expect(bind).toHaveBeenCalledWith(8787, "::1");
  });

  test("throws ConflictError when taken on IPv4 only", async () => {
    const bind = async (_port: number, host: string) => host !== "127.0.0.1";
    await expect(verifyPinnedPort("api", 8787, bind)).rejects.toBeInstanceOf(ConflictError);
  });

  test("throws ConflictError when taken on IPv6 only — never drifts to another port", async () => {
    const bind = async (_port: number, host: string) => host !== "::1";
    const error = await verifyPinnedPort("web", 5173, bind).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.payload.message).toContain("5173");
    expect(error.payload.message).toContain("web");
    expect(error.payload.action).toBeTruthy();
  });
});

describe("waitForExit", () => {
  test("resolves true immediately when the pid is already dead", async () => {
    const gone = await waitForExit(1234, 5000, { isAlive: () => false, sleep: async () => {} });
    expect(gone).toBe(true);
  });

  test("resolves false on timeout when the pid stays alive", async () => {
    const gone = await waitForExit(1234, 0, { isAlive: () => true, sleep: async () => {} });
    expect(gone).toBe(false);
  });
});

describe("sweepStaleDevPorts", () => {
  /** The base seams: nothing is alive but what a test says, and nobody has a parent. */
  const base = { isAlive: () => true, parentOf: async () => null, selfPid: 100 };

  test("kills live workerd orphans holding the ports and returns them", async () => {
    const killed: number[] = [];
    const reaped = await sweepStaleDevPorts([8787, 8788], {
      ...base,
      lsof: async (port) => (port === 8787 ? [4242] : []),
      commandOf: async () => "/proj/node_modules/@cloudflare/workerd-linux-64/bin/workerd serve --socket-addr",
      kill: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([4242]);
    expect(reaped).toEqual([4242]);
  });

  test("reaps a wrangler launched through a script runner", async () => {
    const killed: number[] = [];
    await sweepStaleDevPorts([8787], {
      ...base,
      lsof: async () => [4242],
      commandOf: async () => "node /proj/node_modules/.bin/wrangler dev --port 8787",
      kill: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([4242]);
  });

  test("leaves an unrelated process holding a pinned port — it is a conflict to report, not an orphan to reap", async () => {
    const killed: number[] = [];
    const logs: string[] = [];
    const reaped = await sweepStaleDevPorts([8787], {
      ...base,
      lsof: async () => [4242],
      commandOf: async () => "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/data",
      kill: (pid) => killed.push(pid),
      log: (m) => logs.push(m),
    });
    expect(killed).toEqual([]);
    expect(reaped).toEqual([]);
    expect(logs.some((l) => l.includes("not a stale worker"))).toBe(true);
  });

  test("reaps a pid the previous session recorded, whatever command it runs", async () => {
    const killed: number[] = [];
    await sweepStaleDevPorts([8787], {
      ...base,
      lsof: async () => [3001],
      // A custom dev.command child (Vite) from a crashed session: ours by record, not by command name.
      commandOf: async () => "node /proj/node_modules/.bin/vite --host",
      knownPids: [3001],
      kill: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([3001]);
  });

  test("never signals this process or one of its ancestors", async () => {
    const killed: number[] = [];
    const parents = new Map<number, number>([
      [100, 50],
      [50, 20],
    ]);
    const reaped = await sweepStaleDevPorts([8787, 8788], {
      lsof: async (port) => (port === 8787 ? [100] : [50]),
      isAlive: () => true,
      selfPid: 100,
      parentOf: async (pid) => parents.get(pid) ?? null,
      // Even a wrangler-shaped ancestor (pithy dev run from inside one) stays untouched.
      commandOf: async () => "node /proj/node_modules/.bin/wrangler dev",
      knownPids: [50],
      kill: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([]);
    expect(reaped).toEqual([]);
  });

  test("never reaps a dead pid", async () => {
    const killed: number[] = [];
    const reaped = await sweepStaleDevPorts([8787], {
      ...base,
      lsof: async () => [9999],
      isAlive: (pid) => pid !== 9999,
      commandOf: async () => "workerd serve",
      kill: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([]);
    expect(reaped).toEqual([]);
  });
});

describe("parseNetstatListening", () => {
  /** The real shape of `netstat -ano -p TCP` on Windows 11, with a 8787 story written into it. */
  const TABLE = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1704",
    "  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       27200",
    "  TCP    [::1]:8787             [::]:0                 LISTENING       27200",
    "  TCP    127.0.0.1:8787         127.0.0.1:57875        ESTABLISHED     27200",
    "  TCP    127.0.0.1:57875        127.0.0.1:8787         ESTABLISHED     2872",
    "  TCP    127.0.0.1:51066        127.0.0.1:8787         TIME_WAIT       0",
  ].join("\r\n");

  test("names the listener on both families once, from a real table shape", () => {
    expect(parseNetstatListening(TABLE, 8787)).toEqual([27200]);
  });

  test("an ESTABLISHED client connection to the port is not a holder of it", () => {
    // pid 2872 has the port as its *foreign* address — a browser tab, not the server. Reaping it for
    // a stale dev port would kill the operator's browser, not the orphan.
    expect(parseNetstatListening(TABLE, 8787)).not.toContain(2872);
  });

  test("a table with no listener for the port is empty, and TIME_WAIT is not a listener", () => {
    expect(parseNetstatListening(TABLE, 5173)).toEqual([]);
  });

  test("the header row and the CRLF line endings of the real binary are absorbed", () => {
    expect(parseNetstatListening(TABLE, 135)).toEqual([1704]);
  });
});

describe("isReapableDevCommand", () => {
  test.each<[string | null, boolean]>([
    ["/usr/local/bin/workerd serve --socket-addr=127.0.0.1:8787", true],
    ["wrangler dev --port 8787", true],
    ["node /proj/node_modules/wrangler/bin/wrangler.js dev", true],
    ["bun x wrangler dev --port 8787", true],
    ["node /proj/node_modules/.bin/vite --host", false],
    ["docker-proxy -proto tcp -host-port 8791", false],
    ["nvim wrangler.jsonc", false],
    [null, false],
    // #701 item 3: the CIM command lines the Windows sweep feeds this. Backslash paths, an `.exe`
    // suffix, and a quoted program path (a Windows home with a space is the common case).
    ["C:\\Users\\x\\node_modules\\@cloudflare\\workerd\\bin\\workerd.exe serve", true],
    ['"C:\\Program Files\\nodejs\\node.exe" C:\\proj\\node_modules\\wrangler\\bin\\wrangler.js dev', true],
    ["C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe x wrangler dev", true],
    ['"C:\\Program Files\\Git\\usr\\bin\\git.exe" status', false],
    ["C:\\Windows\\System32\\netstat.exe -ano", false],
  ])("%s → %s", (command, expected) => {
    expect(isReapableDevCommand(command)).toBe(expected);
  });
});
