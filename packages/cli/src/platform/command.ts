// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ChildProcess, type ExecFileOptions, execFile, type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
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
 * **The shell is an explicit `cmd.exe /d /s /c` spawn, not Node's `shell: true`** — cross-spawn's
 * shape, the reference implementation. With `shell: true` Node concatenates argv into the command
 * line it quotes itself (DEP0190), and the two quoting layers disagree: a measured run delivers
 * `zod@^^3.23.8` to the child where one layer of carets was meant to survive. Spawning `cmd.exe` at
 * its own path, handing it `/d /s /c "<line>"` and declaring the arguments verbatim, keeps the
 * command line ours alone to build — every argument then arrives exactly as written, measured against
 * a real npm-style shim on a Windows host.
 *
 * Inside that line the command word is caret-escaped and *unquoted* (the line carries its own
 * quoting — a quoted word inside it closes the wrapper early, and cmd runs half a path), and every
 * argument is quoted whole with its metacharacters escaped: `pithy eject` sends `zod@^3.23.8`, a
 * project path can carry `&`, and `%NAME%` expands even inside quotes. An `.exe` is spawned directly
 * at its absolute path, exactly as it works today. A name that resolves to nothing is passed through
 * untouched: the spawn then fails with an `ENOENT` naming the command, which is the caller's sentence
 * to write, not this module's to pre-empt. A command that is *already* a `.cmd`/`.bat` — a bare
 * `npm.cmd`, or a worker's `dev.command` of `node_modules\\.bin\\vite.cmd` — takes the shell branch
 * too, however it was named: handing a `.cmd` to `spawn` without a shell is the EINVAL throw, and one
 * worker's `dev.command` is not the whole `pithy dev` session's to lose.
 *
 * `PATH` and `PATHEXT` are read from the environment by name regardless of case, and the win32
 * branch splits and joins with `path.win32`, not the host's `path`. Both facts come from the call
 * sites: the wrangler child, the dev workers, and the deploy build each pass a *copy* of
 * `process.env`, which on Windows spells the variable `Path`. `process.env` matches any case; a
 * plain object does not, and a lookup that misses finds nothing on PATH and dies with #698's ENOENT
 * all over again. `path.win32` is what `C:\\tools` means; the host's `path` on a Linux runner splits
 * it at the `C:`.
 *
 * **One helper, because four call sites is four ways to forget it.** Every spawn of a package
 * manager, a runner, or wrangler goes through {@link spawnCommand} or {@link execCommand} —
 * `pithy add`, `pithy worker add`, `pithy feature create`, the `pithy dev` workers, the `pithy
 * deploy` build and every wrangler call. Off Windows everything is identity: `execvp` already
 * resolves names, and a path is already a path.
 *
 * The seams mirror `editor.ts`'s so the Windows branches are testable from a POSIX host.
 */
export interface CommandEnvironment {
  /** The platform, defaulting to `process.platform`. Only `win32` resolves; everywhere else is identity. */
  platform?: NodeJS.Platform;
  /** The environment, defaulting to `process.env` — `PATH`, `PATHEXT` and `COMSPEC` are read from here, by name, case-insensitively. */
  env?: NodeJS.ProcessEnv;
  /** Existence probe, defaulting to `fs.existsSync`. */
  fileExists?: (path: string) => boolean;
}

/** A command line ready for `child_process`: what to spawn, with what args, and how cmd.exe is involved. */
export interface ResolvedCommand {
  command: string;
  args: string[];
  /** Hand to `spawn`/`execFile` as `shell`. True only for the identity-with-shell spelling (editor's POSIX path never uses it). */
  shell: boolean;
  /**
   * Hand to `spawn`/`execFile` as `windowsVerbatimArguments`: the argv was assembled for `cmd.exe`
   * by {@link cmdShell} and is already quoted — Node must pass it through untouched. True exactly
   * when `command` is `cmd.exe`.
   */
  verbatim: boolean;
}

/** The extensions `cmd.exe` runs. Everything else on `PATHEXT` (`.vbs`, `.msc`, …) is not a program to spawn. */
const SHELL_RUNNABLE = new Set([".cmd", ".bat"]);

/** Resolve `command` + `args` for a spawn. {@link spawnCommand} and {@link execCommand} apply it; a test reads it. */
export function resolveCommand(command: string, args: string[], options: CommandEnvironment = {}): ResolvedCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args, shell: false, verbatim: false };
  const env = options.env ?? process.env;
  // Already a batch file, by bare name (`npm.cmd`) or by path (`node_modules\\.bin\\vite.cmd`): it runs
  // through cmd.exe however it was named, and cmd.exe does the lookup. It cannot reach `spawn` bare —
  // that is the EINVAL throw, which escapes a per-worker start and ends a `pithy dev` session over one
  // worker's `dev.command`.
  if (SHELL_RUNNABLE.has(extensionOf(command))) return cmdShell(command, args, env);
  // Any other name with a path in it is already a location, and the spawn resolves it.
  if (command.includes("/") || command.includes("\\")) return { command, args, shell: false, verbatim: false };
  const file = findOnPath(command, env, options.fileExists ?? existsSync);
  if (file === null) return { command, args, shell: false, verbatim: false };
  if (!SHELL_RUNNABLE.has(extensionOf(file))) return { command: file, args, shell: false, verbatim: false };
  return cmdShell(file, args, env);
}

