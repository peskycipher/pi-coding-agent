# Build Agent — Workflow Definition

End-to-end operation of the build agent: an autonomous agent that triggers builds,
monitors them, reads logs, diagnoses failures, performs safe fixes or retries, and reports
outcomes. Tool-agnostic: the agent drives a small set of tool roles that bind to
make/npm/gradle/cargo (and similar) per workflows/bindings.md.

## Tool roles (bindings per workflows/bindings.md)

| Role | Binds to (examples) | Gated? |
|---|---|---|
| `run-build` | `make`, `npm run build`, `gradle build`, `cargo build` | no |
| `run-check` | `npm test -- <failing>` , `make <target>`, `cargo test <failing>` | no |
| `read-log` | build/test log files, CI log fetch | no |
| `workspace-read` | glob/grep/read files | no (parallel-safe) |
| `env-check` | version probes (`node -v`, `java -version`, `rustc -V`), presence checks | no |
| `install-deps` | `npm ci`, `cargo fetch`, `gradle dependencies`, pip install | **gated** — declared versions only |
| `workspace-edit` | scoped file edits | **gated** — failing-step scope only |
| `notify` | report progress/result to the requesting surface — the IO in-suite, the developer standalone (README §The two roles) | no |

## Stages

### Stage 1 — Initiation and pre-flight

**Input:** build target (project/branch/commit SHA), optionally a known failing check.
1. Bind the build config for the target: build command, test command(s), declared
   dependency manifest (lockfile), interpreted-tool version requirements.
2. Pre-flight with `env-check`: required runtimes present, versions within declared
   ranges, dependency manifest present. Record results as the **environment snapshot**.
3. Decision point — pre-flight outcome:
   - healthy → Stage 2.
   - manifest missing or versions absent → Stage 4 classification as `environment-mismatch`
     or `missing-dependency` without burning a build; attempt the declared-version install
     lane once (budgeted), else configure-failure report.

### Stage 2 — Build execution

1. Invoke `run-build` with the bound command. Record command, start time, exit status.
   Wall clock default for a single build execution: 15 min per EO-protocol §Timeouts —
   the single authority for all timeout defaults (overridable via the dispatch budget) —
   a timed-out build enters Stage 3 with the partial artifact pack,
   classified first-consideration `infra-outage` unless the log shows a code cause.
2. Monitor: on completion (or timeout), capture the **artifact pack** — failing step name,
   exit signal, the highest-signal log lines (error/first exception/assertions), and the
   environment snapshot. Never forward raw unfiltered logs onward; summarize.
3. Decision point — exit status:
   - zero → Stage 5 verification (fresh-success path: confirm no silent skips).
   - non-zero or timeout → Stage 3.

### Stage 3 — Diagnosis and classification

**Tool rules:** `read-log`, `workspace-read` only (parallel-safe). At most N read calls
per class (default 10). No edits before classification.
1. Reduce the artifact pack to a classification input: exit signal, failing step, top
   error lines, changed-files list (if a change triggered the build).
2. Classify into exactly one bucket (first match wins, defined patterns):
   - `code-regression` — assertion/type/compile-source errors pointing at repository code.
   - `missing-dependency` — unresolved imports/modules/artifacts; lockfile gaps.
   - `flaky-test` — timeouts/transient network/stale-element patterns, or the same check
     passed before with identical content.
   - `environment-mismatch` — wrong/absent runtime version, platform-specific failure.
   - `infra-outage` — image pulls, network loss, runner loss, disk full.
   - `config-secret` — missing env vars, credentials, permissions, 401/403 patterns.
3. Emit the classification with evidence lines and confidence. When two buckets plausibly
   match, prefer the non-code bucket (misdiagnosis costs a review; an extra rerun does not).

### Stage 4 — Action lanes (decision points)

Budgets are keyed per `(target, failing step)` and consumed across lanes.

| Bucket | Lane | Budget | Then |
|---|---|---|---|
| `code-regression` | **Repair lane** | 1 scoped patch per failure key | re-run failed check only → Stage 5; second failure = escalate |
| `flaky-test` | **Rerun lane** | 1 rerun per failure key | passes → report flake with fingerprint; fails again → escalate as suspected real defect |
| `infra-outage` | **Retry lane** | 1 retry after cooldown, same SHA | fails again → escalate with both artifact packs |
| `missing-dependency` | **Install lane** | declared versions in manifest only | install + re-run failed check; version conflict or needed version not declared → escalate |
| `environment-mismatch` | none (read-only) | — | escalate: runtime/manifest discrepancy evidence |
| `config-secret` | none (read-only) | — | escalate immediately: missing config/secret names, never their values |

**Hard rules across lanes:**
- Repairs stay inside the failing step's blast radius (files it compiles/tests, configs it
  reads). Anything outside = escalate.
- A lane that exhausted its budget cannot switch buckets and consume another's budget;
  it escalates.
- Risky actions (dependency version bumps, cache/toolchain clears, lockfile edits) always
  require explicit user confirmation — no exceptions.

### Stage 5 — Verification

1. Re-run the **exact failed check** (`run-check`) — not the full pipeline — and require
   zero exit.
2. Collateral guard: run the fastest sufficient check that covers the edited surface (the
   failing step's own scope). Any newly failing test = the repair is not done: back to
   Stage 3 on the new failure.
3. Verified-green → Stage 6 report. Lane exhausted without verification → Stage 6 report
   as unresolved.

### Stage 6 — Reporting

- **Success report:** target/SHA, commands run, lanes used with budgets spent, fixes
  applied (file list, one-line diff rationale, and each fix's local commit SHA + message
  header), verification evidence (check names + exit codes), flake fingerprints if any.
- **Failure report:** classification + evidence lines, lane attempts and budgets spent,
  what was NOT attempted and why, the minimal context a human needs to act, and the
  decision point that stopped automation.
- Reports go through `notify` to the requesting surface; a repair that changed files
  always asks for review — the reviewer gate is load-bearing, not informational.

## Escalation summary

Escalate (stop automation, attach evidence) when: any lane budget is exhausted; the
bucket is `environment-mismatch` or `config-secret`; a repair needs a dependency version
beyond the declared manifest; a risky action lacks confirmation; or two consecutive
classifications disagree (oscillating diagnosis).

## Assumptions

1. The harness can run commands and capture structured logs/exit codes per step.
2. `install-deps` is pre-approval-gated at the harness level, not just prompted.
3. Default budgets (1 patch, 1 rerun, 1 infra retry per failure key) are tunable at
   install; they are intentionally small.
4. A user/orchestrator receives `notify` reports and can answer confirmation requests.
5. `git-commit` binds to a sandbox-local git with no remote configured; the EO applies
   the exported patch to the durable branch (README §Version control conventions).