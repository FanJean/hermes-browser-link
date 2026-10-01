## Summary

<!-- What does this change and why? Link the related issue. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Security hardening
- [ ] Documentation
- [ ] Tests or tooling
- [ ] Refactor (no behavior change)

## Checklist

- [ ] `npm test`, `npm run lint`, `npm run check:js`, `npm run check:docs` and `python3 scripts/generate-browser-reference.py --check` pass; integration results reported separately
- [ ] Tests added or updated for behavior changes; new offline tests added to `scripts/verify-v1.1-offline.py`
- [ ] Real-browser behavior checked with a temporary profile, if relevant (describe below)
- [ ] Authorization, origin, lease and generation checks are not weakened; no automatic retry of unknown writes
- [ ] Docs and `CHANGELOG.md` (Unreleased) updated
- [ ] `bash scripts/check-public-release.sh` passes; no personal data, credentials or absolute local paths committed

## Verification

<!-- Commands you ran and what you observed. -->
