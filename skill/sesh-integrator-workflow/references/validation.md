# Proportionate validation

This workflow owns the general policy. Repository instructions should retain
only concrete validation commands, path lists and genuine project exceptions;
do not copy this policy into each project or independently maintained global
instruction sources. The installer distributes this reference with the skill.

Before an expensive validation run, inspect the complete change and the
repository's configured `validationTiers`, source and integration commands.
Use checks that exercise the affected behavior. Documentation and task-register
data normally need formatting/link checks and any existing schema/dependency
validator, rather than unrelated runtime builds and native tests. Executable
examples, generated inputs, packaged guidance and documentation used by the
application can need additional focused checks; an extension alone is not proof
that a file is inert.

Keep repository-specific selection in the integrator configuration. A lightweight
tier should allow only reviewed paths and supply their meaningful checks. The
CLI selects it only when every changed path matches. Mixed runtime, test,
build/validation tooling, dependency, migration or executable configuration
changes must retain appropriate code checks, using an explicitly configured code
tier or the full fallback. Do not broaden a docs tier to all JSON, all files in
a documentation folder, or executable examples merely to make it match.

When the configured checks are disproportionate and policy adjustment is within
the user's authorization, correct the configuration before running them. Inspect
existing project scripts and path usage, preserve custom tiers and explicit
stricter requirements, and explain the intended change. Use existing tier support;
coordinator code is needed only for a demonstrated missing capability. Keep the
full fallback intact. Verify positive lightweight cases and negative mixed-code
cases with the installed selection logic, then let `seshx validate` and integration
select and run the configured plan on the exact committed trees.

If changing policy is outside the authorized scope or its safety is unclear,
report the mismatch and proposed correction; do not silently weaken checks.
A policy correction is separate from a failed check: never hide a runtime failure
by relabeling its paths, deleting checks, substituting a smaller command manually,
or treating an interrupted run as successful. Record a changed configuration and
rerun validation through the CLI; preserve all existing session/recovery state.

Once the required selected checks pass, do not run unrelated full suites solely
because source promotion is next. Honor the integration selection, combined-tree
validation and any broader checks explicitly required by repository policy.
