// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { appendFileSync } from "node:fs";
import { useApp, useStdout } from "ink";
import { useEffect } from "react";
import type { DevStore } from "./store";

/** Ink's cursor intent for the live region: its first row, its first column. */
export const TOP_LEFT = { x: 0, y: 0 };

/** Erase from the cursor to the end of the screen. Never `\x1b[2J`, which reaches above it. */
const ERASE_BELOW = "\x1b[J";

/** Erase from the start of the viewport through the cursor. The scrollback is out of reach, which is the point. */
const ERASE_ABOVE = "\x1b[1J";

/** Carriage return, home. Rebuilds start at row 1. */
const HOME = "\x1b[H";

/** Down `n` rows, staying in the column — Ink's own step from a frame's top row down to its last. */
const DOWN = "\x1b[B";

/** Ask the terminal where the cursor is; the answer arrives on stdin as `ESC[<row>;<col>R`. Measurement only. */
const CURSOR_QUERY = "\x1b[6n";

/**
 * #736's trace rig: with `PITHY_TUI_TRACE=<file>` set, every write to the terminal, every resize event,
 * and the terminal's own cursor answers are appended to that file. Unset, the string is `undefined` and
 * every trace call is a no-op.
 */
export const TUI_TRACE_ENV = "PITHY_TUI_TRACE";

const TRACE_FILE = process.env[TUI_TRACE_ENV];

export function trace(what: string): void {
  if (TRACE_FILE) appendFileSync(TRACE_FILE, `${String(process.hrtime.bigint() / 1000n).padStart(12, "0")} ${what}\n`);
}

/**
 * Whether Ink believes it is running in CI, by the rule Ink uses (`is-in-ci`): `CI` or
 * `CONTINUOUS_INTEGRATION` present and neither `0` nor `false`. Ink then renders non-interactively —
 * no live frame, no `resize` listener — even on a TTY.
 */
function inkSeesCi(): boolean {
  return ["CI", "CONTINUOUS_INTEGRATION"].some(
    (key) => key in process.env && process.env[key] !== "0" && process.env[key] !== "false",
  );
}

/**
 * A drag's trailing edge: the window manager sends a resize every few pixels — the ConPTY test drags at
 * 25 ms steps, a human's mouse at a slower cadence — and the burst is over when events stop arriving.
 * A repaint *inside* a burst draws at a geometry the terminal has already left behind, and the rows the
 * reflow pushes past the viewport bottom on its way to the next size land in scrollback for good: the
 * staircase measured one stale rule per drag step, each 4 columns narrower than the last. The repaint
 * answers the final size and only that one. Erasing is cheap and moves nothing, so the burst erases on
 * every event and repaints on none.
 */
const RESIZE_SETTLE_MS = 150;

/**
 * **Keep the cursor on the live region's first cell, erase from there on every resize, and repaint once
 * when the drag settles (#736).**
 *
 * Ink repaints the footer by moving the cursor up the number of rows it drew last time and erasing them.
 * A terminal that rewraps on resize — ConPTY does, and so does any terminal that reflows — moves those
 * rows, so the count goes stale and the erase lands on the wrong ones. Three repairs on #741 tried to
 * make the count right. The terminal never says what it is.
 *
 * It does say one thing, without being asked: where the cursor is. A terminal that reflows carries the
 * cursor with the cell under it. So the cursor rests on the live region's first cell — Ink's own
 * `useCursor`, at `TOP_LEFT` — and the region's start is wherever the terminal put the cursor. Ink's erase
 * then starts from that cell, goes down the frame and back up to it, and cannot reach above it: the
 * committed stream is out of reach of any count, stale or not.
 *
 * What a stale count can still miss is below the anchor, so every resize erases that too, from the anchor
 * to the end of the screen, with no count at all — an erase writes no rows and scrolls nothing, so one
 * per event keeps the viewport clean all the way through the drag. The repaint waits for the burst to
 * settle, because a repaint is the only writer that moves the screen: Ink's resize handler erases by its
 * stale count and the redraw's trailing newline pushes a row the reflow had no room for, and a drag is
 * thirty of those in a second — measured, one stale rule in scrollback per 4 columns of shrink. One
 * erase per event, one repaint per burst, the repaint at the final geometry.
 *
 * A burst that outlives its own erases gets the screen rebuilt when it settles: the viewport is cleared
 * and the visible tail of the committed stream is restated from the store, in order, before the repaint.
 * That is for the rows no anchored erase can reach — a frame repainted at a geometry the terminal had
 * already reflowed strands its own rule a row *above* the anchor, and the anchor's erase sweeps down,
 * never up. The erasure reaches only the visible rows (`ESC[1J` stops at the cursor, and the scrollback
 * above the viewport is load-bearing history); the restatement writes exactly what it erased, so the
 * committed stream keeps every line, appears once, and never grows copies in scrollback per cycle. A
 * burst of one resize event needs no rebuild — a single size change leaves nothing above the anchor to
 * clear, and the human's slow drag is exactly that.
 *
 * **Nothing writes rows inside a burst — including Ink.** The real-WT drag trace (`C:\tmp\drag736`)
 * is the witness: through a 79→58 shrink its 56 cursor reports march the anchor down row by row, 21,
 * 22, 23, …, 30, as the rewrap pushes rows in above the live region, while Ink keeps repainting as if
 * the frame sat at row 22. Each of those mid-burst repaints writes the frame's rows at the
 * *terminal's* cursor — once the anchor reaches the viewport's last row, the repaint's trailing
 * newline scrolls, and every scroll pushes one row (a rule, a header, a stream line) into
 * scrollback for good. The
 * settled screen is clean; the user drags, scrolls up, and sees the staircase and the duplicated
 * stream lines the scrolls pushed. The emulator suite never saw it because it reads the viewport,
 * and the pushes land above it. So Ink's own `resize` listener is unhooked for the length of the
 * burst and re-hooked at the settle, where the repaint below happens once, at the final geometry.
 * Nothing writes rows during a burst, so nothing scrolls, so nothing is pushed: the rebuild's
 * restatement then repeats lines the drag never sent to scrollback, and they stay single.
 *
 * The terminal is never handed away for the length of a drag: `suspendTerminal` pauses stdin, and a
 * stdin that stops consuming is a stdin that stops learning sizes — ConPTY coalesces the resize records
 * it queued in the meantime, and the app settles for a geometry it was never told about (measured: a
 * 50-column settle delivering the app 76 and 52 and nothing between).
 */
