// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { devTuiHarness, harnessEnv } from "../../test-utils/devTuiHarness";
import { scrollScreenAway } from "./app";

/**
 * **What the footer does to a real terminal — measured, on one, with the real component.**
 *
 * Every other test of this renderer uses `ink-testing-library`, which is the right seam for *what the
 * component decides* and can say nothing about *what a terminal receives*. The claims below are only the
 * second kind, and each of them is load-bearing for #670:
 *
 * 1. **Committed lines survive verbatim**, in order, each exactly once — the property that makes the
 *    stream byte-identical to a plain run and keeps the terminal's own scroll and copy working.
 * 2. **A line longer than the terminal is not split.** Ink wraps a `<Text>` against its container, which
 *    would put a real newline inside every long wrangler stack trace: it would stop copying as one line
 *    and never rejoin when the window widened, because a soft wrap belongs to the terminal and a hard one
 *    to us. `wrap` cannot prevent it — `truncate` keeps only the first terminal-width characters and
 *    `wrap`/`hard` both split — so `StreamLine` sizes a `<Box>` to each line, and this is the test that
 *    proves it on a terminal rather than in a 100-column fake.
 * 3. **Nothing leaves the normal screen buffer.** No alternate screen, no clear-screen: the session's
 *    output is still there afterwards, which is the whole reason this shape was chosen over a full-screen
 *    app.
 * 4. **The last frame is left behind**, so a session that has stopped still says how it ended.
 * 5. **A resize repaints the footer once it settles, and only then** (#736). The harness drags its own
 *    terminal narrower and wider with `stty`, which arrives as SIGWINCH exactly as a window manager's
 *    does, and the footer is redrawn on a clean screen once per settled size — not once per event, and
 *    without an erase-display. A byte stream does not rewrap, so this cannot see the stale headers a
 *    rewrapping terminal stacked up; `devTui.windows.test.ts` reads those off a real ConPTY. What this
 *    holds is the half a byte stream can: how often the repaint fires, and that it leaves the stream
 *    whole.
 *
 * A pty is required and a fake will not do, for the reason `capabilities/secretPrompt.pty.test.ts` gives
 * about `password()`: this behavior is the *terminal's* and Ink's, not ours. `script(1)` allocates it,
 * exactly as that file and `commands/secretsInteractive.test.ts` do — and, as there, the harness is
 * written to a temp file rather than shipped in `src/`, because every non-test `src/*.ts` is a published
 * entry of `@pithy-sh/cli`.
 */

