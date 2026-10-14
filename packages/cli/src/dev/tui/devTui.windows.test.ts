// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IPty, spawn } from "@lydell/node-pty";
import headless from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { devTuiHarness, harnessEnv } from "../../test-utils/devTuiHarness";
import { requireWindows } from "../../test-utils/windows";

requireWindows();

/**
 * **#736 on a real ConPTY: resizing the window while `pithy dev` runs.**
 *
 * Ink repaints the footer by erasing the rows it drew last time, counted from the cursor. ConPTY rewraps
 * its buffer on a resize, so the count goes stale and the erase lands on the wrong rows: on a drag, every
 * spinner-tick repaint left the previous roster's rule and header behind, stacking up the screen. The fix
 * redraws the footer from a clean viewport once the size settles (`useRepaintOnResize` in `app.tsx`).
 *
 * The Linux pty test cannot see this. It reads the bytes the program wrote, and a byte stream does not
 * rewrap — only a terminal does. So this one runs where the rewrap happens: a real pseudoconsole, resized
 * from the host side exactly as Windows Terminal resizes one, around the real store and the real
 * `startTui`.
 *
 * **What it reads is the screen, not the transcript.** ConPTY is not a pipe: it renders its own buffer and
 * re-emits it, so after a resize the same line arrives many times in the bytes (twenty copies of one marker
 * were measured). Stripping escapes from that stream says nothing about what anyone sees. The bytes go
 * through `@xterm/headless`, a terminal emulator resized in step with the pseudoconsole, and the assertions
 * read its viewport.
 *
 * **ConPTY is the one node-pty bundles** (`useConptyDll`), the OpenConsole that ships with Windows
 * Terminal, rather than whichever one the runner's Windows build carries. Same terminal stack on every
 * machine, and the one the bug was reported on.
 *
 * The harness drives the session from the keyboard, as `pithy dev` is driven: `1` asks it to commit a
 * marker naming the width it sees, `q` quits. A footer that lost its keys across the repaint would drop
 * the marker, so that is checked too.
 */

