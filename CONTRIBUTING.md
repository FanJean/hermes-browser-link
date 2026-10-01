# Contributing

Thanks for your interest in Hermes Browser Link. Bug reports, fixes, tests and documentation improvements are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Read [docs/architecture.md](docs/architecture.md) — most changes touch a trust boundary, and it explains which side owns what.
- Security problems: do **not** open a public issue; follow [SECURITY.md](SECURITY.md).

## Development setup

See [docs/development.md](docs/development.md).
```sh
npm ci --ignore-scripts
npm test
```

The core suite uses only the locked npm development dependencies and Python 3.11+. It does not require Hermes, browser installations or credentials. The full integration gate is separate; follow [docs/testing.md](docs/testing.md) to prepare its pinned Hermes environment.

## Pull requests

1. Branch from `main` and keep the change focused.
2. Add or update tests for every behavior change. New offline tests go into the explicit lists in `scripts/verify-v1.1-offline.py` (see [docs/testing.md](docs/testing.md)).
3. Make sure these pass locally:

   ```sh
   npm test
   npm run lint
   npm run check:js
   npm run check:docs
   python3 scripts/generate-browser-reference.py --check
   bash scripts/check-public-release.sh
   # After preparing the integration environment:
   npm run verify
   ```

4. If you changed behavior that only a real browser can show, run the relevant real-browser runner and describe the result in the PR. Follow the browser-test safety rules — temporary profiles only, never your personal profile.
5. Update the documentation and add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).

## Guidelines

- Do not weaken authorization, origin, lease or generation checks, and do not add automatic retries for writes whose outcome is unknown.
- Never let model-controlled input choose owners, approvals, credentials or arbitrary tab IDs.
- Do not commit personal data: real cookies, passwords, page captures of real accounts, or absolute paths from your machine.
- Reuse existing components and controlled execution paths before adding new ones; keep compatibility branches to demonstrated needs.
- Include Chinese comments explaining constraints in new code and use Chinese commit descriptions.
- Keep runtime code free of third-party dependencies.
- Run the public-source scanner on tracked files. Supply private usernames, email addresses and other markers through newline-separated `PUBLIC_RELEASE_EXTRA_KEYWORDS`, never by hardcoding them in scripts. Review generated artifacts separately; `.gitignore` does not remove files already tracked.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
