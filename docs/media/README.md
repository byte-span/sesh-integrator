# README terminal animation

[Back to the README](../../README.md)

`workflow.gif` is an illustrative mockup generated with
[Charm VHS](https://github.com/charmbracelet/vhs), not a recording of seshx output.
The commands match the CLI; output and timing are condensed for the introduction.
The text fixture calls no Git commands, coding harnesses, or external services.
It demonstrates committed work moving through validation and integration while
other worktrees remain independent. It does not simulate conflict recovery or PRs.

## Regenerate

The checked-in animation uses VHS **0.10.0**, DejaVu Sans Mono, and the
Catppuccin Mocha theme. Run from `docs/media`, using the official Docker image
with dependencies included. No desktop or display server is required.

macOS / Linux:

```bash
cd docs/media
docker run --rm --network none -v "$PWD:/vhs" ghcr.io/charmbracelet/vhs:v0.10.0 workflow.tape
```

Windows PowerShell, with Docker configured for Linux containers:

```powershell
Set-Location docs/media
docker run --rm --network none -v "${PWD}:/vhs" ghcr.io/charmbracelet/vhs:v0.10.0 workflow.tape
```

Docker needs network access for the initial image pull; rendering runs offline.
Alternatively, install VHS 0.10.0 and its dependencies (ttyd, FFmpeg, and an
available Chromium browser), then run `vhs workflow.tape` from this directory.
Use the Docker route to keep the font and rendering environment consistent.

`workflow.tape` controls styling, typing, and pauses. `workflow.sh` defines
shell-local presentation functions; source it only inside the recording shell.
It shadows `seshx` for the fixture and never invokes an installed CLI.
The render produces `workflow.gif` and a static final frame, `workflow.png`.
Commit both assets after reviewing legibility and timing. Normal tests and
package installation do not require VHS or Docker.

## Text equivalent

1. Three tasks work independently: search is committed; keyboard and docs continue.
2. In the search worktree, `seshx validate` checks the source commit.
3. `seshx integrate --summary "Add search" --rollout none` acquires the lock,
   merges the exact commit, validates the combined result, and promotes it to `dev`.
4. The lock is released. Other agents keep their own worktrees.
