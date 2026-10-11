// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { execCommand, resolveCommand, spawnCommand } from "./command";

/**
 * #698. The Windows half of the resolution is exercised through the same seams `editor.ts` uses, so the
 * shim path, the exe path, and the space-in-the-path quoting are all testable from a POSIX host. The
 * assertions are literals, not the function's own answer: a test that asks the code under test what the
 * expected value is passes when the code is wrong. Expected paths are built with `join`, the way the
 * resolution is — the literals are the shape, and the separators belong to the platform the test runs on.
 */

const WIN = { platform: "win32" as const };

/** An environment where `tool` is a `.cmd` shim and nothing else on `PATH` exists. */
function shimEnv(root: string): { env: NodeJS.ProcessEnv; exists: (file: string) => boolean } {
  const files = new Set([join(root, "tool.cmd")]);
  return { env: { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, exists: (file) => files.has(file) };
}

describe("resolveCommand — win32", () => {
  test("a .cmd shim runs through cmd.exe as one command line, quoted only where a space is", () => {
    const { env, exists } = shimEnv("C:\\tools");
    expect(resolveCommand("tool", ["add", "pkg@1"], { ...WIN, env, fileExists: exists })).toEqual({
      // editor.ts's quoting rule: `cmd /s` strips exactly the outermost pair, so words are quoted when
      // they need it and bare when they do not — a path with no space arrives to cmd as a bare word.
      command: `${join("C:\\tools", "tool.cmd")} add pkg@1`,
      args: [],
      shell: true,
    });
  });

  test("a shim under a directory with a space is quoted where the space is", () => {
    const root = "C:\\Program Files\\nodejs";
    const { env, exists } = shimEnv(root);
    const resolved = resolveCommand("tool", ["--version"], { ...WIN, env, fileExists: exists });
    expect(resolved.command).toBe(`"${join(root, "tool.cmd")}" --version`);
    expect(resolved.shell).toBe(true);
  });

  test("an .exe is spawned directly at its absolute path, args intact, no shell", () => {
    const files = new Set([join("C:\\bin", "tool.exe")]);
    const resolved = resolveCommand("tool", ["dev", "--port", "8787"], {
      ...WIN,
      env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => files.has(file),
    });
    expect(resolved).toEqual({ command: join("C:\\bin", "tool.exe"), args: ["dev", "--port", "8787"], shell: false });
  });

  test("a .exe on PATH wins over the .cmd in the same directory", () => {
    // Bun's installer puts bun.exe beside the npm-shim bun.cmd on some installs. `PATHEXT`'s own order
    // is the tie-break — .EXE precedes .CMD in the Windows default, which is why the file that runs is
    // the exe — so resolution must walk the extensions in the order the environment lists them, not in
    // the order the code happens to hope for.
    const dir = "C:\\tools";
    const files = new Set([join(dir, "tool.cmd"), join(dir, "tool.exe")]);
    const resolved = resolveCommand("tool", [], {
      ...WIN,
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => files.has(file),
    });
    expect(resolved).toEqual({ command: join(dir, "tool.exe"), args: [], shell: false });
  });

  test("a .bat is a shim too — the same shape as the .cmd", () => {
    const dir = "C:\\tools";
    const resolved = resolveCommand("tool", ["run"], {
      ...WIN,
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => file === join(dir, "tool.bat"),
    });
    expect(resolved).toEqual({ command: `${join(dir, "tool.bat")} run`, args: [], shell: true });
  });

  test("the extensionless file is tried last: npm's bin dirs ship a bash shim with no extension", () => {
    const dir = "C:\\tools";
    const files = new Set([join(dir, "tool"), join(dir, "tool.cmd")]);
    const resolved = resolveCommand("tool", [], {
      ...WIN,
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => files.has(file),
    });
    expect(resolved.command).toBe(join(dir, "tool.cmd"));
    expect(resolved.shell).toBe(true);
  });

  test("a name that resolves to nothing passes through untouched — the spawn's ENOENT is the caller's sentence", () => {
    const resolved = resolveCommand("tool", ["add"], {
      ...WIN,
      env: { PATH: "C:\\empty", PATHEXT: ".EXE;.CMD" },
      fileExists: () => false,
    });
    expect(resolved).toEqual({ command: "tool", args: ["add"], shell: false });
  });

  test("a name that already carries a path is a location, not a lookup", () => {
    expect(resolveCommand("C:\\Program Files\\nodejs\\node.exe", ["-v"], { ...WIN, fileExists: () => false })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["-v"],
      shell: false,
    });
    expect(resolveCommand("./local/tool", [], { ...WIN, fileExists: () => false })).toEqual({
      command: "./local/tool",
      args: [],
      shell: false,
    });
  });
});