/**
 * The command line as `cmd.exe` runs it, cross-spawn's shape: `/d` skips the registry's AutoRun,
 * `/s` lets the one outer quote pair be stripped so the line inside is cmd's to re-split, and
 * `windowsVerbatimArguments` (carried on {@link ResolvedCommand.verbatim}) keeps Node from re-quoting
 * an argv it did not build. The command word is caret-escaped and unquoted; every argument is quoted
 * and escaped by {@link escapeWord}/{@link quoteForCmd}.
 */
export function cmdShell(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  const line = [escapeWord(command), ...args.map(quoteForCmd)].join(" ");
  return {
    command: comSpec(env),
    args: ["/d", "/s", "/c", `"${line}"`],
    shell: false,
    verbatim: true,
  };
}

/**
 * Spawn with {@link resolveCommand} applied. A failure to start stays on the child's `error` event —
 * the channel every caller already handles — because resolution removed the throw paths: a `.cmd`
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
  return spawn(target.command, target.args, {
    ...spawnOptions,
    shell: target.shell,
    windowsVerbatimArguments: target.verbatim,
  });
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
  return (await runProcess(target.command, target.args, {
    ...execOptions,
    shell: target.shell,
    windowsVerbatimArguments: target.verbatim,
  })) as { stdout: string; stderr: string };
}

const runProcess = promisify(execFile);

/**
 * The first file on `PATH` that `name` resolves to, in the order `cmd.exe` tries it: each directory
 * by `PATHEXT`. Null when nothing exists.
 *
 * **No extensionless file is ever chosen, on purpose.** `cmd.exe` does not run one from `PATH`, so
 * resolving to it hands `CreateProcess` a shell script it cannot execute: npm's global bin dirs ship
 * a bash shim with no extension beside the `.cmd`, and Git for Windows' `usr\\bin` ahead of `nodejs`
 * on `PATH` puts a bash `npx` before the real `npx.cmd`. The file that runs is one `cmd.exe` runs.
 */
function findOnPath(name: string, env: NodeJS.ProcessEnv, fileExists: (path: string) => boolean): string | null {
  const extensions = (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  for (const directory of (environmentValue(env, "PATH") ?? "").split(win32.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = win32.join(directory, `${name}${extension}`);
      if (fileExists(file)) return file;
    }
  }
  return null;
}

/**
 * `env[name]`, where `name` is spelled in capitals, whatever the environment spells it.
 *
 * `process.env` on Windows matches any case — the variable arrives as `Path`, not `PATH` — and every
 * module-level read through this file's seams is a *copy* of it: `{ ...process.env, … }` is an
 * ordinary object, `env.PATH` on one is `undefined`, and the resolution silently finds nothing.
 */
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** The file extension, lowercased, `""` when there is none. */
function extensionOf(file: string): string {
  const base = file.split(/[/\\]/).pop() ?? file;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

/**
 * The shell to run batch files under: `COMSPEC` when the environment names one (Windows spells it
 * `ComSpec`, and every call site's env is a case-mangled copy), and `cmd.exe` otherwise — a name
 * every Windows PATH carries. An empty `COMSPEC` is no shell: it falls back like a missing one.
 */
function comSpec(env: NodeJS.ProcessEnv): string {
  return environmentValue(env, "COMSPEC") || "cmd.exe";
}

/** The characters `cmd.exe` reads as syntax: http://www.robvanderwoude.com/escapechars.php. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escape one command **word** — the program itself, not an argument — for `cmd.exe`: metacharacters
 * take a `^`, and the word is never quoted.
 *
 * Cross-spawn's `escapeCommand` is exactly this, and the reason it has no quotes is the shape
 * {@link cmdShell} spawns in: the whole line reaches `cmd.exe /d /s /c` inside one outer pair of
 * quotes, and `/s` strips that pair. A quoted command word inside it closes the wrapper early — a
 * shim under a directory with a space in its name is cut in half and cmd tries to run the first
 * fragment — while `^ ` escapes the space for cmd's own tokenizer and the path arrives whole.
 * Measured on a Windows host: quoting the command word fails exactly there; the caret passes.
 */
export function escapeWord(word: string): string {
  return word.replace(CMD_META, "^$1");
}

/**
 * Wrap one command-line **argument** for `cmd.exe`: quoted whole, with its metacharacters escaped —
 * the qntm/cmd algorithm, the one cross-spawn ships.
 *
 * `cmd` re-splits the line, so a word that only looks plain is not: `^` disappears
 * (`zod@^3.23.8` arrives as `zod@3.23.8`), `>` redirects, `%NAME%` expands even inside quotes — a
 * wrangler child's `PATH` is full of them — and `&` starts a new command, which is how the project
 * `C:\\work\\R&D\\app` runs `app` on its own. An empty word quoted survives as empty; bare, it
 * vanishes. Backslashes before a quote double, the quote escapes, the word is quoted whole, and
 * every metacharacter — the quotes included, which is what stops an embedded `"` re-opening the
 * word — takes its `^`.
 *
 * **One copy, shared with `editor.ts`**, which runs the `$EDITOR` under the same shell. The day one
 * of them gains an escape the other lacks is the day the two disagree about what a command line is.
 */
export function quoteForCmd(word: string): string {
  const quoted = word.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  return `"${quoted}"`.replace(CMD_META, "^$1");
}
