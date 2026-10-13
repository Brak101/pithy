# Security

## Reporting a vulnerability

**Report it privately, at [github.com/pithy-sh/pithy/security/advisories/new](https://github.com/pithy-sh/pithy/security/advisories/new). Never as a public issue, pull request or discussion.** A public report is readable by everyone running an unpatched Worker before a fix exists.

Say what is exposed, the version, and the steps or code that show it. A proof of concept against your own project is welcome. One against anyone else's is not.

We confirm receipt, agree a disclosure date with you, and credit you in the advisory unless you would rather we did not.

## Scope

Every `@pithy-sh/*` package and the `pithy` CLI, as published from this repository. Pithy runs in your own Cloudflare account, so a flaw in Cloudflare itself goes to [Cloudflare](https://www.cloudflare.com/disclosure/), and a flaw in a dependency goes to its maintainers first.

## Supported versions

Pithy is on `0.x`. A fix ships in the next release of the affected packages and is not backported. Its changeset carries a `Security:` line naming what was exposed, so the changelog says which releases to upgrade past.