describe("resolveCommand — everywhere else", () => {
  test("is identity on linux, including a bare name that PATH would resolve", () => {
    expect(resolveCommand("npm", ["add", "zod"], { platform: "linux", fileExists: () => true })).toEqual({
      command: "npm",
      args: ["add", "zod"],
      shell: false,
    });
    expect(resolveCommand("npm", [], { platform: "darwin", fileExists: () => true })).toEqual({
      command: "npm",
      args: [],
      shell: false,
    });
  });
});

describe("spawnCommand / execCommand — the real child", () => {
  /**
   * The review's demand, run for real: an `npm` on the host's PATH — a `.cmd` shim on Windows, a script
   * on POSIX — spawned through the helper by its bare name, and the child answers. An `.exe` node under
   * a name with no PATH resolution (`process.execPath` carries a path) goes through the identity branch
   * and proves the direct-spawn shape.
   */
  test("a bare-name child runs and its stdout comes back", async () => {
    const { stdout } = await execCommand(process.execPath, ["-e", 'process.stdout.write("pong")']);
    expect(stdout).toBe("pong");
  });

  test("the spawn channel reports a missing binary as the child's error event, never a throw", async () => {
    const child = spawnCommand("definitely-not-on-any-path-698", ["--version"]);
    // The synchronous throw is the failure mode #698's fix exists to remove: an EINVAL escaping a
    // per-worker start ends a whole `pithy dev` session over one missing binary. The child answers.
    const code = await new Promise<string>((resolve, reject) => {
      child.once("error", (cause) => resolve((cause as NodeJS.ErrnoException).code ?? "unknown"));
      child.once("exit", () => reject(new Error("a binary that does not exist exited without an error")));
    });
    expect(code).toBe("ENOENT");
  });

  test("on Windows, a real .cmd shim on PATH spawns, quoted, through the helper", async (context) => {
    if (process.platform !== "win32") return context.skip();
    const dir = await mkdtemp(join(tmpdir(), "pithy-cmd-"));
    try {
      // `%CD%` expands inside cmd.exe, so the child reports the directory the shell ran it from — proof
      // the resolved absolute path reached the spawn, not a re-resolution against the test cwd.
      await writeFile(join(dir, "tool.cmd"), "@echo off\necho shim:%CD%\n");
      const { stdout } = await execCommand("tool", [], {
        env: { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` },
        cwd: dir,
      });
      expect(stdout.trim()).toBe(`shim:${dir}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Why the helper exists: the guard Node enforces, asserted so its removal is visible, not silent. */
describe("the .cmd guard the helper exists to satisfy", () => {
  test("Node throws EINVAL for a .cmd spawned bare, and the shell path runs it", async (context) => {
    if (process.platform !== "win32") return context.skip();
    const dir = await mkdtemp(join(tmpdir(), "pithy-cmd-"));
    try {
      await writeFile(join(dir, "tool.cmd"), "@echo off\necho hi\n");
      // The CVE-2024-27980 guard: a synchronous throw from `spawn` itself, which is what escaping a
      // per-worker start would end a session over (#698's mechanism, named so a Node that stops
      // throwing it — and so the helper's `shell: true` — shows up here red, not silently stale).
      expect(() => spawn(dir + "\\tool.cmd", [], { shell: false })).toThrow(/EINVAL/);
      const { stdout } = await execCommand("tool", [], { env: { ...process.env, PATH: dir } });
      expect(stdout.trim()).toBe("hi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
