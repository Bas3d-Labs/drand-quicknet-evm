# Package releases

The Package release PR workflow processes pending changesets on `main`.
It creates or updates a release PR containing package versions,
changelogs, and lockfile changes.

New release PRs are drafts targeting `main`. Publishing remains manual.

## Review the release PR

1. Review the selected versions, changelogs, and dependency updates.
2. Select **Approve workflows to run** when GitHub requests approval
   for CI on the bot-created PR.
3. Confirm all required CI checks pass for the latest PR revision.
4. Mark the PR ready for review and merge after approval.

Repeat the CI approval step if GitHub requests it after an automated
update. Missing or pending checks do not count as successful validation.

Merging the release PR does not publish packages or create release tags.