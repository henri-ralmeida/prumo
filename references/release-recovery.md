# Release history recovery — 2026-09-12

Release commits and missing tags were recovered retrospectively from existing Git objects,
the original package artifacts and the recorded edits in the development conversation.
Commit dates are recovery dates where a commit had to be reconstructed.

| Version | Source and scope |
| --- | --- |
| 1.0.1 | Recover existing commit `dec8f92936f69f024318ee76201abcfdd80cde28`; the former tag pointed at a package declaring 1.0.0. |
| 1.0.6 | Tag existing commit `0661dff`; packaged contents match the immutable npm release. |
| 1.0.8 | Tag existing commit `e7c7162`; packaged contents match the immutable npm release. |
| 1.1.0 | Tag existing commit `a25c666`, the last 1.1.0 snapshot before 1.1.1. |
| 1.2.0 | Reconstruct commit `418fc3e` from the original planning tarball; restore original tests from recorded patches. Includes per-task planning and the selector/hub visual fixes. |
| 1.2.1 | Reconstruct commit `8ddcfb0` with 1.2.0 as parent. Preserves original commit `81555bd` with corrected version labels; introduces discuss before planning. |
| 1.2.2 | Retain the changes from `e5fe9cf` and complete release metadata: native question routing, ordered legend, colored counters and per-task progress. |

The original combined history is retained in branch `codex/release-history-before-recovery`.
The original 1.3.1 target is retained as `recovery-original-v1.3.1`.
Existing unrelated release tags remain unchanged. The recorded initial pull advanced `3c25dc1`
to `faff77a` (1.1.2). The conversation initially labeled planning as 1.3.0 and discuss as 1.3.1.
During recovery, the user explicitly corrected the intended sequence to **1.2.0 → 1.2.1 → 1.2.2**.
Package metadata, release notes, documentation and version-specific test expectations now use
that sequence. The former v1.3.1 release tag is superseded; its original commit remains backed up.

## Original artifact evidence, before the approved renumbering

- 1.3.0 original and rebuilt tarball SHA-256:
  `a624145bf946b8f1f740a91b466f2930237aee5990336d9f80cf5e37e83ba82a`.
- 1.3.1 original and rebuilt tarball SHA-256:
  `aae9a03a9d0f1c63dbbb5fb3ece05441f07654aa64fd18f34db2836cf4993539`.
- 1.0.6 rebuilt tarball and npm `dist.shasum`:
  `e2c4ed859c2f37062d5aaf1ac8eee4fbab9ea3e1`.
- 1.0.8 rebuilt tarball and npm `dist.shasum`:
  `ed86cd75d6dcdffbd0337cc88933129807621a82`.

The hashes above prove the recovered source artifacts before renumbering; final 1.2.x packages
have different hashes because their version labels and release documentation were corrected.
Recovery verifies each changed or newly tagged release with package checks and packaging.
Tests for 1.0.1, 1.0.6, 1.0.8 and 1.1.0 passed (55, 64, 64 and 70 respectively).
Before renumbering, the three recovered delivery trees passed 96, 99 and 101 tests, plus npm/Bun
installation and update smoke checks for all three adapters in isolated homes and registries.
After renumbering, the full suites passed again for 1.2.0 (96), 1.2.1 (99) and 1.2.2 (101).
All three final versions passed package checks and packaging; 1.2.2 also passed the npm/Bun
installation and update smoke checks after renumbering.

## Later npm publication

This recovery does not publish npm packages. Registry inspection found versions 1.0.2 through
1.0.8 already published; those versions cannot be overwritten. Publish only missing versions
from their exact release tags after their checks pass. Use a non-latest dist-tag for historical
packages, then publish the newest release as `latest`, so older publications do not downgrade
the default installation. Recheck registry availability immediately before publishing.
