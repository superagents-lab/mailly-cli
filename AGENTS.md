# mailly-cli

The Mailly CLI (`src/`, `bin/`) and the Mailly agent skill (`skills/mailly/SKILL.md`). This repo is the only source for both; the Mailly service itself lives elsewhere.

- Test: `npm test` (builds, then runs `tests/*.test.mjs`). The tests check that every `mailly` command and option shown in the skill exists in the CLI, so update the skill together with command changes.
- CI (`.github/workflows/ci.yml`) runs `npm test` and `npm pack --dry-run` on Node 18/22/24 for pushes to `main` and pull requests.
- Release: bump `version` in `package.json` and `VERSION` in `src/index.ts`, run `npm test`, commit, tag `vX.Y.Z`, and push with tags. `.github/workflows/release.yml` checks that the tag matches both versions, tests, publishes to npm with provenance through trusted publishing, and creates the GitHub release.
- CLI help, output, and errors are English. Server error messages are passed through as returned.
- The skill (`skills/mailly/`) is English only; a test enforces it.
- The skill is installed from `https://raw.githubusercontent.com/superagents-lab/mailly-cli/main/skills/mailly/SKILL.md`, so pushing to `main` updates it for users immediately.
- Keep public docs free of private repository links, local paths, and internal issue IDs.
