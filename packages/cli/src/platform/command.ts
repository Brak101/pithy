// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ChildProcess, type ExecFileOptions, execFile, type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

/**
 * Resolve and start a child process by command name the way a shell would — against `PATH` and, on
 * Windows, `PATHEXT` (#698).
 *
 * **Why this is not just appending `.cmd`:** Node refuses to spawn a `.cmd` without a shell. The
 * argument-injection fix (CVE-2024-27980) turned the silent `ENOENT` into a thrown `EINVAL`, on every
 * Node the CLI supports. And the tools are not always shims: Bun's official installer ships `bun.exe`,
 * pnpm's ships `pnpm.exe`. Appending `.cmd` fixes one install and breaks the other. Resolving answers
 * both — each machine runs the file it actually has.
 *
 * A `.cmd`/`.bat` runs through `cmd.exe` (`shell: true`), the way `platform/editor.ts` spawns
 * `code.cmd`, with that file's quoting for that file's reasons: with a shell the whole command line is
 * one string `cmd` re-splits, so every word carries its own quotes — a Windows home directory with a
 * space in it is the common case, not the exotic one, and a `"` cannot appear in a Windows path at all.
 * The words go into the string, not into `spawn`'s `args`: with a shell, Node concatenates an array
 * without escaping it (DEP0190), which is the injection the CVE fix exists to stop. An `.exe` is
 * spawned directly at its absolute path, exactly as it works today. A name that resolves to nothing is
 * passed through untouched: the spawn then fails with an `ENOENT` naming the command, which is the
 * caller's sentence to write, not this module's to pre-empt.
 *
 * **One helper, because four call sites is four ways to forget it.** Every spawn of a package manager,
 * a runner, or wrangler goes through {@link spawnCommand} or {@link execCommand} — `pithy add`,
 * `pithy worker add`, `pithy feature create`, the `pithy dev` workers, the `pithy deploy` build and
 * every wrangler call. Off Windows everything is identity: `execvp` already resolves names, and a path
 * is already a path.
 *
 * The seams mirror `editor.ts`'s so the Windows branches are testable from a POSIX host.
 */
export interface CommandEnvironment {
  /** The platform, defaulting to `process.platform`. Only `win32` resolves; everywhere else is identity. */
  platform?: NodeJS.Platform;
  /** The environment, defaulting to `process.env` — `PATH` and `PATHEXT` are read from here. */
  env?: NodeJS.ProcessEnv;
  /** Existence probe, defaulting to `fs.existsSync`. */
  fileExists?: (path: string) => boolean;
}

/** A command line ready for `child_process`: what to spawn, with what args, and whether a shell is involved. */
export interface ResolvedCommand {
  command: string;
  args: string[];
  /** Hand to `spawn`/`execFile` as `shell`. True only when the resolved file is a `.cmd`/`.bat` shim. */
  shell: boolean;
}

/** The extensions `cmd.exe` runs. Everything else on `PATHEXT` (`.vbs`, `.msc`, …) is not a program to spawn. */
const SHELL_RUNNABLE = new Set([".cmd", ".bat"]);

/** Resolve `command` + `args` for a spawn. {@link spawnCommand} and {@link execCommand} apply it; a test reads it. */
export function resolveCommand(command: string, args: string[], options: CommandEnvironment = {}): ResolvedCommand {
  const platform = options.platform ?? process.platform;
  // A name with a path in it is already a location, and POSIX resolution comes free with the spawn.
  if (platform !== "win32" || command.includes("/") || command.includes("\\")) {
    return { command, args, shell: false };
  }
  const file = findOnPath(command, options.env ?? process.env, options.fileExists ?? existsSync);
  if (file === null) return { command, args, shell: false };
  if (!SHELL_RUNNABLE.has(extensionOf(file))) return { command: file, args, shell: false };
  return { command: [file, ...args].map(quoteForCmd).join(" "), args: [], shell: true };
}

/**
 * Spawn with {@link resolveCommand} applied. A failure to start stays on the child's `error` event —
 * the channel every caller already handles — because resolution removed the one throw path: a `.cmd`
 * never reaches `spawn` without a shell, so there is no synchronous `EINVAL` to escape a per-worker
 * start and end a whole `pithy dev` session over one binary.
 */
export function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptions & CommandEnvironment = {},
): ChildProcess {
  const { platform, fileExists, ...spawnOptions } = options;
  // `env` stays with the child and is read from: the PATH the shim resolves against is the PATH the
  // child will run under, so the two must be one value — a child spawned with its own PATH resolved
  // against the parent's is found at a binary it will not have.
  const target = resolveCommand(command, args, { platform, env: spawnOptions.env, fileExists });
  return spawn(target.command, target.args, { ...spawnOptions, shell: target.shell });
}

/**
 * Run to completion and capture, with {@link resolveCommand} applied — {@link spawnCommand}'s sibling
 * for the call sites that collect output instead of streaming it. The shape is `execFile`'s: a
 * `{ stdout, stderr }` resolution, and a non-zero exit rejects with the child's own error for the
 * caller to word.
 */
export async function execCommand(
  command: string,
  args: string[],
  options: ExecFileOptions & CommandEnvironment = {},
): Promise<{ stdout: string; stderr: string }> {
  const { platform, fileExists, ...execOptions } = options;
  const target = resolveCommand(command, args, { platform, env: execOptions.env, fileExists });
  // The cast is `promisify`'s type game, not a runtime claim: with the options spread, Node's overloads
  // pick the Buffer-returning one, and `execFile` hands back a string for the text encoding every
  // caller here runs under (the CLI's default, the one `promisify(execFile)` was typed against).
  return (await runProcess(target.command, target.args, { ...execOptions, shell: target.shell })) as {
    stdout: string;
    stderr: string;
  };
}

const runProcess = promisify(execFile);

/**
 * The first file on `PATH` that `name` resolves to, in the order `cmd.exe` tries it: each directory
 * by `PATHEXT`, the extensionless file last. Null when nothing exists.
 *
 * The extensionless file is tried last on purpose: npm's global bins ship a bash shim with no
 * extension beside the `.cmd`, and that file is not a Windows program — resolving to it would hand
 * `CreateProcess` a shell script.
 */
function findOnPath(name: string, env: NodeJS.ProcessEnv, fileExists: (path: string) => boolean): string | null {
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = join(directory, `${name}${extension}`);
      if (fileExists(file)) return file;
    }
    const bare = join(directory, name);
    if (fileExists(bare) && !SHELL_RUNNABLE.has(extensionOf(bare))) return bare;
  }
  return null;
}

/** The file extension, lowercased, `""` when there is none. */
function extensionOf(file: string): string {
  const base = file.split(/[/\\]/).pop() ?? file;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

/** Wrap a command-line word for `cmd.exe` when it needs it. Windows paths cannot contain a quote. */
function quoteForCmd(word: string): string {
  return /\s/.test(word) ? `"${word}"` : word;
}
