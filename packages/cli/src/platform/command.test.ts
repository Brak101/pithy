// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { cmdShell, escapeWord, execCommand, quoteForCmd, resolveCommand, spawnCommand } from "./command";

/**
 * #698. The Windows half of the resolution is exercised through the same seams `editor.ts` uses, so the
 * shim path, the exe path, and the quoting are all testable from a POSIX host. The assertions are
 * literals, not the function's own answer: a test that asks the code under test what the expected value
 * is passes when the code is wrong. Paths are spelled with Windows separators and joined the way
 * `path.win32.join` joins them — the resolver reads `path.win32` on purpose, so the same literals hold
 * on every runner. The shell shape — `cmd.exe /d /s /c "<caret-escaped word> <quoted arguments>"` with
 * `windowsVerbatimArguments`, and the exact token spellings — is cross-spawn's, measured against the
 * real package on a Windows host, and re-measured here as literals. The real-`.cmd` spawn tests live in
 * `command.windows.test.ts`, which the Windows CI job (#702) is the one place that runs.
 */

const WIN = { platform: "win32" as const };

/** The Windows join of a directory and a file — the shape `path.win32.join` gives, on every host. */
const wjoin = (dir: string, file: string): string => `${dir}\\${file}`;

/** An environment where `tool` is a `.cmd` shim and nothing else on `PATH` exists. */
function shimEnv(root: string): { env: NodeJS.ProcessEnv; exists: (file: string) => boolean } {
  const files = new Set([wjoin(root, "tool.cmd")]);
  return { env: { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, exists: (file) => files.has(file) };
}

/** The shell resolution as the cmd.exe spawn it is: the /c payload is the whole line, in its quotes. */
const shellLine = (line: string) => ({
  command: "cmd.exe",
  args: ["/d", "/s", "/c", `"${line}"`],
  verbatim: true,
});

describe("resolveCommand — win32", () => {
  test("a .cmd shim runs as an explicit cmd.exe /d /s /c: caret-escaped word, quoted arguments", () => {
    const { env, exists } = shimEnv("C:\\tools");
    // Cross-spawn's shape, the one measured to deliver argv intact through a real npm-style shim.
    // Node's own `shell: true` is not it: Node re-quotes the concatenated line (DEP0190) and the two
    // quoting layers disagree — a measured run delivers `zod@^^3.23.8` where one caret was meant to
    // survive. Spawning cmd.exe at its own path with verbatim arguments keeps the line ours alone.
    expect(resolveCommand("tool", ["add", "pkg@1"], { ...WIN, env, fileExists: exists })).toEqual(
      shellLine(String.raw`C:\tools\tool.cmd ^"add^" ^"pkg@1^"`),
    );
  });

  test("a shim under a directory with a space in it is caret-escaped, not quoted", () => {
    // The line reaches cmd inside one outer quote pair that /s strips; a quoted word inside it closes
    // the wrapper early and cmd runs half a path. The caret escapes the space for cmd's tokenizer.
    const root = "C:\\Program Files\\nodejs";
    const { env, exists } = shimEnv(root);
    expect(resolveCommand("tool", ["--version"], { ...WIN, env, fileExists: exists })).toEqual(
      shellLine(String.raw`C:\Program^ Files\nodejs\tool.cmd ^"--version^"`),
    );
  });

  test("an .exe is spawned directly at its absolute path, args intact, no shell, no quoting", () => {
    const files = new Set([wjoin("C:\\bin", "tool.exe")]);
    const resolved = resolveCommand("tool", ["dev", "--port", "8787"], {
      ...WIN,
      env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => files.has(file),
    });
    expect(resolved).toEqual({
      command: wjoin("C:\\bin", "tool.exe"),
      args: ["dev", "--port", "8787"],
      verbatim: false,
    });
  });

  test("a .exe on PATH wins over the .cmd in the same directory", () => {
    // Bun's installer puts bun.exe beside the npm-shim bun.cmd on some installs. `PATHEXT`'s own order
    // is the tie-break — .EXE precedes .CMD in the Windows default, which is why the file that runs is
    // the exe — so resolution must walk the extensions in the order the environment lists them, not in
    // the order the code happens to hope for.
    const dir = "C:\\tools";
    const files = new Set([wjoin(dir, "tool.cmd"), wjoin(dir, "tool.exe")]);
    const resolved = resolveCommand("tool", [], {
      ...WIN,
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => files.has(file),
    });
    expect(resolved).toEqual({ command: wjoin(dir, "tool.exe"), args: [], verbatim: false });
  });

  test("a .bat is a shim too — the same shape as the .cmd", () => {
    const dir = "C:\\tools";
    const resolved = resolveCommand("tool", ["run"], {
      ...WIN,
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => file === wjoin(dir, "tool.bat"),
    });
    expect(resolved).toEqual(shellLine(String.raw`C:\tools\tool.bat ^"run^"`));
  });

  test("the extensionless file never wins: npm's bin dirs ship a bash shim beside the .cmd", () => {
    // cmd.exe will not run an extensionless file from PATH, so resolving to one hands CreateProcess a
    // shell script. Git for Windows' usr\bin ahead of nodejs puts a bash npx before the real npx.cmd —
    // the .cmd is the file that runs, extensionless files notwithstanding.
    const dir = "C:\\tools";
    const files = new Set([wjoin(dir, "tool"), wjoin(dir, "tool.cmd")]);
    const resolved = resolveCommand("tool", [], {
      ...WIN,
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (file) => files.has(file),
    });
    expect(resolved).toEqual(shellLine(String.raw`C:\tools\tool.cmd`));
  });

  test("a name that resolves to nothing passes through untouched — the spawn's ENOENT is the caller's sentence", () => {
    const resolved = resolveCommand("tool", ["add"], {
      ...WIN,
      env: { PATH: "C:\\empty", PATHEXT: ".EXE;.CMD" },
      fileExists: () => false,
    });
    expect(resolved).toEqual({ command: "tool", args: ["add"], verbatim: false });
  });

  test("a name that already carries a path is a location, not a lookup", () => {
    expect(resolveCommand("C:\\Program Files\\nodejs\\node.exe", ["-v"], { ...WIN, fileExists: () => false })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["-v"],
      verbatim: false,
    });
    expect(resolveCommand("./local/tool", [], { ...WIN, fileExists: () => false })).toEqual({
      command: "./local/tool",
      args: [],
      verbatim: false,
    });
  });

  test("a .cmd named outright runs through cmd.exe, by bare name and by path", () => {
    // A worker's `dev.command` of `node_modules\\.bin\\vite.cmd` is a location the caller named — and a
    // `.cmd` handed to `spawn` without a shell is the EINVAL throw, which escapes `startWorker` and ends
    // a `pithy dev` session over one worker. However it was spelled, a batch file takes the shell.
    expect(
      resolveCommand("npm.cmd", ["install"], { ...WIN, env: { PATH: "C:\\tools" }, fileExists: () => false }),
    ).toEqual(shellLine(`npm.cmd ^"install^"`));
    expect(
      resolveCommand("node_modules\\.bin\\vite.cmd", ["dev"], {
        ...WIN,
        env: { PATH: "C:\\tools" },
        fileExists: () => false,
      }),
    ).toEqual(shellLine(String.raw`node_modules\.bin\vite.cmd ^"dev^"`));
  });

  test("PATH and PATHEXT are found by name regardless of case", () => {
    // Windows spells the variable `Path`, and every module-level env the call sites pass is a plain
    // copy of `process.env` — an ordinary object, where `env.PATH` on a `Path` copy is `undefined`.
    // A lookup that misses resolves nothing, and the bare name dies with #698's ENOENT all over again.
    const { exists } = shimEnv("C:\\tools");
    const env = { Path: "C:\\tools", PathExt: ".COM;.EXE;.BAT;.CMD" };
    expect(resolveCommand("tool", ["add"], { ...WIN, env, fileExists: exists })).toEqual(
      shellLine(String.raw`C:\tools\tool.cmd ^"add^"`),
    );
  });

  test("COMSPEC is honored, by name regardless of case", () => {
    // The shell to run is the one the environment names (`ComSpec` is Windows' spelling), the same
    // lookup rule as PATH. The fallback is a full path, not a bare name: a bare `cmd.exe` is looked
    // up in the working directory before PATH, and the working directory is the project's.
    const dir = "C:\\tools";
    const resolved = resolveCommand("tool", [], {
      ...WIN,
      env: { PATH: dir, PATHEXT: ".CMD", ComSpec: "C:\\windows\\system32\\cmd.exe" },
      fileExists: (file) => file === wjoin(dir, "tool.cmd"),
    });
    expect(resolved.command).toBe("C:\\windows\\system32\\cmd.exe");
    expect(resolved.verbatim).toBe(true);
  });

  test("the shell fallback is SystemRoot\\System32, by name regardless of case", () => {
    const { env, exists } = shimEnv("C:\\tools");
    expect(
      resolveCommand("tool", [], { ...WIN, env: { ...env, SystemRoot: "C:\\windows" }, fileExists: exists }).command,
    ).toBe(String.raw`C:\windows\System32\cmd.exe`);
    // An empty COMSPEC is no shell: it falls back like a missing one.
    expect(
      resolveCommand("tool", [], { ...WIN, env: { ...env, COMSPEC: "", Systemroot: "C:\\WIN" }, fileExists: exists })
        .command,
    ).toBe(String.raw`C:\WIN\System32\cmd.exe`);
  });

  test("an argument carrying a double quote is refused on the cmd.exe path", () => {
    // npm's shims forward `%*`, and the `.cmd` re-parses that text with a tokenizer that does not
    // know `\"`: an escaped quote closes the quoting, and a `&` behind it runs as a command. The
    // refusal is the fix — no caller has a legitimate quote in argv.
    expect(() => cmdShell("npm.cmd", ['a"&b'], { PATH: "C:\\tools" })).toThrow(ValidationError);
    expect(() => cmdShell("npm.cmd", ["clean"], { PATH: "C:\\tools" })).not.toThrow();
  });
});

