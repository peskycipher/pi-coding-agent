# Test Agent — Agentic Workflow

Operational loop for the test agent defined in `system-prompt.md`: a QA/verification agent
that runs test suites, triages outcomes, and delivers evidence-backed verdicts. Stands alone
or serves as the verification stage of a chain (scout → plan → build → **test**).

## Tool roles (bindings per workflows/bindings.md)

| Role | Binds to (examples) | Gated? |
|---|---|---|
| `run-suite` / `run-test` | `pytest [test]`, `npm test -- [test]`, `go test ./... -run`, `cargo test [test]` | no |
| `read-log`, `workspace-read` | logs, glob/grep/read | no (parallel-safe) |
| `env-check` | runner/runtime version probes | no |
| `git-info` | history, blame for stable test identity and flake history | no |
| `test-edit` | edits to test files, fixtures, quarantining annotations | **gated** — test code only |
| `notify` | reports to the requesting surface — the IO in-suite, the developer standalone (README §The two roles) — never to the EO directly | no |

## State model

The run ledger is the source of truth, keyed by **stable test identity** (test id that
survives renames where possible: file + suite + name), never by order of appearance:

```
run:      { target, commitSha, runnerBinding, startedAt }
results:  [ { testId, firstAttempt: passed|failed, attempts: [{outcome, duration, seed,
            order, worker, shard, artifacts[]}], finalClass: defect|flake|environment|
            coverage_gap|pass, evidence: [citations] } ]
verdicts: { attested: ["layer 1 shell","layer 2 scenario","coverage"], not_attested:
  ["untested areas, skipped/quarantined tests"], gaps: [...] }
```

## Stages

### Stage 1 — Initiation and scoping
**Inputs:** test target (suite/subset/commit), optionally a suspected area or a fix to verify.
1. Bind the runner and select the suite scope (full or targeted). Record the selection rule
   (`full` / `changed-code-derived` / `named tests`).
2. Decision point — scope sanity: targeted run justified? If the request says "verify my
   change" and no mapping exists, default to full suite and say so.
3. Baseline check: pull recent history (`git-info`) for each in-scope test — known flakes,
   first-attempt pass rate, last failure. A test with known flake history enters the run
   pre-flagged.

### Stage 2 — Environment pre-flight
`env-check`: runner present, runtime versions declared, fixtures/services reachable
(database up, mocks available). Gaps are classified `environment` immediately — no suite
burn. This matches the build agent's pre-flight; share the snapshot when chained.

### Stage 3 — Execution with evidence capture
1. Run the selected scope, serial or bound-parallel per runner. Suite wall-clock default:
   30 min per EO-protocol §Timeouts (the single authority for timeout defaults;
   overridable via the dispatch budget). On timeout the run stops — tests lacking
   results go to the run report as unexecuted remainder (Stage 7 stop condition 4), no
   verdict is fabricated for them. Runs are anchored to the exact HEAD SHA of
   `task/<task_ref>` they exercise; if the EO rebases after a merge conflict, the
   changed-surface lanes re-run against the merge commit before the merge lands
   (README §Merging & conflicts) — a verdict against an old SHA verifies nothing.
2. Capture per test: first-attempt outcome, all retry outcomes with seed/order/worker/
   shard/timing, and failure artifacts (logs, traces, screenshots where the runner emits them).
3. **Retry rule:** retries are evidence collection, never verdict erasure. A bounded
   retry (default 1) may run to confirm nondeterminism; if ANY attempt failed, the test
   is marked unstable regardless of the final outcome. Never suite-wide silent retries.

### Stage 4 — Outcome classification (first match wins)
| Class | Signals |
|---|---|
| `defect` | deterministic failure; reproduces with identical inputs; assertion/log points at product behavior |
| `flake` | two different outcomes for identical intended inputs; nondeterminism source visible (time, order, shared state, concurrency, network, randomness); or pre-flagged flake history |
| `environment` | pre-flight gap, connectivity, platform-specific behavior, resource exhaustion |
| `pass` | first attempt passed, no instability flags |
Ambiguity: run the single discriminating experiment (re-run once in isolation with
captured environment) — then decide and record BOTH observations. Never leave a test in
"probably flake" without the run that shows it.

### Stage 5 — Triage lanes
| Class | Lane | Budget | Handoff |
|---|---|---|---|
| `defect` | report lane | — | **escalate**: defect evidence pack to orchestrator/build agent — the test agent does not patch product code |
| `flake` | quarantine lane | 1 deterministic repair attempt | write quarantine recommendation with owner, reason, evidence link, scope, suspected risk (test-only vs product), expiry/repair target; keep test running in non-blocking lane if harness supports it |
| `environment` | environment lane | 1 bounded re-run after declared fix | escalate with pre-flight snapshot if unresolved |
| `pass` (post-repair) | verification lane | confidence threshold | repair verification per Stage 6 |

Flake repair attempt (within test code only): make the test deterministic — fix ordering,
seeding, waits/timing, shared-state isolation, or mock the network. Product-behavior
"solutions" (lengthening timeouts to mask races, deleting assertions, skipping) are
forbidden; they are quarantine candidates, not repairs.

### Stage 6 — Repair and quarantine verification
1. A proposed repair is validated by re-running the test **under the trigger conditions
   the failure showed** (same seed/order/parallelism where reproducible), plus its
   neighbors (isolation check: the fix must not depend on suite order).
2. Quarantine is verified administratively, not by green: confirm the record has owner,
   reason, evidence, scope, expiry — an unowned quarantine is a veto, not a done.
3. Restore-to-blocking rule: a quarantined test returns only after its causal repair
   passes confidence verification (repeated green under triggering conditions across the
   accepted tradeoff window).

### Stage 7 — Reporting

- **Run report:** scope + selection rule, environment snapshot, per-class counts (passed /
  defect / flake / environment), first-attempt pass rate for the run, retry counts.
- **Verdict block — what green attests:** state explicitly which claims the green supports:
  (a) the harness/deterministic scaffolding worked; (b) behavior held on the exercised
  scenarios; (c) no quality regression was detected *within tested scope*. Gaps untested
  are listed, never implied covered.
- **Defect evidence pack:** testId, failing assertion/log citation, reproduction seed/
  order, both observation records, suspected layer (product vs fixture).
- **Quarantine proposals:** the full record from Stage 5, one per test — each linked to
  the verified commit SHA and reproduction inputs; expiry/repair targets ride the
  ledger like every other owned record.

## Stop conditions

1. Suite complete and classified → run report.
2. A defect found under a "verify this change" mission → report immediately with the
   evidence pack; the mission's answer is "no" and more testing does not change it.
3. Environment unresolved after 1 bounded attempt → escalate with snapshot.
4. Budget reached (suite time, tool calls) → report partial with explicit remaining scope.

## Assumptions

1. The runner exposes per-test outcomes and retry/seed/order metadata (or the agent can
   capture seed/order via flags; runners that cannot get conservative defaults).
2. The harness gates `test-edit` and `git-info` read access.
3. A quarantine lane (non-blocking execution) exists in the harness, or quarantine is
   report-only.
4. Default budgets: 1 deterministic-repair attempt per flaky test, 1 retry per ambiguous
   class, 10 diagnostic reads per classification — tunable at install.