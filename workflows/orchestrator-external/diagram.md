# Two-Tier Orchestrator — Sequence Diagram

Developer → External Orchestrator → Internal Orchestrator → specialists (scout, plan,
build, test), covering intake, planning, execution, verification, approval gates, version
control, and artifact handoff. **Sketch:** `orchestrator-external/protocol.md` and
`orchestrator-internal/protocol.md` are authoritative for fields, semantics, timeouts, and
the version-control conventions (README §Version control conventions).

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant EO as External Orchestrator<br/>(local machine)
    participant IO as Internal Orchestrator<br/>(sandbox)
    participant SC as scout
    participant PL as plan
    participant BU as build
    participant TE as test

    Dev->>EO: intent ("add X / fix Y, here are the constraints")
    EO->>Dev: clarification (scope, done-criteria, budget)
    Dev->>EO: answers
    EO->>EO: sanitize payload, apply pre-granted approvals, load ledger from last session
    EO->>EO: create branch task/<task_ref> from main (VC conventions §Branches)

    EO->>IO: TASK (goal, constraints, sandbox profile, budget layers, session)

    rect rgb(235, 244, 255)
        note over IO,SC: Stage: research
        IO->>SC: DISPATCH (information need, budget)
        SC-->>IO: RESULT (findings + citations, gaps)
        IO->>EO: STATUS (scout done, budget spent)
    end

    rect rgb(235, 255, 240)
        note over IO,PL: Stage: planning
        IO->>PL: DISPATCH (goal + scout findings)
        PL-->>IO: RESULT (step DAG, assumptions, done-criteria)
        IO->>EO: STATUS (plan ready)
    end

    EO->>Dev: plan digest + approval request (scope of changes)
    Dev->>EO: approve / revise
    alt revised
        EO->>IO: TASK_REVISION (delta)
        IO->>PL: re-dispatch (revised step DAG)
        PL-->>IO: RESULT (revised DAG)
    end
    EO->>IO: APPROVAL_RESPONSE (approved scope)

    rect rgb(255, 247, 235)
        note over IO,BU: Stage: execution
        loop per step, dependencies met
            IO->>BU: DISPATCH (step payload, ledger refs)
            BU-->>IO: RESULT (built, changed files, verify commands)
            opt build failure
                IO->>EO: FAILURE (failing step, evidence, options)
                Dev->>EO: choose (resume / re-dispatch / revise)
                EO->>IO: TASK (resume: ledger ref)
            end
        end
        IO->>EO: STATUS (build done)
    end

    rect rgb(255, 240, 248)
        note over IO,TE: Stage: verification
        IO->>TE: DISPATCH (changed surface, done-criteria)
        TE-->>IO: RESULT (verdicts + evidence, attested/gaps)
        alt conflict (test says defect, build says done)
            IO->>BU: re-dispatch (failure evidence, one budget)
            BU-->>IO: RESULT
            IO->>TE: re-verify
        end
        IO->>EO: STATUS (verification done)
    end

    IO->>EO: ARTIFACT_TRANSFER (files, logs, patch + sha256; sandbox SHAs are task-local)
    opt external content needed
        IO->>EO: ARTIFACT_REQUEST (url, reason — allowlist-gated)
        EO->>EO: developer approval gate + sanitized fetch
        EO->>IO: ARTIFACT_RESPONSE (blobRef, sanitized)
    end

    IO->>EO: COMPLETION (summary, verdict, artifact manifest, ledgerRef)
    EO->>EO: verify manifest + verdict block present
    EO->>EO: apply patches to task branch, open PR (Task-Ref, ledgerRef, verdict, SHA mapping)
    EO->>Dev: result summary + artifacts delivered (quarantined until accepted)
    EO->>Dev: PR review → squash-merge on approval (rebase + lane re-runs on conflict)
    EO->>Dev: session archived (ledger persisted for next resume)
```

Alternative short form (research-only request): tasks 1–9 then COMPLETION without the
build/test rectangle — see `workflows/orchestrator-internal/design.md` pipeline shapes.