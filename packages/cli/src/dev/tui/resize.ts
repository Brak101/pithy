// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useApp, useStdout } from "ink";
import { useEffect } from "react";
import type { DevStore } from "./store";

/** Ink's cursor intent for the live region: its first row, its first column. */
export const TOP_LEFT = { x: 0, y: 0 };

/** Erase from the cursor to the end of the screen. Never `\x1b[2J`, which reaches above it. */
const ERASE_BELOW = "\x1b[J";

/**
 * Erase from the start of the viewport through the cursor — the anchor. Scrollback is out of reach,
 * which is the point: what this erases is visible history, and the rebuild restates it.
 */
const ERASE_ABOVE = "\x1b[1J";

/** Carriage return, home. A rebuild's restatement starts at row 1. */
const HOME = "\x1b[H";

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
 * Whether a resize burst is open right now. `app.tsx`'s stdout proxy consults it inside every `resize`
 * listener registered through that proxy, which is how Ink is muted *before* the event reaches it.
 */
let burstOpen = false;
export function isResizeBurstOpen(): boolean {
  return burstOpen;
}

/**
 * The rows `text` occupies on a terminal `columns` wide: every line of it is at least one row, and
 * every terminal-width of visible text beyond that is one more. Escape sequences occupy no columns —
 * the whole alphabet of them, since a recorded frame carries `eraseLines` and cursor movement, not
 * just color. This is the terminal's own arithmetic — the soft wrap the committed stream does as it is
 * written, and what a clipped frame's long line will do at a narrower width — and it is what #760's
 * finding 5 asked the rebuild's restatement to count: lines are not rows, and one 150-column
 * `wrangler` line is three rows at 60 columns.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI ESC (\x1b) is the point — a row count must see columns, not escapes.
const ESCAPES = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export function rowsAt(text: string, columns: number): number {
  const lines = text.replace(ESCAPES, "").split("\n");
  // A trailing newline opens no line of its own; `split` counts one.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
}

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
 * **Nothing Ink owns writes rows inside a burst.** The real-WT drag trace (`C:\tmp\drag736`) is the
 * witness: through a 79→58 shrink its 56 cursor reports march the anchor down row by row, 21, 22, 23,
 * …, 30, as the rewrap pushes rows in above the live region, while Ink keeps repainting as if the frame
 * sat at row 22. Each of those mid-burst repaints writes the frame's rows at the *terminal's* cursor —
 * once the anchor reaches the viewport's last row, the repaint's trailing newline scrolls, and every
 * scroll pushes one row (a rule, a header, a stream line) into scrollback for good. The settled screen
 * is clean; the user drags, scrolls up, and sees the staircase and the duplicated stream lines the
 * scrolls pushed. The emulator suite never saw it because it reads the viewport, and the pushes land
 * above it.
 *
 * Muting has to happen **before the event arrives**: Node's `EventEmitter.emit` iterates a copy of the
 * listener array, so a handler cannot unhook a sibling from inside the same emit. The seam is
 * subscription-time — `app.tsx`'s stdout proxy wraps every `resize` listener registered through it
 * (Ink's included), and the wrapper skips the real handler while {@link isResizeBurstOpen} says a burst
 * is open. The erase handler is prepended, so it opens the burst first in every emit, and the settle
 * closes it.
 *
 * **A burst of more than one event gets the viewport rebuilt at the settle, and the suite says why.**
 * Removing the rebuild entirely was tried for #760: two identical runs of `devTui.windows.test.ts`, one
 * green at its full-buffer counts, one leaving a wrapped tail — a rule fragment — in the buffer. A
 * frame whose rows at the *new* width overflow the viewport's last row pushes its own tail past the
 * count Ink recorded, and the anchored sweep walks down only as far as the count sees. So at the settle
 * of a drag: erase from the viewport's first row down to the anchor (`ESC[1J` — it stops at the cursor,
 * and the scrollback above the viewport is load-bearing history; on-screen shell output *above* the
 * session's first line is erased with the visible stream, which is the cost this shape accepts and
 * `docs/ACCEPTED-LIMITS.md` records), home, and restate the visible tail of the committed stream from
 * the store — **measured in rows at the new width**, budgeted so the restatement plus the footer fit
 * the viewport with a row to spare: a repaint that overflows is how a restated copy gets scrolled into
 * scrollback, duplicating what the rebuild exists to keep single. The frame's rows come from the last
 * frame's own string (`frame.last` — `app.tsx`'s proxy records it), counted through the same
 * {@link rowsAt}, not from a cast into Ink's internals: `render()` returns `{ rerender, unmount, ... }`
 * and has no `lastOutputHeight` to read (#760's finding 1). Then the anchored erase, and one repaint.
 * A burst of one resize event needs no rebuild — a single size change strands nothing above the
 * anchor's sweep, and the human's slow drag is exactly that.
 *
 * A settle that fires while a previous suspension is still in flight is **queued, not run**: Ink's
 * `beginSuspend` throws on a nested suspension, and the erase this settle already wrote would leave the
 * roster blank with nothing left to redraw it (the spinner has stopped by then). The queue replays the
 * trailing repaint the moment the flight lands, at the newest geometry — the `repainting` guard of the
 * #744 code, in the shape a burst needs.
 *
 * The terminal is never handed away for the length of a drag: `suspendTerminal` pauses stdin, and a
 * stdin that stops consuming is a stdin that stops learning sizes — ConPTY coalesces the resize records
 * it queued in the meantime, and the app settles for a geometry it was never told about (measured: a
 * 50-column settle delivering the app 76 and 52 and nothing between).
 */
