// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { defaultKillFor, systemExecutable } from "../platform/killTree";

const run = promisify(execFile);

/**
 * Try to bind `port` on `host`, resolving `true` when it is free and `false` when it is taken.
 * The dual-stack primitive: a port is only usable if this succeeds on **both** `127.0.0.1` and `::1`
 * (Vite binds IPv6-only, wrangler binds both families), so a loopback check on one family is not enough.
 */
export function tryBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** The bind seam — real {@link tryBind} in production, a stub in tests. */
export type TryBind = (port: number, host: string) => Promise<boolean>;

/**
 * Assert a worker's **pinned** port is free — the deliberate divergence from CMS `pickPort`.
 *
 * The port is authoritative: it comes from the feature's `.dev.config.json`, assigned once at feature
 * creation and held for the feature's life. So this only verifies; it never scans forward to another
 * port. A worker that silently drifts off its pinned port breaks every sibling that was told its address
 * ahead of time, so a conflict is reported, not worked around. The port must be free on **both** loopback
 * families; a failure on either aborts the whole `pithy dev` session with one actionable error.
 */
export async function verifyPinnedPort(name: string, port: number, bind: TryBind = tryBind): Promise<void> {
  const freeV4 = await bind(port, "127.0.0.1");
  const freeV6 = await bind(port, "::1");
  if (freeV4 && freeV6) return;
  throw new ConflictError({
    message: `Port ${port} for worker "${name}" is already in use.`,
    action: "Stop whatever is holding it, then run this again.",
    detail: `free on 127.0.0.1=${freeV4}, ::1=${freeV6}`,
  });
}

/** Whether `pid` is a live process — `process.kill(pid, 0)` probes without signaling. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sleep seam — real `setTimeout` in production, controllable in tests. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `pid` is dead or `timeoutMs` elapses; resolves `true` if it exited, `false` on timeout. */
export async function waitForExit(
  pid: number,
  timeoutMs: number,
  deps: { isAlive?: (pid: number) => boolean; sleep?: Sleep } = {},
): Promise<boolean> {
  const alive = deps.isAlive ?? isAlive;
  const sleep = deps.sleep ?? realSleep;
  const start = Date.now();
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(100);
  }
}

/** Look up the pids listening on a TCP `port` — the real one shells out to `lsof`. */
export type LsofPort = (port: number) => Promise<number[]>;