/** Where `bun` is, or `null` — the harness imports `.ts`/`.tsx` deep paths, which only Bun runs. */
function bunPath(): string | null {
  try {
    return execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Whether `script(1)` is here to allocate a pty. util-linux, so: Linux CI and Linux dev boxes. */
function hasScript(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v script"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BUN = bunPath();
const RUNNABLE = BUN !== null && hasScript();

/** 300 ordinary lines, well past the 24-row terminal, plus one far wider than its 80 columns. */
const LINES = 300;
const LONG = `[api] Error: ${"segment/".repeat(45)}end`;

/** The terminal's height, which the resize phase never changes: a drag here is a change of width. */
const ROWS = 24;

/** The widths the resize phase settles at — narrower than the start, then wider. */
const SETTLED = [60, 120];

/**
 * The resize phase: a drag to each settled width, a step of a few columns at a time as a window manager
 * sends them, then a pause long enough for the footer to settle and a marker written at that size.
 */
const RESIZE_PHASE = `
const { execFileSync } = await import("node:child_process");
const rest = (ms) => new Promise((r) => setTimeout(r, ms));
const width = (cols) => execFileSync("stty", ["cols", String(cols)], { stdio: "inherit" });
let cols = 80;
for (const target of ${JSON.stringify(SETTLED)}) {
  const step = target > cols ? 5 : -5;
  for (cols += step; step > 0 ? cols < target : cols > target; cols += step) {
    width(cols);
    await rest(20);
  }
  cols = target;
  width(cols);
  await rest(600);
  store.line("MARK-" + process.stdout.columns, "api");
  await rest(400);
}
`;

const HARNESS = devTuiHarness({
  keys: false,
  script: `
store.line(${JSON.stringify(LONG)}, "api");
for (let i = 0; i < ${LINES}; i++) store.line("L" + i, "api");
/**
 * Wait for Ink to have committed every line, rather than for a fixed interval.
 *
 * A fixed sleep here is the shape that passes on an idle machine and fails in a full suite: Ink commits
 * the static region on its own render schedule, and under CPU contention 300 lines take longer than any
 * number this test could pick. The frames themselves cannot be observed from inside the process, so the
 * proxy is the store - every line has to have left the buffer and been committed - followed by a short
 * settle for the final render.
 */
const committed = () => store.state().lines.length;
const deadline = Date.now() + 20_000;
let seen = -1;
while (Date.now() < deadline) {
  if (committed() >= ${LINES} + 1 && committed() === seen) break;
  seen = committed();
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 400));
${RESIZE_PHASE}
store.event({ event: "exited", worker: "support", code: 1 });
await new Promise((r) => setTimeout(r, 300));
await tui.stop();
`,
});

let workspace: string;
let transcript: string;

beforeAll(() => {
  if (!RUNNABLE) return;
  workspace = mkdtempSync(join(tmpdir(), "pithy-devtui-pty-"));
  const harness = join(workspace, "harness.ts");
  const out = join(workspace, "out.txt");
  writeFileSync(harness, HARNESS);
  // **`stty` first.** A pty whose stdout is a pipe starts 0x0, and a zero-column terminal wraps every
  // line after one character — which would make claim 2 below unfalsifiable rather than true.
  const command = `stty rows ${ROWS} cols 80; ${BUN as string} ${harness}`;
  execFileSync("script", ["-qec", command, out], { stdio: "ignore", timeout: 120_000, env: harnessEnv() });
  transcript = readFileSync(out, "utf8").replace(/\r\n/g, "\n");
}, 140_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/**
 * The transcript with color *and cursor control* removed — the text a reader would see.
 *
 * Broader than `dev/logging.ts`'s `stripAnsi`, which matches only the SGR `…m` sequences it needs for a
 * log file. What is being asserted here includes the absence of cursor movement, so the sequences have to
 * be removed to read the text and counted separately to make the claim.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI ESC (\x1b) is the point — this strips a real terminal's escape sequences.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const plain = () => transcript.replace(ANSI, "");

describe.runIf(RUNNABLE)("the live footer on a real terminal", () => {
  test("every committed line survives, exactly once, in order", () => {
    const seen = [...plain().matchAll(/\bL(\d+)\b/g)].map((m) => Number(m[1]));
    expect(seen).toHaveLength(LINES);
    expect(new Set(seen).size).toBe(LINES);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  test("a line far wider than the terminal arrives in one piece", () => {
    // 368 characters in an 80-column terminal. Present verbatim means no newline was inserted into it.
    expect(plain()).toContain(LONG);
  });

  test("nothing leaves the normal screen buffer", () => {
    expect(transcript).not.toContain("\x1b[?1049h");
    expect(transcript).not.toContain("\x1b[2J");
  });

  test("the last frame is left behind, naming how the session ended", () => {
    // The footer is not erased on the way out: the roster as it stood is ordinary output afterwards.
    const tail = plain().slice(-600);
    expect(tail).toContain("api");
    expect(tail).toContain("support");
    expect(tail).toContain("exited (1)");
  });

  test("the roster reports time-to-ready rather than a running clock", () => {
    // `api` became ready at the same instant it spawned and stays at its own elapsed; a session clock
    // would have climbed past a second while the 300 lines were committed.
    expect(plain()).toMatch(/api\s+app\s+8787\s+ready\s+0\.0s/);
  });

  test("a drag repaints the footer once, when it settles, not once per resize", () => {
    // Every step of each drag was its own SIGWINCH — four of them on the way to 60 columns, twelve on
    // the way to 120. One repaint per settled size is the debounce working; one per step is the disease.
    expect(transcript.split(scrollScreenAway(ROWS)).length - 1).toBe(SETTLED.length);
  });

  test("a marker written at each settled size arrives once, in order", () => {
    const markers = [...plain().matchAll(/MARK-(\d+)/g)].map((m) => Number(m[1]));
    expect(markers).toEqual(SETTLED);
  });

  test("after the last repaint the screen holds one roster header", () => {
    // Cut at the last repaint: everything after it is drawn on a clean screen, and every frame since has
    // been erased by Ink's own count, which a byte stream never makes stale.
    const after = transcript.slice(transcript.lastIndexOf(scrollScreenAway(ROWS)));
    const frame = after.slice(after.lastIndexOf("\x1b[2K\x1b[1A")).replace(ANSI, "");
    expect([...frame.matchAll(/^\s+worker\s+kind/gm)]).toHaveLength(1);
  });
});
