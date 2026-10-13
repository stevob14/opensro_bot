
# OpenSRO bot userscript

This public repository is the source of truth for the Tampermonkey script in
`bot.user.js`. The script has no embedded update checker. Tampermonkey checks
the public raw script URL in the metadata and downloads a newer version when
the `@version` value increases.

## Update workflow

1. Review and edit `bot.user.js` in this repository.
2. For each release, increase both the header `@version` and the `VERSION`
   constant, then review, commit, and push the change to `main`.
3. Since the script name, namespace, and update URL are unchanged, Tampermonkey
   should update the existing entry and apply its new match rule when it next
   checks for updates. Its update-check schedule is controlled by Tampermonkey
   settings.

The repository is public, so anyone can read and copy the script and its
history. Do not commit secrets or credentials. Do not put a GitHub token in the
userscript; the raw public URL needs no token.

## Security notes

- The script is limited by its userscript match rule to
  `https://opensro.online/play*`, and uses `@grant none` in page context.
- Game API requests go to the page origin (`https://opensro.online`). Remote
  reporting, screenshot upload, Discord links, and the upstream update checker
  are not included.
- The script includes an optional local diagnostics summary; it copies to the
  clipboard only when requested and does not upload data.
- Automatic updates download only this repository's published script; no
  runtime update checker downloads or evaluates separate code.
- This is a quick static review, not a guarantee of safety. Review changes
  before installing them and do not install unreviewed commits.
