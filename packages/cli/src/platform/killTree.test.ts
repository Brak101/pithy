// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultKillFor, type KillProcess } from "./killTree";

/**
 * #701 item 2: `pithy dev` must leave no `workerd` behind on Windows. The reproduction is in the issue —
 * killing the `.cmd` shim's pid directly left two `workerd` processes listening on the dev ports.
 * The tree kill is asserted at its seam: a recorder proves the shape of the command that a POSIX host
 * cannot run, and the assertions are literals.
 */

describe("defaultKillFor — win32", () => {
  function recorder(): { kill: KillProcess; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      kill: defaultKillFor("win32", {
        run: async (args) => void calls.push(args),
      }),
    };
  }

  test("SIGTERM tree-kills by pid with taskkill /T, no /F, and the pid as its own argument", () => {
    const { kill, calls } = recorder();
    kill(4242, "SIGTERM");
    // Literal, not computed: the shape is the fix. `/T` walks the child tree (the shim → node →
    // wrangler → workerd chain the reproduction verified), and no shell means the pid is an argv
    // element, never text for cmd to re-split.
    expect(calls).toEqual([["/PID", "4242", "/T"]]);
  });

  test("SIGKILL adds /F — the polite close first, the kill in the grace window's timeout", () => {
    const { kill, calls } = recorder();
    kill(4242, "SIGKILL");
    expect(calls).toEqual([["/PID", "4242", "/T", "/F"]]);
  });

  test("SIGINT is the polite close too — the previous-session stop asks, it does not shoot", () => {
    const { kill, calls } = recorder();
    kill(99, "SIGINT");
    expect(calls).toEqual([["/PID", "99", "/T"]]);
  });

  test("a kill that fails on the child's exit race is swallowed, the way ESRCH is on POSIX", async () => {
    // The rejection must be consumed, not left to surface as an unhandled rejection: the caller is
    // watching the child's own exit, and a pid taskkill cannot find is a pid that is leaving.
    const kill = defaultKillFor("win32", {
      run: () =>
        new Promise((_resolve, reject) => {
          queueMicrotask(() => reject(new Error("pid gone")));
        }),
    });
    expect(() => kill(1, "SIGTERM")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("defaultKillFor — off Windows", () => {
  test("linux is process.kill, verbatim — the negative-pid group signal is untouched", () => {
    const kill = defaultKillFor("linux");
    // The group-signal convention a POSIX `setsid` child depends on (orchestrator's `kill(-pid)`):
    // a linux default that grew a taskkill, or took the minus sign off, would break every teardown.
    // A live pid answers the zero probe; the value proves it is process.kill and not a recorder. (No
    // signal name: SIGCONT has no Windows spelling, and 0 is the probe Node answers on both.)
    expect(() => kill(process.pid, 0 as unknown as NodeJS.Signals)).not.toThrow();
    expect(() => kill(2_147_483_646, "SIGTERM")).toThrow(/ESRCH/);
  });
});
