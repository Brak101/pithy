// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, resolve } from "node:path";

/**
 * **The program a footer pty test runs: the real store, the real `startTui`, and a script on top.**
 *
 * `dev/tui/devTui.pty.test.ts` and `dev/tui/devTui.windows.test.ts` both drive the footer on a real
 * terminal, and both need the same session under it — one app worker that is ready, one host still
 * coming up so the spinner ticks, every worker's output shown. This is that session, once. Each test
 * writes it to a temp file and runs it under Bun, because it imports `.ts`/`.tsx` deep paths: it is a
 * string here rather than a module, so the harness itself never becomes a published entry.
 */

/** `packages/cli/src`, which the harness imports by absolute path. This file lives at `src/test-utils/`. */
const CLI_SRC = resolve(import.meta.dirname, "..");

/**
 * The environment a harness runs in: this one, less the variables that tell Ink it is in CI.
 *
 * Ink renders non-interactively under `CI` or `CONTINUOUS_INTEGRATION` even on a TTY — no live frame, no
 * `resize` listener — and every CI runner sets one. These tests stand in for a developer's terminal, where
 * neither is set, and `pithy dev` itself never mounts the footer in CI (`choose.ts`). Inherited, the
 * variable turned the Windows job's footer off and left the pty test measuring a footer nobody sees.
 */
export function harnessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "CI" && entry[0] !== "CONTINUOUS_INTEGRATION",
    ),
  );
}

/**
 * Source for a harness that mounts the footer and then runs `script`.
 *
 * `store` and `tui` are in scope for `script`. `onDigit` and `onQuit` are function-expression source, for
 * a test that drives the session from the keyboard; with `keys: false` neither is ever called.
 */
export function devTuiHarness(options: { keys: boolean; onDigit?: string; onQuit?: string; script: string }): string {
  return `
import { createDevStore } from ${JSON.stringify(join(CLI_SRC, "dev", "tui", "store.ts"))};
import { startTui } from ${JSON.stringify(join(CLI_SRC, "dev", "tui", "app.tsx"))};

const store = createDevStore();
const at = new Date();
store.event({ event: "spawned", worker: "api", kind: "app", port: 8787, at });
store.event({ event: "spawned", worker: "support", kind: "host", port: 8790, at });
store.event({ event: "ready", worker: "api", at });
store.event({ event: "login", email: "ada@example.com" });

const noop = () => {};
const tui = await startTui({
  store,
  keys: ${options.keys},
  onRestart: noop,
  onOpen: noop,
  onLogin: noop,
  onSignIn: noop,
  onAutostart: noop,
  onDigit: ${options.onDigit ?? "noop"},
  onQuit: ${options.onQuit ?? "noop"},
  onInterrupt: noop,
});

// Worker output is hidden by default (the roster is the point of the footer), and what these tests
// measure is what reaches a real terminal — so the harness asks for the lot.
store.showAll(true);
${options.script}
`;
}
