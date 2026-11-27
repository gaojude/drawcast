# Pull requests

Include a new changeset in every PR, including documentation, maintenance, and release PRs.
Run `npm run changeset` for a published change, choose the appropriate semantic version bump
for `drawcast`, and describe the change for users. For work with no release impact, run
`npm run changeset -- --empty`. Commit the generated file under `.changeset/`.

Follow the release instructions in `CONTRIBUTING.md` when consuming pending changesets.
