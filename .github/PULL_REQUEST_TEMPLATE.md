# Summary

<!-- What changes for the user, and why. Link the issue if there is one. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / tests only

## How it was tested

<!-- Paste the test command and its result. -->

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/usage-hub/tests/run-tests.ps1
```

## Checklist

- [ ] Tests pass locally
- [ ] A regression test covers the fix (for bug fixes)
- [ ] `CHANGELOG.md` updated for user-visible changes
- [ ] README / docs updated when behaviour, requirements or config keys changed
- [ ] No secrets, tokens, cookies or personal usage numbers in the diff
- [ ] Commits are signed off (`git commit -s`) and contributions are accepted under `GPL-3.0-only`
- [ ] Tested on Windows with the Codex desktop app (or the change is docs-only)