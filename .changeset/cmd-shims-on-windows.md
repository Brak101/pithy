---
"@pithy-sh/cli": patch
---

`pithy add`, `pithy worker add`, and `pithy feature create` now install with the project's package manager on Windows, and `pithy dev`, `pithy deploy` and every wrangler call spawn through the same resolution. A `.cmd` shim runs through `cmd.exe` and an `.exe` spawns directly, so a Bun or pnpm install that ships real `.exe` files keeps working. `pithy dev` stops a `.cmd`-launched Worker's whole process tree on Windows, so no `workerd` keeps the port after the session.
