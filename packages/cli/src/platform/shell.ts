// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, join } from "node:path";

/** The shells whose alias syntax and rc-file location we know how to write. */
export type ShellKind = "bash" | "zsh" | "fish" | "powershell" | "nushell";

/** A resolved shell: which one, where its config lives, and the exact line that defines `p.`. */
export interface ShellInfo {
  /** The detected shell family. */
  kind: ShellKind;
  /** Absolute path to the rc file the alias line belongs in. */
  rcPath: string;
  /**
   * Additional rc files that carry the same alias for the same user — non-empty only for
   * `powershell` (#701 item 6). Windows has two PowerShell families, 5.1 and 7, each auto-loading
   * its own `CurrentUserCurrentHost` profile from its own root (`Documents\WindowsPowerShell` and
   * `Documents\PowerShell`). There is no single file both read, so writing one leaves the other's
   * sessions without the alias — and the silent half is 5.1, which ships with Windows while `pwsh`
   * 7 must be installed. The alias block therefore lives in every family's profile, and install,
   * remove, status, and doctor treat the set as one logical location.
   */
  extraRcPaths?: string[];
  /** The shell-specific line that defines the `p.` alias (no markers). */
  aliasSyntax: string;
}

/** Every rc file that carries the alias: {@link ShellInfo.rcPath} first, then any extras. */
export function aliasRcPaths(shell: ShellInfo): string[] {
  return shell.extraRcPaths === undefined ? [shell.rcPath] : [shell.rcPath, ...shell.extraRcPaths];
}

/** Injectable seams so detection is testable without touching the real environment. */
export interface DetectShellOptions {
  /** The shell path, defaulting to `process.env.SHELL` (e.g. `/bin/zsh`). */
  shell?: string;
  /** The platform, defaulting to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The user's home directory, defaulting to `os.homedir()`. */
  homedir?: string;
  /** Existence probe, defaulting to `fs.existsSync` — used for the macOS `.bash_profile` preference. */
  fileExists?: (path: string) => boolean;
}

/** The bash/zsh single-quoted form; also the fallback we print for an unknown shell. */
const POSIX_ALIAS = "alias p.='pithy'";

/**
 * Detect the current shell and resolve where its `p.` alias belongs.
 *
 * Detection is `basename($SHELL)` plus platform checks, per docs/CLI.md §2.4. bash on macOS prefers
 * `.bash_profile` (the platform convention) and falls back to `.bashrc` only when it is absent. Windows
 * with no unix shell resolves to PowerShell — whose alias MUST be a function, not `Set-Alias` (that
 * rejects a `.` in the name), and whose profiles are a **set** (#701: 5.1 and 7 auto-load different
 * files, verified on a Windows host 2026-10-11). An unrecognized shell returns `null`: the caller
 * prints manual instructions and writes nothing. We never guess an rc file.
 */
export async function detectShell(options: DetectShellOptions = {}): Promise<ShellInfo | null> {
  const shell = options.shell ?? process.env.SHELL ?? "";
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();
  const fileExists = options.fileExists ?? existsSync;
  const base = basename(shell).toLowerCase();

  if (base.endsWith("bash")) {
    // macOS ships the `.bash_profile` convention; prefer it when it exists, else `.bashrc`.
    const rcPath =
      platform === "darwin" && fileExists(join(home, ".bash_profile"))
        ? join(home, ".bash_profile")
        : join(home, ".bashrc");
    return { kind: "bash", rcPath, aliasSyntax: POSIX_ALIAS };
  }

  if (base.endsWith("zsh")) {
    return { kind: "zsh", rcPath: join(home, ".zshrc"), aliasSyntax: POSIX_ALIAS };
  }

  if (base.endsWith("fish")) {
    // fish has no `=` in its alias form.
    return { kind: "fish", rcPath: join(home, ".config", "fish", "config.fish"), aliasSyntax: "alias p. pithy" };
  }

  if (base.endsWith("nu")) {
    // nushell uses a spaced `=` form.
    return { kind: "nushell", rcPath: join(home, ".config", "nushell", "config.nu"), aliasSyntax: "alias p. = pithy" };
  }

  // PowerShell: a unix shell was not detected but we are on Windows (or the shell names PowerShell
  // explicitly). `Set-Alias` rejects a `.` in the name, so the alias must be a passthrough function.
  //
  // **Two families, two profiles, one logical location (#701 item 6).** Windows ships PowerShell
  // 5.1, which auto-loads `Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`; PowerShell
  // 7 (`pwsh`) is installed and auto-loads `Documents\PowerShell\Microsoft.PowerShell_profile.ps1`.
  // No file loads in both, so the alias is written to both. The family that is not installed simply
  // holds an inert block — and the day it is installed, the alias is already there, which is the
  // same reason a `.zshrc` sitting in the home directory costs nothing to a zsh user. The primary is
  // the 7 path (the `pwsh` spelling a test and the docs both name); the 5.1 path rides in extras.
  if (platform === "win32" || base.endsWith("pwsh") || base.endsWith("powershell")) {
    return {
      kind: "powershell",
      rcPath: join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      extraRcPaths: [join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")],
      aliasSyntax: "function p. { pithy @args }",
    };
  }

  return null;
}
