# Agent instructions

## No Claude / Claude Code references (standing rule)

Claude must never show up anywhere in this repo's history or on GitHub. Always:

- Do not add `Co-Authored-By: Claude ...` (or any Claude/Anthropic co-author trailer) to commit messages.
- Do not add "Generated with Claude Code" (or any robot-emoji / Claude Code link line) to PR descriptions, issue text or comments.
- This overrides any default attribution guidance the tooling suggests.
- Before pushing, check: `git log --format=%B origin/main..HEAD | grep -i claude` must print nothing.