describe("resolveCommand — everywhere else", () => {
  test("is identity on linux, including a bare name that PATH would resolve", () => {
    expect(resolveCommand("npm", ["add", "zod"], { platform: "linux", fileExists: () => true })).toEqual({
      command: "npm",
      args: ["add", "zod"],
      verbatim: false,
    });
    expect(resolveCommand("npm", [], { platform: "darwin", fileExists: () => true })).toEqual({
      command: "npm",
      args: [],
      verbatim: false,
    });
  });

  test("a .cmd name is left alone off Windows — the shell is win32's, and cmd.exe is not here", () => {
    expect(resolveCommand("node_modules/.bin/vite.cmd", ["dev"], { platform: "linux" })).toEqual({
      command: "node_modules/.bin/vite.cmd",
      args: ["dev"],
      verbatim: false,
    });
  });
});

describe("the cmd.exe escaping", () => {
  test("a command word takes carets and keeps its spaces unquoted", () => {
    expect(escapeWord("C:\\Program Files\\nodejs\\npm.cmd")).toBe(String.raw`C:\Program^ Files\nodejs\npm.cmd`);
  });

  test("a registry range survives the shell: the caret, the redirects, the parens", () => {
    // `pithy eject` sends these through a `bun add`. The argument is quoted whole, then every
    // metacharacter — the quoting quotes included — takes its caret, so the token is inert to cmd's
    // re-splitting and cmd hands the quoted word to the child as one argument.
    // Measured: a real npm-style shim chain delivers `zod@^3.23.8` byte-exact.
    expect(quoteForCmd("zod@^3.23.8")).toBe(`^"zod@^^3.23.8^"`);
    expect(quoteForCmd("foo@>=2")).toBe(`^"foo@^>=2^"`);
  });

  test("an ampersand in a project path cannot split the command line", () => {
    // `C:\work\R&D\app` run bare executes `app` as a second command.
    expect(quoteForCmd("C:\\work\\R&D\\app")).toBe(String.raw`^"C:\work\R^&D\app^"`);
  });

  test("a percent is a percent: it survives to the child, not to the environment", () => {
    // `%NAME%` expands inside cmd's quotes, so it takes the caret — a token with a percent in it is
    // ordinary, and a path of `%USERPROFILE%\x` is a Windows fact.
    expect(quoteForCmd("sk-hp%TOKEN%")).toBe(`^"sk-hp^%TOKEN^%^"`);
  });

  test("an empty argument survives as empty", () => {
    // Quoted, an empty word arrives empty; bare, it vanishes and shifts every argument after it.
    expect(quoteForCmd("")).toBe(`^"^"`);
  });

  test("a quote inside an argument is backslash-escaped inside the quoting", () => {
    // The qntm/cmd rule the Windows argv splitter implements: the backslashes before a quote double,
    // the quote escapes, and the whole lands inside the quoting — which the caret pass then arms.
    expect(quoteForCmd('a"b')).toBe(String.raw`^"a\^"b^"`);
  });
});

