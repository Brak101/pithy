// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { execCommand, resolveCommand, spawnCommand } from "./command";

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
 * if it is quoted instead (the line reaches cmd inside one quote pair; a quoted word inside closes
 * the wrapper early and cmd runs half a path). The spawn under test is the CLI's one shell shape —
 * `cmd.exe /d /s /c` with verbatim arguments (`command.ts`), the shape measured against cross-spawn
 * on this host before it was adopted.
 */

let dir: string = "";
let shim: string = "";

/** A fresh temp dir (with a space in its name) and the `tool.cmd` shim inside it. */
async function newDir(label: string): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), `pithy ${label} `));
  shim = join(dir, "tool.cmd");
}

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
    await newDir("helper");
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
    await newDir("argv");
    try {
      // The recorder is npm's own shape — a batch file forwarding %* to node — because that is the
      // chain the escaping exists for: argv has to arrive at the *program*, byte for byte, not just
      // at cmd. Node's argv parser is the judge; `%*` hands it the text cmd built.
      await writeFile(shim, '@ECHO off\r\nSET "ENTRY=%~dp0record.js"\r\nnode "%ENTRY%" %*\r\n');
      await writeFile(
        join(dir, "record.js"),
        "require('node:fs').writeFileSync(process.env.RECORD_OUT, JSON.stringify(process.argv.slice(2)))",
      );
      const out = join(dir, "argv.json");
      const args = ["add", "zod@^3.23.8", "C:\\work\\R&D\\app", "", "tail", "sk%TOKEN%hp"];
      await execCommand("tool", args, { env: { ...childEnv(), RECORD_OUT: out }, cwd: dir });
      // Measured against cross-spawn (the reviewer's reference): this chain delivers these tokens
      // exactly — every caret cmd consumes, every quote it honors, the empty word surviving as empty.
      expect(JSON.parse(await readFile(out, "utf8"))).toEqual(args);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a quoted argument is refused before the shim runs", async () => {
    // The reviewer's `a"&b`: the outer cmd line survives the escape, but the shim forwards `%*` and
    // the `.cmd` re-parse does not know `\"` — the quote closes and the `&b` runs as a command. The
    // refusal (#699 review round 3) fires at resolution, on this host's real path, and the recorder
    // proves the child never started.
    await newDir("quote-refusal");
    try {
      await writeShim("@echo off\r\necho ran\r\n");
      expect(() => spawnCommand("tool", ['a"&b'], { env: childEnv(), cwd: dir })).toThrow(ValidationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a .cmd named by path spawns through the helper, not at the EINVAL", async () => {
    // A worker's `dev.command` is a path, and a `.cmd` handed to `spawn` without a shell throws —
    // the resolution's shell branch is what a `pithy dev` session with a `vite.cmd` worker depends on.
    await newDir("path-shim");
    try {
      await writeShim("@echo off\r\necho by-path:%CD%\r\n");
      const { stdout } = await execCommand(shim, [], { env: childEnv(), cwd: dir });
      expect(stdout.trim()).toBe(`by-path:${dir}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Node refuses a .cmd spawned bare — the guard the helper exists to satisfy", async () => {
    await newDir("guard");
    try {
      await writeShim("@echo off\r\necho hi\r\n");
      // Synchronous, from the call itself (CVE-2024-27980), measured here so a Node that stops
      // throwing it shows up red — and so the helper's cmd.exe shell stays load-bearing.
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
    // The fact the fix is written against, constructed rather than assumed: a call site's
    // `{ ...process.env, … }` copy preserves Windows' own spelling — `Path`, not `PATH` — and a
    // case-sensitive `env.PATH` on that object reads `undefined`, resolving `cmd` to nothing.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      // Windows' spelling of the two variables this resolution reads, whatever this shell exports.
      const name = key.toUpperCase() === "PATH" ? "Path" : key.toUpperCase() === "PATHEXT" ? "PathExt" : key;
      if (value !== undefined) env[name] = value;
    }
    expect(env.Path).toBeDefined();
    expect(env.PATH).toBeUndefined(); // the shape the fix exists for: PATH as a key is not there
    const resolved = resolveCommand("cmd", ["/c", "echo"], { env });
    expect(resolved.verbatim).toBe(false); // found on PATH as an .exe — spawned directly, at its absolute path
    expect(resolved.command.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
  });
});
