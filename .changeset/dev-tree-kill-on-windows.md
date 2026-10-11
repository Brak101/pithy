---
"@pithy-sh/cli": patch
---

`pithy dev` ends its Workers on Windows. The children there are a chain — a `.cmd` shim, the `node` behind it, the `wrangler` behind that, and the `workerd` pair under it — and `process.kill` signals one pid, so a teardown killed the shim and the Workers reparented, kept their ports, and outlived the session; Ctrl-C now walks the child tree with `taskkill /T`, the pid as an argument and no shell. The stale-port sweep kills the same way.
