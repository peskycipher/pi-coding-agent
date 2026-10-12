# Documentation Agent — Design

A sixth specialist for the suite: `docs`, responsible for creating and maintaining
developer-facing documentation (architecture, API references, setup guides) and
end-user-facing documentation (user guides, FAQs, release notes). Same family as the test
agent: read-only diagnosis of docs-against-code drift, gated edits to docs paths only,
evidence-backed changes, review gates — and one borrowed idea strengthened into a hard
rule: **a doc claim that cannot be cited from current code or behavior is stale.**

## Role and integration with the suite

- Runs as the fifth specialist under the IO's delegation map (`scout plan build test
  docs`) — **adopted**. Trigger surfaces: end-of-`implement` docs dispatches (IO-dispatched
  with the changed-file surface, IO design §Stage 2 docs trigger rule), scheduled sweep
  TASKs (the **EO schedules the nightly sweep** — host cron — pipeline shape `docs-drift`),
  and release-time TASKs (shape `release-notes`). The EO never dispatches the agent
  directly outside these TASK forms.
- **Claims-index bootstrap:** a repo without `docs/claims-index.json` makes the first
  docs dispatch an index-building task (same blast-radius rules; writes stay under
  `docs-edit` gating; the index is a committed, versioned artifact — VC conventions
  apply). Budget: bootstrap inherits the dispatch TASK budget; sweep TASKs for large
  repos may exceed one dispatch — split by doc directory, each with its own budget.
- **Docs CI cost control:** the code-sample runner/link checker runs inside the dispatch
  TASK budget; samples the budget cannot execute are reported as unattested coverage in
  the verdict block — never silently skipped.
- Dispatch contract (added to `orchestrator-internal/protocol.md` RESULT table):
  `doc_updates[{path, change, evidence[], risk}], claims_index_delta[], release_notes?, verdict{attested, stale_sections[]}`.
- Tool roles (bindings per workflows/bindings.md): `run-suite`/`run-check` (only to run docs checks: link
  checker, code-sample runner), `read-log`, `workspace-read`, `git-info`, `docs-edit`
  (gated to docs paths only — mirrors the test agent's `test-edit` gating), `notify`.
- Product code stays read-only to it, exactly like the test agent. It never edits code to
  match a doc ("the docs say the flag is `--verbose`" is stale-doc evidence, not an API bug).

## How it detects outdated docs

Three detectors, each with a defined trigger:

| # | Detector | Trigger | Mechanism |
|---|---|---|---|
| 1 | **Claims index drift** | every `COMPLETION` ledger entry from a build/test task with changed files | The docs agent maintains a **claims index**: doc files parsed into structured claims (endpoints, flags, config keys, defaults, setup steps), each anchored to the code location that asserts it. On changed-file events it re-verifies the anchors covering that surface (grep/read the anchor: does current code still assert the claim?). Unverifiable or contradicted claims → stale. |
| 2 | **Docs CI checks** | every docs edit, and nightly sweep | Link checker (internal and external links), code-sample runner (every sample in a doc must execute against the pinned suite), format lint. A failing sample is stale-doc evidence with the exact failure. |
| 3 | **Behavioral drift (test-agent signal)** | test agent RUN REPORTs / quarantine records | A quarantined behavior or changed done-criteria implies changed user-visible behavior; the docs agent cross-maps affected guides/FAQs from the change surface. Nightly full sweep catches changes that arrived out-of-band (manual edits, dependency-driven behavior shifts). |

Output of detection: a drift report — file, section, claim, evidence (anchor that broke),
risk class (wrong-instruction > outdated-reference > cosmetic), confidence. Same
discipline as the test agent's verdict block: a stale claim with no evidence is not
reported as stale; an unproven "this is outdated" hunch is dropped.

## How it generates and applies updates

1. **Scope the fix** — the drift report defines the blast radius. Updates never wander
   beyond it (the build agent's scope-contract rule, applied to docs).
2. **Author with citations** — every changed paragraph cites its evidence: `path:line`
   for behavior claims, task-ledger reference for behavior change, runner output for
   samples. New docs (e.g., a setup guide for a new feature) are drafted from the ledger:
   the revision_log of the implementing task supplies what actually happened, not what
   was planned.
3. **Verify before proposing** — re-run docs checks on the edited doc; a doc patch that
   fails its own checks is not submitted.
4. **Apply via patch, never in place** — changes are emitted as ARTIFACT_TRANSFER diffs
   (paths + sha256) through the EO's approval pipeline, like every other sandbox output;
   the EO applies them to the task branch and opens the PR (README §Version control
   conventions). The docs agent never touches remotes.
5. **Release notes** — generated per release from: ledger revision_log entries since the
   last release, git-info merge history, and the test agent's verdict blocks (what was
   verified vs not). Framed for end users; internals stay out of user-facing text.
   Release notes gate the tag: `vMAJOR.MINOR.PATCH` is cut on `main` only after the
   notes are approved (README §Tags & releases); a hotfix release requires a
   release-notes addendum before its patch tag; a reverted release gets a superseding
   addendum — tags are never deleted or rewritten.

## Review and approval process

| Change class | Who approves | Mechanism |
|---|---|---|
| User-facing docs (guides, FAQ, release notes) | developer, always | EO DECISION REQUEST with the diff; nothing user-facing ships unreviewed — an LLM-drafted user doc reads confidently even when wrong |
| Developer-facing reference docs | developer, with auto-apply option | approval per docs-dir, grantable for a session |
| Cosmetic (typos, link rot fixes) | auto (configurable) | docs CI validates; still lands in the audit log |
| Stale-section quarantine | docs agent proposes | mirrors test-agent quarantine: a visible banner (date, reason, owner) on the section, keep rendering until repaired; an unowned quarantine is rejected |
| Deletion of docs | developer only | quarantine-first: flag, do not delete |

## Trade-offs and risks

1. **Claims-index maintenance cost** — the index is the system's value and its main
   liability: incomplete parsing = missed drift (false negatives); noisy parsing = false
   alarms that train neglect. Mitigation: anchor-based checking (verify an anchor's claim,
   not free-text similarity), start with reference docs (APIs, CLI, config) where claims
   parse well; add prose-doc coverage last.
2. **Confident wrongness in generated docs** — LLM-authored text reads authoritative.
   Mitigation: the citation-per-change rule and user-facing review gate exist because of
   this risk specifically; release notes state what was verified (verdict blocks), not
   what the model believes.
3. **Scope creep into documentation rewrites** — drift fixes that become prose
   renovations. Mitigation: blast-radius contract enforced by the IO's dispatch payload.
4. **Docs CI running code samples costs build time** — samples run only on docs edits and
   the nightly sweep, not every build.
5. **Two sources of truth** — if docs and inline docstrings both describe an API, drift
   doubles. Mitigation: the claims index treats docstrings as candidate anchors and flags
   divergence between them and rendered docs instead of silently choosing one.

## Implementation sequence (approved)

Build order after adoption approval — sequence retained from the original adoption plan:

1. MVP: detector 2 (docs CI: links + samples) + release notes generation from the ledger —
   value with zero review-flow complexity.
2. Claims index on reference docs; wire detector 1 into the ledger's COMPLETION events.
3. Quarantine banners + nightly behavioral-drift sweep (needs test agent verdicts flowing).
4. Auto-apply policy tuning after a month of approval-gate data (the metrics plan's
   `approval_wait_seconds` measures whether docs reviews are the bottleneck).