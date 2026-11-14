# Specification Quality Checklist: Live GPUs and an account deep dive

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Validation pass 1: all items pass, no `[NEEDS CLARIFICATION]` markers.
- The three requested fixes are three user stories: real GPUs (P1), installations
  removed (P2), account deep dive (P2).
- Two decisions were resolved in Assumptions rather than left open:
  - **Conversation titles are excluded** from the deep dive with the rest of the
    conversation. The request said "all the information, except HF & vast tokens",
    but Principle I forbids sharing conversation content, and a title is text the
    person wrote. Counts, sizes and timestamps are shown instead.
  - **The deep dive is read-only except capability changes.** Editing somebody's
    settings or resetting their configuration from the backoffice would duplicate
    control the person already has, and would need an audit story of its own.
- "Installations" removal states explicitly that the legacy rows are left in place:
  the request was to remove the section, and silently deleting data is a different
  decision that deserves its own approval.
- Validation pass 2 (catalogue additions): still all items pass, no
  `[NEEDS CLARIFICATION]` markers. Two stories added at the user's request — the
  catalogue must list the models people ask for (US4) and "Only models I can run"
  must mean exactly that (US5). Both were grounded in the code before writing:
  - selection was `pipeline_tag=text-generation` sorted by downloads with a limit of
    300, so `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` could never appear no
    matter how well it runs;
  - the runnable verdict only ever looks at files in the repository root, so a
    repository that keeps its quants in a subfolder is called empty;
  - the product's own filter asked "did the backend mark this supported globally?",
    which is neither "the product can serve it" nor "I can run it now".
- "Important" is resolved as an operator-maintained list plus family coverage, not a
  scoring heuristic: a heuristic would be a hidden rule nobody can appeal.
- Numbers chosen for the success criteria are the ones the smoke test can actually
  measure (5 attempts, 5 minutes median, 30-day window, one machine).