export function useEraseOnResize(reanchor: () => void, store: DevStore, frameRows: () => number): void {
  const { stdout } = useStdout();
  const { suspendTerminal } = useApp();
  useEffect(() => {
    // Ink subscribes to `resize` only on an interactive terminal, and so does this. Ink's test is its own
    // and not `choose.ts`'s: a TTY, outside what `is-in-ci` calls CI.
    if (!stdout?.isTTY || inkSeesCi()) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Events since the last settle: one is a size change, two are a drag, and only drags strand rows.
    let burst = 0;
    // Ink's `resize` listeners, taken out for the length of a burst and put back at its settle.
    type ResizeListener = (this: unknown, ...args: unknown[]) => void;
    const muted: ResizeListener[] = [];
    const muteInk = () => {
      for (const listener of stdout.listeners("resize") as ResizeListener[]) {
        if ((listener as unknown) === (erase as unknown)) continue;
        stdout.off("resize", listener);
        muted.push(listener);
      }
    };
    const unmuteInk = () => {
      for (const listener of muted.splice(0)) stdout.on("resize", listener);
    };
    const erase = () => {
      trace(`resize ${stdout.columns}x${stdout.rows}`);
      burst += 1;
      // Direct, and on every event: an erase writes no rows and scrolls nothing, the viewport stays
      // clean through the burst, and the terminal stays in Ink's hands so the resize records keep
      // flowing. Ink's repaint is muted for the burst — a repaint is the only thing that scrolls (see
      // the note above), and the burst's repaint at the settle is the one this handler owns.
      muteInk();
      stdout.write(ERASE_BELOW);
      if (TRACE_FILE) stdout.write(CURSOR_QUERY);
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = undefined;
        const rebuild = burst > 1;
        burst = 0;
        // The burst's one repaint, at the final geometry. `suspendTerminal` erases Ink's last frame
        // and hands us the terminal; the erase below catches the rows the reflow rewrapped after the
        // cursor was anchored — the frame at the new width is taller than at the old one — and the
        // anchor is restated so Ink's forced redraw carries the cursor back to it.
        trace(`settled ${stdout.columns}x${stdout.rows}${rebuild ? " (rebuild)" : ""}`);
        // Stand on the live region's last row before Ink erases its frame. The erase (Ink's
        // `log.clear()`, a cursor-relative count of rows ending at the cursor) and the repaint that
        // follows it are both anchored to where Ink left the cursor — the frame's first body row,
        // the target of its `ESC[<rows-1>A` frame suffix. When a drag's reflow has dragged the real
        // cursor away from that cell, the count erases the stream above the frame and the footer
        // repaints too high, so the footer creeps and stream lines get eaten. `rows-1` steps down
        // puts the cursor back on the frame's last row, exactly where Ink's own repaint prefix would
        // put it — Ink's return-to-bottom step, restated from the app side. (`ESC[B` clamps at the
        // viewport bottom, which is where a dragged-down cursor has been; the rebuild's `ESC[1J` +
        // restatement covers it.)
        for (let i = 1; i < Math.max(1, frameRows()); i++) stdout.write(DOWN);
        suspendTerminal(() => {
          if (rebuild) {
            // Clear the viewport — the visible stream and everything the drag stranded in it — and
            // restate the visible tail of the stream, oldest first, where the erased rows were. The
            // scrollback above keeps its own copies; that is history, and history is append-only here.
            stdout.write(ERASE_ABOVE);
            stdout.write(HOME);
            const rows = (stdout.rows ?? 24) - frameRows() - 1;
            for (const line of store.state().lines.slice(Math.max(0, store.state().lines.length - rows))) {
              stdout.write(`${line.text}\n`);
            }
          }
          stdout.write(ERASE_BELOW);
          if (TRACE_FILE) stdout.write(CURSOR_QUERY);
          reanchor();
          unmuteInk();
        }).catch(() => {
          unmuteInk();
        });
      }, RESIZE_SETTLE_MS);
    };
    // First, so the erase lands before Ink's own handler repaints.
    stdout.prependListener("resize", erase);
    const reportCpr = (data: Buffer | string): void => {
      // The escape is built at runtime: Biome bans control characters in regex literals, and the
      // formatter expands a `new RegExp` string right back into one.
      const answer = new RegExp(`${"\x1b"}\\[(\\d+);(\\d+)R`).exec(String(data));
      if (answer) trace(`cursor ${answer[1]}x${answer[2]}`);
    };
    if (TRACE_FILE) process.stdin.on("data", reportCpr);
    return () => {
      stdout.off("resize", erase);
      unmuteInk();
      if (settle) clearTimeout(settle);
      if (TRACE_FILE) process.stdin.off("data", reportCpr);
    };
  }, [stdout, suspendTerminal, reanchor, store, frameRows]);
}
