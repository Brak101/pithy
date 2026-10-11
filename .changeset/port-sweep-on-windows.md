---
"@pithy-sh/cli": patch
---

The stale dev-port sweep finds its port holders on Windows. The sweep shelled out to `lsof` and `ps`, which Windows does not have, and read a missing binary as "nothing holds this port" — so a `workerd` that outlived a crashed session reaped nothing, and every later `pithy dev` died on "port in use" naming no pid. The holder now comes from `netstat -ano` (listening rows only — a client connection to the port is not a holder of it), and the scope filter's command line from CIM, with quoted paths split the way CIM writes them.
