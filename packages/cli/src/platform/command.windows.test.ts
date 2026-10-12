// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { execCommand, resolveCommand } from "./command";

requireWindows();

/**
 * #698, on a Windows host — the platform the resolution exists for and no Linux runner can speak for
 * (#702). Every fact here is one the reviewer named as "unverified on our side", measured:
 *
 * - a real `.cmd` on `PATH` spawns through the helper, with the environment shaped the way the real
 *   call sites shape it — a plain **copy** of `process.env`, which spells the variable `Path` and
 *   whose `env.PATH` is `undefined`. A case-sensitive lookup finds nothing on this env and the spawn
 *   dies with #698's ENOENT; the helper must find the shim.
 * - the resolved path arrives at `cmd.exe` whole, proved by a `%CD%` the child echoes from the shim's
 *   own directory — not a re-resolution against the test cwd.
 * - a hostile argument — a registry range, a path with a `&` — survives `cmd.exe`'s re-splitting
 *   intact, recorded by the shim and read back byte for byte. This is what `pithy eject` sends.
 * - Node's guard (CVE-2024-27980) is real on this host: a `.cmd` spawned bare throws `EINVAL` from
 *   the call itself. The helper exists because of it, and the test says so out loud.
 *
 * The shim lives in a temp directory whose name contains a space: a Windows home directory with a
 * space is the common case, and the caret-escaping of the command word is exactly what breaks there
 * if it is quoted instead (Node's shell wraps the line in one quote pair; a quoted word inside
 * closes the wrapper early and cmd runs half a path).
 */

let dir: string;
let shim: string;

const recordShim = '@echo off\r\n>"%~dp0args.txt" echo %*\r\n';

async function writeShim(body: string): Promise<void> {
  await writeFile(shim, body);
}

/** A copy of `process.env` with `dir` prepended to PATH — the shape every real call site passes. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The Windows copy spells the variable `Path`; a case-sensitive `PATH` read on this object finds
  // nothing, which is review point 1's exact shape. Do not re-add a `PATH` key — the fix is tested
  // against the copy, not a repair of it.
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === "PATH") ?? "Path";
  env[key] = `${dir};${env[key] ?? ""}`;
  return env;
}

describe("the helper on a Windows host", () => {
  test("a real .cmd on PATH spawns through a copy of process.env, and the resolved path arrives whole", async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy helper "));
    try {
      // `%CD%` expands inside cmd.exe, so the child reports the directory the shell ran it from —
      // proof the resolved absolute path reached cmd.exe, not a re-resolution against the test cwd.
      await writeShim("@echo off\r\necho shim:%CD%\r\n");
      const { stdout } = await execCommand("tool", [], { env: childEnv(), cwd: dir });
      expect(stdout.trim()).toBe(`shim:${dir}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the argv survives cmd.exe: a registry range, an ampersand path, an empty argument", async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy argv "));
    try {
      await writeShim(recordShim);
      const args = ["add", "zod@^3.23.8", "C:\\work\\R&D\\app", "", "tail"];
      await execCommand("tool", args, { env: childEnv(), cwd: dir });
      const recorded = await readFileArgs();
      // cmd hands %1..%5 back quoted as it parsed them; strip that outer pair, and the empty
      // argument records as the empty string — surviving, where an unquoted empty word vanishes.
      expect(recorded.map(stripOuterQuote)).toEqual(args);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a .cmd named by path spawns through the helper, not at the EINVAL", async () => {
    // A worker's `dev.command` is a path, and a `.cmd` handed to `spawn` without a shell throws —
    // the resolution's shell branch is what a `pithy dev` session with a `vite.cmd` worker depends on.
    dir = await mkdtemp(join(tmpdir(), "pithy path-shim "));
    try {
      await writeShim("@echo off\r\necho by-path:%CD%\r\n");
      const { stdout } = await execCommand(shim, [], { env: childEnv(), cwd: dir });
      expect(stdout.trim()).toBe(`by-path:${dir}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Node refuses a .cmd spawned bare — the guard the helper exists to satisfy", async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy guard "));
    try {
      await writeShim("@echo off\r\necho hi\r\n");
      // Synchronous, from the call itself (CVE-2024-27980), measured here so a Node that stops
      // throwing it shows up red — and so the helper's `shell: true` stays load-bearing.
      let thrown: unknown;
      try {
        spawn(shim, [], { shell: false }).once("error", () => undefined);
      } catch (error) {
        thrown = error;
      }
      // spawn() reports the guard as a synchronous throw on Node 22+; if the platform ever defers
      // it to the error event, this assertion is where that shows.
      expect(thrown).toMatchObject({ code: "EINVAL" });
      // And the shell path runs the same file the bare spawn refused.
      const { stdout } = await execCommand(shim, [], { env: childEnv(), cwd: dir });
      expect(stdout.trim()).toBe("hi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the win32 resolution reads the env a call site passes, Path and all", () => {
    // Same fact as the helper test above, asserted at the pure-resolution seam on the real
    // environment: `{ ...process.env }` spells the variable `Path`, a case-sensitive `env.PATH`
    // reads `undefined`, and a resolver that misses it resolves `cmd` to nothing.
    const env = { ...process.env };
    expect(Object.keys(env).some((entry) => entry === "Path")).toBe(true);
    const resolved = resolveCommand("cmd", ["/c", "echo"], { env });
    expect(resolved.shell).toBe(false); // found on PATH as an .exe — spawned directly, at its absolute path
    expect(resolved.command.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
  });
});

/** The shim's record of its own argv, one word per line, as cmd.exe handed them over. */
async function readFileArgs(): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(join(dir, "args.txt"), "utf8");
  return text.split(/\r?\n/).filter((line) => line !== "");
}

/** Strip the outer quote pair cmd's `%1` expansion carries. */
function stripOuterQuote(word: string): string {
  return /^".*"$/s.test(word) ? word.slice(1, -1) : word;
}
