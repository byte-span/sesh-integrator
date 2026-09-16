# Security policy

## Supported versions

Security fixes target the latest released version. Older versions do not have a
separate maintenance commitment. Before a first public release, reports against
`main` or `dev` are welcome; include the exact commit SHA.

## Report a vulnerability

Please use GitHub's private vulnerability reporting for
[byte-span/sesh-integrator](https://github.com/byte-span/sesh-integrator/security/advisories/new)
when available. Do not disclose vulnerabilities in public issues or pull requests.
If private reporting is unavailable, open an issue titled "Private security
contact requested" with no vulnerability details, and wait for a maintainer to
provide a private channel before sharing the report.

Include the affected version or commit, operating system, relevant configuration
with secrets removed, impact, and a minimal reproduction using a disposable
repository. Do not include credentials, production data, private repositories,
or unredacted runtime logs. Coordinate public disclosure with the maintainers.
This project does not promise a fixed response time or a bug bounty.

## Trust boundaries

sesh-integrator runs Git, configured setup and validation commands, and optionally
AI harnesses with the permissions of the invoking user. A separate worktree is
not a security sandbox. Only run repository code and configuration you trust;
review commands before running them on untrusted contributions.

Nested harness calls may send source code and conflict context to the configured
provider. Review the selected harness's permissions and data handling before
using it with sensitive repositories. Keep production credentials out of agent
workspaces, test fixtures, and CI jobs executing untrusted code. Never expose
provider credentials to fork pull requests.

Runtime session records, logs, and recovery bundles can contain paths, source
content, and command output. Treat them as private and redact reports before
sharing. Preserve recovery data when investigating an incident; do not delete
locks or reset worktrees to bypass a failed safety check.
