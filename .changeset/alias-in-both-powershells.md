---
"@pithy-sh/cli": patch
---

`pithy alias` installs the `p.` alias into both PowerShell profiles, not just one. Windows has two PowerShell families — 5.1, which ships with Windows and auto-loads `Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`, and 7, which loads `Documents\PowerShell\…` — and no single file loads in both, so the alias landed in a file most Windows sessions never read. Install now writes the marked block to each family's profile (an old single-family install is topped up, not refused), status and doctor read the set, and remove takes it out of both, leaving every other line byte-identical. Reports name the files they act on — install names what it wrote, status names what carries the block, remove names what it removed from — and `--json` payloads carry the full set as `rcPaths` plus a `wrote` list. The 5.1 profile joins the set on Windows, where it exists.
