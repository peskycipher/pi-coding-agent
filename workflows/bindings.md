# Bindings — how harness-agnostic role names become real tools

Every specialist document in this suite is written against **tool roles** (`glob`, `grep`,
`read`, `run-build`, `run-check`, `env-check`, `git-commit`, `git-info`, `test-edit`,
`docs-edit`, `notify`, …). The prose alone cannot execute anything: at install time the
roles must be bound to real tools, commands, and gates. Until now, every file said
"bind at install" without defining what that means. This document is the definition; all
"bind at install" phrases in the specialist docs refer here.

## The binding artifact

Bindings live in one YAML file per harness: `workflows/bindings/<harness-name>.yaml`
(e.g. `bindings/pi.yaml`). Production of that artifact is a developer-side spec change
(PR procedure); **the EO owns provisioning**: it validates the binding and applies it
when creating the sandbox (README §The two roles — Sandbox lifecycle). It is
committed under the suite's `spec/` PR procedure and reviewed like any spec change.
Nothing is "installed" that isn't reviewable here.

```yaml
harness: pi          # the runtime that will host the specialists
agents:              # one block per specialist actually deployed
  build:
    roles:
      run-build:     { command: "npm run build -- {target}", timeout_s: 900 }
      run-check:     { command: "npm test -- {name}", timeout_s: 300 }
      read-log:      { tool: read }
      workspace-read: { tools: [find, grep, read] }
      env-check:     { command: "node -v && npm -v" }
      git-commit:    { command: "git add {files} && git commit -m {message}",
                       env: { GIT_AUTHOR_NAME: "build-agent", GIT_AUTHOR_EMAIL: "build@suite.local" },
                       remote: null }          # MUST be null — see Remotes below
      notify:        { tool: message_internal }
    gates:
      install-deps:  { mechanism: approval, scope: declared-manifest-versions }
      workspace-edit: { mechanism: approval, scope: failing-step-blast-radius }
    budgets:
      per_dispatch:  { tool_calls: 15, seconds: 300 }   # feeds DISPATCH budget defaults
  test: { … }
  scout: { … }
  plan:  { … }
  docs:
    roles:
      docs-edit:     { tool: edit, gate: { mechanism: approval, scope: "docs/** paths; user-facing always reviewed" } }
      run-check:     { command: "npm run docs:check" }   # link checker + sample runner only
      read-log:      { tool: read }
      workspace-read: { tools: [find, grep, read] }
      git-info:      { command: "git log/blame (local, remoteless)" }
      notify:        { tool: message_internal, note: "requesting surface = IO in-suite; developer standalone" }
  steelman: { roles: {}, note: "text-in/text-out gate agent — no workspace tools by contract (adversarial design §Deployment model)" }
  contrarian: { roles: {}, note: "text-in/text-out; near-zero tools; runs on both EO-side (spec gate) and IO-side dispatches" }
```

## The docs `run-check` role (shared implementation)

The `docs` `run-check` role is the one role whose implementation is built once and shared between the
eval harness and production (test-eval-spec.md §8 Q9): `shared/docs-check.ts` is the link
checker + code-sample runner (the docs agent's detector 2). A repo configures it with a
root `docs-check.json` — `{ "runner": "docs-ci", "samples": true }` for the shared detector,
or `{ "command", "args" }` for a repo script; absent that, the binding's
`npm run docs:check` script is used, and the eval harness falls back to the same command.
The role returns a structured `{ passed, exitCode, failures[], checks[], source }` that the
docs specialist folds into its RESULT (`verdict.attested` for passing checks,
`verdict.stale_sections` for failing links/samples). Execution is read-only and path-jailed:
the command is allow-listed and every path-shaped argument must resolve inside the workspace.

## Required properties

1. **Role → executable map** — every role a specialist's `Tools` table lists maps to a
   real tool name, command template, or composition. `command` templates may use
   `{placeholders}` fed from the DISPATCH payload. A role listed by a deployed specialist
   and missing from the binding is a **configuration failure**, not a runtime fallback.
2. **Gate mechanisms** — every role the specialist marks `**gated**` maps to a named
   mechanism (`approval`, `allowlist`, `disabled`). A gate must be an enforcement in the
   harness (capability not dispatched / command refused), not prompt text — the same
   capability-not-dispatched rule the EO boundary applies to approvals
   (`orchestrator-external/design.md` §5).
3. **Budget wiring** — `budgets.per_dispatch` feeds the DISPATCH `budget` defaults; the
   TASK-level caps (`budget.wall_clock_task`, `budget.tokens_task`) come from the EO, not
   from bindings.
4. **Remotes** — git-touching roles (`git-commit`, `git-info`) bind to a sandbox-local git
   with **no remote configured** (`remote: null`); the binding validator must reject any
   value for `remote` on specialist roles. Push/PR/merge/tag belong to the EO alone
   (README §Version control conventions). This is the enforcement behind the trust rule,
   not a convention.
5. **Timeout defaults** — per-role `timeout_s` values default from EO-protocol §Timeouts
   (the single authority) and may only *tighten* them.

## Validator

A binding file is checked before a sandbox is provisioned: schema-checked (one required
key set per agent), gate mechanisms verified non-textual, git roles verified remoteless,
per-dispatch budgets inside the EO-protocol §Timeouts defaults. **Implemented**: the
validator lives in `shared/bindings.ts` (`validateBindingDocument` / `validateAgentBinding`,
pinned by `tests/bindings.test.ts`) and checks all four rules deterministically. It
consumes an already-parsed document — the bindings file is YAML, so callers parse it
first (js-yaml or equivalent); per-role timeout defaults are a role map (`run-build` 900 s,
`run-suite` 1800 s, others per the dispatch default) mirroring EO-protocol §Timeouts.
Harnesses without gate plugins must mark gated roles `disabled` (§2) — an `approval`
gate is provisioning at the harness, not prose.

## Worked example: this repository's runtime

This repo runs a single-task pi sandbox on Cloudflare Containers (`src/index.ts`).
Deploying the suite here means one binding file (`bindings/pi.yaml`) binding roles to
pi's tool set (read/find/grep/bash equivalents), gating by not provisioning write tools
to read-only agents, and wiring `notify` to the sandbox's internal message channel —
the same channel the EO protocol already uses.