/** `lsof -ti tcp:<port>` → the pids holding it, or `[]` when lsof is missing or errors. */
export const lsofPort: LsofPort = async (port) => {
  try {
    const { stdout } = await run("lsof", ["-ti", `tcp:${port}`]);
    return stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
};

/**
 * The pids listening on a TCP `port`, asked of CIM — the Windows {@link LsofPort} (#701 item 3).
 * Windows has no `lsof`, and the POSIX default reads a missing binary as "nothing holds this port",
 * so the sweep reaps nothing and a pinned port that outlived a crash silently blocks startup.
 *
 * This is `Get-NetTCPConnection`, not `netstat`: `netstat -ano -p TCP` lists IPv4 only (IPv6 needs
 * `-p TCPv6`), so a `workerd` listening on `[::1]` alone never appears — and the `LISTENING` state
 * column is localized, so a non-English Windows prints `ABHÖREN` and a parsed table matches nothing.
 * `-State Listen` is an enum in the cmdlet, not a printed word, and the query covers every listening
 * address, on every family, at once.
 */
export const cimPortHolders: LsofPort = async (port) => {
  try {
    const { stdout } = await run(systemExecutable("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // The port is interpolated as a number literal — the same rule {@link cimProcess} keeps, so no
      // text ever reaches the cmdlet's parameters.
      `Get-NetTCPConnection -State Listen -LocalPort ${Math.trunc(port)} | Select-Object -ExpandProperty OwningProcess`,
    ]);
    return parseCimPids(stdout);
  } catch {
    return [];
  }
};

/**
 * The pids out of `Select-Object -ExpandProperty OwningProcess`'s output — one per line, CRLF, and a
 * pid repeats once per listening address (IPv4 and IPv6 are two rows of the same server), which is
 * why this returns a set. `pid 0` is the kernel's table owner, never a process to reap.
 */
export function parseCimPids(stdout: string): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Look up a pid's full command line — the sweep's scope filter. */
export type ProcessCommand = (pid: number) => Promise<string | null>;

/** `ps -o args= -p <pid>` → the pid's command line, or `null` when it is gone or `ps` is unavailable. */
export const psCommand: ProcessCommand = async (pid) => {
  try {
    const { stdout } = await run("ps", ["-o", "args=", "-p", String(pid)]);
    const line = stdout.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
};

/** Look up a pid's parent — walked upward so the sweep never signals its own ancestry. */
export type ParentPid = (pid: number) => Promise<number | null>;

/** `ps -o ppid= -p <pid>` → the parent pid, or `null` when it is gone or `ps` is unavailable. */
export const psParent: ParentPid = async (pid) => {
  try {
    const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
    const ppid = Number(stdout.trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
};

/**
 * `Get-CimInstance Win32_Process` → the parent pid, or `null` when it is gone or CIM is unavailable —
 * the Windows {@link ParentPid} (#701). The sweep's ancestry guard has to walk parents on this
 * platform too, and `ps` is not a Windows binary.
 */
export const cimParent: ParentPid = async (pid) => {
  const value = await cimProcess(pid, "ParentProcessId");
  const ppid = Number(value);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
};

/**
 * `Get-CimInstance Win32_Process` → the command line, or `null` when it is gone — the Windows
 * {@link ProcessCommand}. The pid goes in as a number literal, so no user text reaches the filter.
 */
export const cimCommand: ProcessCommand = async (pid) => (await cimProcess(pid, "CommandLine")) ?? null;

/**
 * One CIM property of one pid, asked with the pid as a numeric filter literal. Null when CIM finds nothing.
 *
 * `powershell.exe -Command` is a script string, not an argv — #701 item 3 asked for a query that needs no
 * shell parsing. The trade: Windows has had no shell-free way to read a command line since `wmic` was
 * removed, and the pid goes in as a `Math.trunc`'d number literal, so no text ever reaches the WQL filter.
 * The System32 path, like `taskkill`, keeps the working directory — the project — out of the lookup.
 */
async function cimProcess(pid: number, property: "ParentProcessId" | "CommandLine"): Promise<string | null> {
  try {
    const { stdout } = await run(systemExecutable("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").${property}`,
    ]);
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * The port holder for the platform: `lsof` where it exists, CIM's `Get-NetTCPConnection` on Windows
 * (#701 item 3). Windows has no `lsof`, and {@link lsofPort} reads a missing binary as an empty answer —
 * so there the sweep finds nothing, reaps nothing, and a pinned port that outlived a crashed session
 * blocks every startup with a message that says "stop whatever is holding it" while the holder stays
 * invisible.
 */
export function defaultPortHolders(platform: NodeJS.Platform = process.platform): LsofPort {
  return platform === "win32" ? cimPortHolders : lsofPort;
}

/** The command-line lookup for the platform — CIM is the Windows `ps`. */
export function defaultCommandOf(platform: NodeJS.Platform = process.platform): ProcessCommand {
  return platform === "win32" ? cimCommand : psCommand;
}

/** The parent lookup for the platform — CIM is the Windows `ps -o ppid=`. */
export function defaultParentOf(platform: NodeJS.Platform = process.platform): ParentPid {
  return platform === "win32" ? cimParent : psParent;
}

/** The binaries the sweep owns: the Workers runtime and its supervisor. Case-insensitively: Windows
 * filenames are, and CIM echoes a path as it was launched — `WORKERD.EXE` is the same binary. */
const WORKER_BINARY = /^(workerd|wrangler)(\.[cm]?js)?$/i;
/** Launchers that run a script — the script name, not the launcher, says what the process is. */
const SCRIPT_RUNNER = /^(node|bun|deno|npx|bunx)$/i;

/** The last path segment of `token`, stripped of a Windows `.exe` suffix and of the quotes CIM wraps
 * around a program path (every path with a space, which on Windows includes Program Files). Both
 * separators count: the command line arrives from `ps` on POSIX and from CIM on Windows. */
function commandBase(token: string): string {
  const bare = token.replace(/^"|"$/g, "");
  return (bare.split(/[/\\]/).pop() ?? "").replace(/\.exe$/i, "");
}

/**
 * Whether a command line is one of ours to reap — `workerd` itself, or a `wrangler` launched directly or
 * through a script runner (`node …/.bin/wrangler dev`, `bun x wrangler dev`).
 *
 * The sweep exists to clear a crashed session's orphans, not to clear the port. Anything else holding a
 * pinned port is a genuine external conflict and must reach `verifyPinnedPort`, which reports it.
 */
export function isReapableDevCommand(command: string | null): boolean {
  if (!command) return false;
  const tokens = splitCommandLine(command);
  const exe = commandBase(tokens[0] ?? "");
  if (WORKER_BINARY.test(exe)) return true;
  if (!SCRIPT_RUNNER.test(exe)) return false;
  return tokens.slice(1).some((token) => WORKER_BINARY.test(commandBase(token)));
}

/**
 * Split a command line into words, quotes honored. CIM hands back `"C:\Program Files\nodejs\node.exe"
 * C:\proj\…` — the program path is quoted *because* it carries spaces, so a whitespace split would
 * shatter it and the scope filter would read the word `"C:\Program` as the executable.
 */
function splitCommandLine(command: string): string[] {
  return command.match(/"[^"]*"|\S+/g) ?? [];
}

/** This process and every ancestor of it — never signaled, whatever is holding a port. */
async function ancestorPids(selfPid: number, parentOf: ParentPid): Promise<Set<number>> {
  const chain = new Set<number>([selfPid]);
  let pid = selfPid;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = await parentOf(pid);
    if (parent === null || parent <= 1 || chain.has(parent)) break;
    chain.add(parent);
    pid = parent;
  }
  return chain;
}

/** Seams for {@link sweepStaleDevPorts}, so it can be driven without real `lsof`/`ps`/`kill`. */
export interface SweepDeps {
  lsof?: LsofPort;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Plain signal for a pid accepted only by the state-file list (default: `process.kill`). */
  killStale?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (message: string) => void;
  /** Command-line lookup, the scope filter (default: {@link defaultCommandOf}, `ps` or CIM by platform). */
  commandOf?: ProcessCommand;
  /** Parent lookup, for the ancestry guard (default: {@link defaultParentOf}, `ps` or CIM by platform). */
  parentOf?: ParentPid;
  /** Pids the previous session recorded in `.dev-state.json` — ours by construction, reaped whatever they run. */
  knownPids?: readonly number[];
  /** This process's pid (default: `process.pid`). */
  selfPid?: number;
}

/**
 * Reap orphaned `workerd`/`wrangler` processes still holding the pinned dev ports — a crashed previous
 * session must not block startup. Mirrors the CMS zombie-workerd sweep, with the scope its name promises:
 * a pid is reaped only when it is one of ours — a `workerd`/`wrangler`-shaped command, or a pid the
 * previous session recorded — and never when it is this process or one of its ancestors. Anything else
 * is left alone and falls through to {@link verifyPinnedPort}, which reports an actionable conflict
 * instead of silently SIGKILLing an unrelated dev server, database, or editor.
 *
 * Returns the pids reaped, so a re-run can report what it cleaned up.
 */
export async function sweepStaleDevPorts(ports: number[], deps: SweepDeps = {}): Promise<number[]> {
  const lsof = deps.lsof ?? defaultPortHolders();
  const alive = deps.isAlive ?? isAlive;
  // The sweep's kill is the tree kill: on Windows the port holder is a `.cmd`/`node`/`workerd` chain,
  // and the sweep exists precisely to end chains (#701 item 3, riding #704's killTree). It is earned
  // only by the command filter: a pid accepted just because the state file recorded it may have been
  // recycled, and a recycled pid earns one process killed, not a stranger's whole tree (#704's rule).
  const kill = deps.kill ?? defaultKillFor();
  const killStale = deps.killStale ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
  const commandOf = deps.commandOf ?? defaultCommandOf();
  const parentOf = deps.parentOf ?? defaultParentOf();
  const selfPid = deps.selfPid ?? process.pid;
  const known = new Set(deps.knownPids ?? []);
  const reaped: number[] = [];
  // Resolved once, and only when something is actually about to be signaled.
  let protectedPids: Set<number> | null = null;

  for (const port of ports) {
    for (const pid of await lsof(port)) {
      if (pid === selfPid || !alive(pid)) continue;
      const commandMatch = isReapableDevCommand(await commandOf(pid));
      const ours = known.has(pid);
      if (!ours && !commandMatch) {
        deps.log?.(`port ${port} is held by pid ${pid}, which is not a stale worker — leaving it`);
        continue;
      }
      protectedPids ??= await ancestorPids(selfPid, parentOf);
      if (protectedPids.has(pid)) continue;
      deps.log?.(`reaping stale process on port ${port} (pid ${pid})`);
      // Tree kill only a holder the command filter matched as a worker; a known pid the filter did
      // not match is killed as a stale pid — one process, no tree (#705 review).
      const apply = commandMatch ? kill : killStale;
      try {
        apply(pid, "SIGKILL");
        reaped.push(pid);
      } catch {
        // Already gone between the lsof and the kill — nothing to reap.
      }
    }
  }
  return reaped;
}