/** Where `bun` is — the harness imports `.ts`/`.tsx` deep paths, which only Bun runs. ConPTY wants a path. */
function bunPath(): string {
  const found = execFileSync("where.exe", ["bun"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
  if (!found) throw new Error("bun is not on PATH.");
  return found;
}

const COLUMNS = 80;
const ROWS = 24;

/** Wide to narrow to wide, twice: both directions of the rewrap, at sizes the footer lays out differently. */
const SIZES = [50, 120, 60, 100];

/** A drag, not a jump: the window manager sends a resize per few pixels, a few dozen per drag. */
const DRAG_STEP = 4;
const DRAG_INTERVAL_MS = 25;

/** A pause after each drag, well past the repaint's 150 ms debounce, before the marker is asked for. */
const SETTLE_MS = 1_000;

/**
 * How long a marker and the footer drawn under it may take to reach the screen. A ceiling, not a sleep:
 * the wait ends the moment the screen shows both, and a runner under load gets the time it needs. Past
 * it, the assertions read whatever is there.
 */
const SCREEN_CEILING_MS = 10_000;

const HARNESS = devTuiHarness({
  keys: true,
  onDigit: `() => store.line("MARK-" + process.stdout.columns, "api")`,
  onQuit: "() => void tui.stop().then(() => process.exit(0))",
  script: `
for (let i = 0; i < 40; i++) store.line("L" + i, "api");
store.line("HARNESS-READY", "api");
`,
});

const rest = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let workspace: string;
let pty: IPty | undefined;
let viewport: string[];
let markers: string[];
let exitCode: number | undefined;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "pithy-devtui-conpty-"));
  const harness = join(workspace, "harness.ts");
  writeFileSync(harness, HARNESS);

  const terminal = new headless.Terminal({ cols: COLUMNS, rows: ROWS, scrollback: 5_000, allowProposedApi: true });
  let bytes = "";
  const session = spawn(bunPath(), [harness], {
    cols: COLUMNS,
    rows: ROWS,
    cwd: workspace,
    env: { ...harnessEnv(), NO_COLOR: "1" },
    useConptyDll: true,
  });
  pty = session;
  session.onData((data) => {
    bytes += data;
    terminal.write(data);
  });
  // The terminal answers what it is asked. OpenConsole opens with a device-attributes query and holds
  // the keyboard until a reply arrives, as it would from Windows Terminal.
  terminal.onData((reply) => session.write(reply));
  const exited = new Promise<number>((resolve) => session.onExit(({ exitCode }) => resolve(exitCode)));

  const deadline = Date.now() + 60_000;
  while (!bytes.includes("HARNESS-READY")) {
    if (Date.now() > deadline) throw new Error(`The harness never became ready. It wrote: ${JSON.stringify(bytes)}`);
    await rest(50);
  }
  await rest(SETTLE_MS);

  // What the screen shows: the last ROWS lines of the buffer, after everything sent has been parsed.
  const screen = async (): Promise<string[]> => {
    await new Promise<void>((resolve) => terminal.write("", resolve));
    const buffer = terminal.buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
    ).slice(-ROWS);
  };
  // Settled, for one size: its marker is on screen with a whole footer under it — a header, the `api` row
  // and the rule that closes it, in that order. Not "exactly one footer": that is the claim under test,
  // and a wait that required it would turn a stacked screen into a timeout instead of a failure that
  // shows it.
  const settled = (lines: string[], marker: string) => {
    const at = lines.map((line) => line.includes(marker)).lastIndexOf(true);
    if (at === -1) return false;
    const header = lines.findIndex((line, index) => index > at && HEADER.test(line));
    const api = lines.findIndex((line, index) => index > header && /api\s+app\s+8787\s+ready/.test(line));
    return header !== -1 && api !== -1 && lines.some((line, index) => index > api && RULE.test(line));
  };

  const resize = (columns: number) => {
    session.resize(columns, ROWS);
    terminal.resize(columns, ROWS);
  };
  let columns = COLUMNS;
  for (const target of SIZES) {
    const step = target > columns ? DRAG_STEP : -DRAG_STEP;
    for (let at = columns + step; step > 0 ? at < target : at > target; at += step) {
      resize(at);
      await rest(DRAG_INTERVAL_MS);
    }
    resize(target);
    columns = target;
    await rest(SETTLE_MS);
    session.write("1");
    const until = Date.now() + SCREEN_CEILING_MS;
    while (!settled(await screen(), `MARK-${target}`) && Date.now() < until) await rest(100);
  }

  // Everything the terminal holds, scrollback and screen, flushed through the emulator's parser first.
  await new Promise<void>((resolve) => terminal.write("", resolve));
  const buffer = terminal.buffer.active;
  const lines = Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  );
  viewport = lines.slice(-ROWS);
  markers = lines.flatMap((line) => line.match(/MARK-\d+/g) ?? []);

  session.write("q");
  exitCode = await Promise.race([exited, rest(15_000).then(() => undefined)]);
}, 180_000);

afterAll(() => {
  try {
    pty?.kill();
  } catch {
    // Already gone, which is the expected case: `q` ended it.
  }
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/** A roster header, as the footer draws it: dim, then two spaces, then the column names. */
const HEADER = /^\s*worker\s+kind\s/;
/** The footer's rule: a run of box-drawing dashes, possibly cut short with an ellipsis at a narrower width. */
const RULE = /^─{8,}/;

describe("the live footer on ConPTY, resized while it runs", () => {
  test("the settled screen holds exactly one roster header", () => {
    expect(
      viewport.filter((line) => HEADER.test(line)),
      viewport.join("\n"),
    ).toHaveLength(1);
  });

  test("and exactly one footer: its two rules, no stale ones stacked above", () => {
    // The staircase is rules as much as headers: a stale frame leaves its top rule behind even where its
    // header was erased, so a header count alone can read 1 over a screen of debris.
    expect(
      viewport.filter((line) => RULE.test(line)),
      viewport.join("\n"),
    ).toHaveLength(2);
  });

  test("the footer on the settled screen is the current one", () => {
    const header = viewport.findIndex((line) => HEADER.test(line));
    expect(viewport[header + 1]).toMatch(/api\s+app\s+8787\s+ready/);
    expect(viewport[header + 2]).toMatch(/support\s+\S+\s+8790/);
  });

  test("a marker committed at every settled size survives, in the order the sizes came", () => {
    // ConPTY can repaint a line it already sent while it reflows, so a marker may appear more than once in
    // the emulator's scrollback. What matters is that none was erased, and that the stream did not reorder.
    const firstSeen = markers.filter((marker, index) => markers.indexOf(marker) === index);
    expect(firstSeen).toEqual(SIZES.map((columns) => `MARK-${columns}`));
  });

  test("the keys still work after the repaints, and q ends the session", () => {
    expect(exitCode).toBe(0);
  });
});
