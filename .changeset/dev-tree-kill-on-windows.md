---
"@pithy-sh/cli": patch
---

`pithy dev` stops its Workers on Windows, so no `workerd` keeps a port after the session.