export function useEraseOnResize(reanchor: () => void, store: DevStore, frame: { last: string }): void {
  const { stdout } = useStdout();
  const { suspendTerminal } = useApp();
  useEffect(() => {
    // Ink subscribes to `resize` only on an interactive terminal, and so does this. Ink's test is its own
    // and not `choose.ts`'s: a TTY, outside what `is-in-ci` calls CI.
    if (!stdout?.isTTY || inkSeesCi()) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Events since the last settle: one is a size change, two are a drag, and only drags strand rows.
    let burst = 0;
    // The suspension the last settle started, if it has not landed yet, and the settle queued behind it.
    let inFlight: Promise<void> | undefined;
    let queued = false;

    const settleNow = () => {
      settle = undefined;
      // A settle behind an open suspension would make `beginSuspend` throw *after* the burst's
      // erases have cleared the roster — swallowed, and the roster stays blank. Queue it instead.
      if (inFlight) {
        queued = true;
        return;
      }
      // The burst's one repaint, at the final geometry. Close the burst first: the erase below must
      // not be steered by the very flag this path owns, and a `resize` event arriving mid-paint
      // re-opens the burst through `erase` (prepended, so it always wins the race inside an emit).
      burstOpen = false;
      const rebuild = burst > 1;
      burst = 0;
      // `suspendTerminal` erases Ink's last frame, and that erase owns the return to the frame's
      // bottom: `beginSuspend`'s `log.clear()` starts with ink's own return-to-bottom prefix — the
      // cursor is shown at the frame's first cell, and the prefix steps down to its last row before
      // the `eraseLines` walks back up. No step-down is written here; adding one lands the walk on
      // the wrong rows (#760's finding 2 — #736's symptom, on the path that needs no rebuild).
      inFlight = suspendTerminal(() => {
        if (rebuild) {
          // Clear the viewport from its first row down to the anchor — the visible stream and
          // everything the drag stranded in it — and restate the visible tail, oldest first, in rows
          // measured at the new width. The budget leaves the footer a viewport that fits: a
          // restatement plus a frame that overflow the last row scroll, and every scroll pushes a
          // restated copy into scrollback (#760's finding 5).
          stdout.write(ERASE_ABOVE);
          stdout.write(HOME);
          const columns = stdout.columns ?? FALLBACK_COLUMNS;
          const viewportRows = stdout.rows ?? FALLBACK_ROWS;
          const budget = Math.max(0, viewportRows - rowsAt(frame.last, columns) - 1);
          const lines = store.state().lines;
          let start = lines.length;
          let rows = 0;
          while (start > 0) {
            const prev = lines[start - 1];
            if (!prev) break;
            const next = rowsAt(prev.text, columns);
            if (rows + next > budget) break;
            rows += next;
            start -= 1;
          }
          for (const line of lines.slice(start)) stdout.write(`${line.text}\n`);
        }
        stdout.write(ERASE_BELOW);
        reanchor();
      })
        .catch(() => {
          // The screen is mid-erase; the queue below repaints, and a permanently unwritable stdout
          // surfaces through Ink's own exit path, not through a resize timer.
        })
        .finally(() => {
          inFlight = undefined;
          if (queued) {
            queued = false;
            schedule();
          }
        });
    };

    const schedule = () => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(settleNow, RESIZE_SETTLE_MS);
    };

    const erase = () => {
      // First in every emit (prepended), so the flag is open before any wrapped listener runs.
      burst += 1;
      burstOpen = true;
      // Direct, and on every event: an erase writes no rows and scrolls nothing, the viewport stays
      // clean through the burst, and the terminal stays in Ink's hands so the resize records keep
      // flowing. Ink's resize paint is skipped by the subscription-time wrapper (see the docstring) —
      // a paint is the only thing that scrolls, and the burst's paint at the settle is the one above.
      stdout.write(ERASE_BELOW);
      schedule();
    };

    stdout.prependListener("resize", erase);
    return () => {
      stdout.off("resize", erase);
      if (settle) clearTimeout(settle);
      burstOpen = false;
    };
  }, [stdout, suspendTerminal, reanchor, store, frame]);
}

/** §9's fallbacks, for a stream that will not say its size. */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

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
