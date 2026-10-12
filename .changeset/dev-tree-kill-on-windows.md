---
"@pithy-sh/cli": patch
---

`pithy dev` ends its Workers on Windows. The children there are a chain — a `.cmd` shim, the `node` behind it, the `wrangler` behind that, and the `workerd` pair under it — and `process.kill` signals one pid, so a teardown killed the shim and the Workers reparented, kept their ports, and outlived the session. Ctrl-C now walks the child tree with `taskkill /T /F`, the pid as an argument and no shell — the tree walk of `/T` alone is refused on a windowless console process (`can only be terminated forcefully`), measured on a Windows host — and it reaches only the children this session spawned: pids read from a crashed session's state file get a plain signal, because a recycled pid's tree is somebody else's.
