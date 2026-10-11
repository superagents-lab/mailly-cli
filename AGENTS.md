# mailly-cli

The Mailly CLI (`src/`, `bin/`) and the Mailly agent skill (`skills/mailly/SKILL.md`). This repo is the only source for both; the Mailly service itself lives elsewhere.

- Test: `npm test` (builds, then runs `tests/*.test.mjs`). The tests check that every `mailly` command and option shown in the skill exists in the CLI, so update the skill together with command changes.
- Release: bump `version` in `package.json` and `VERSION` in `src/index.ts`, run `npm test`, commit, tag `vX.Y.Z`, push with tags, then `npm publish`.
- The skill is installed from `https://raw.githubusercontent.com/superagents-lab/mailly-cli/main/skills/mailly/SKILL.md`, so pushing to `main` updates it for users immediately.
- Keep public docs free of private repository links, local paths, and internal issue IDs.