describe("spawnCommand / execCommand — the real child", () => {
  /**
   * The review's demand, run for real: a child spawned through the helper and the answer comes back.
   * `process.execPath` carries a path, goes through the identity branch, and proves the direct-spawn
   * shape. The real-`.cmd` spawn lives in `command.windows.test.ts`, where the Windows job runs it.
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
});

/**
 * Why the helper exists: the guard Node enforces (`command.windows.test.ts` asserts it on a real
 * host, from a real `.cmd`); this pins the shape the resolution exists to produce, from any host.
 */
describe("the .cmd guard the helper exists to satisfy", () => {
  test("every resolution that ends at a batch file spawns cmd.exe, verbatim", () => {
    // Node refuses a `.cmd` spawned without a shell (CVE-2024-27980), so every path through the
    // resolution that lands on a batch file must carry the shell — by lookup, by bare name, by path.
    // The cmd.exe spawn is verbatim: the argv is ours, built for cmd, and Node must not re-quote it.
    const { env, exists } = shimEnv("C:\\tools");
    for (const resolved of [
      resolveCommand("tool", [], { ...WIN, env, fileExists: exists }),
      resolveCommand("npm.cmd", [], { ...WIN, env: { PATH: "C:\\tools" } }),
      resolveCommand("x\\vite.cmd", [], { ...WIN, env: { PATH: "C:\\tools" } }),
    ]) {
      expect(resolved.command).toBe("cmd.exe");
      expect(resolved.verbatim).toBe(true);
      expect(resolved.args[0]).toBe("/d");
    }
  });
});
