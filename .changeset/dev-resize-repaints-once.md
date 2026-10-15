---
"@pithy-sh/cli": patch
---

Resizing the window while `pithy dev` runs no longer stacks stale roster headers on the screen. During a drag the roster is erased and stays erased — nothing repaints at a size the terminal has already left behind. Once the size has held for 150 ms the roster is drawn once, at the final width, and a drag that crossed more than one size rebuilds the visible screen under it: your output above the roster is restated in place at the new width, and lines that had scrolled up keep their single copy in scrollback. The rebuild's erase covers the visible screen, so the first drag in a fresh terminal erases the shell output on screen above `pithy dev`'s first line; it does not return to scrollback.
