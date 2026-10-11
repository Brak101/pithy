---
"@pithy-sh/cli": patch
---

`pithy` starts the project's package manager, its `exec` runners, and wrangler through a PATH-and-PATHEXT resolution on Windows, the way a shell picks a program up: `pithy add`, `pithy worker add`, and `pithy feature create` install, the `pithy dev` workers and every wrangler call they spawn, and the `pithy deploy` UI build. A `.cmd` shim runs through `cmd.exe` and an `.exe` spawns directly, so the install that died with `ENOENT` on every Windows machine (#698) runs — and a Bun or pnpm install that ships real `.exe` files keeps working.
