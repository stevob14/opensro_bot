
# OpenSRO bot userscript

This public repository is the source of truth for the Tampermonkey script in
`bot.user.js`. The script has no embedded update checker. Tampermonkey checks
the public raw script URL in the metadata and downloads a newer version when
the `@version` value increases.

## Update workflow

1. Review and edit `bot.user.js` in this repository.
2. For each release, increase both the header `@version` and the `VERSION`
   constant, then review, commit, and push the change to `main`.
3. Remove the older Tampermonkey entry, then install the current `bot.user.js`
   from this repository once. The renamed script may appear as a separate
   entry, and the older copy cannot learn the new update URL. After installing
   this version, Tampermonkey can update it when a higher version is published.
   Its update-check schedule is controlled by Tampermonkey settings.

The repository is public, so anyone can read and copy the script and its
history. Do not commit secrets or credentials. Do not put a GitHub token in the
userscript; the raw public URL needs no token.

## Security notes

- The script is limited by its userscript match rule to
  `http://127.0.0.1:5180/*`, and uses `@grant none` in page context.
- Game API requests go to the local game origin. The remote bug-report sender
  and screenshot upload feature have been removed.
- Automatic updates download only this repository's published script; no
  runtime update checker downloads or evaluates separate code.
- This is a quick static review, not a guarantee of safety. Review changes
  before installing them and do not install unreviewed commits.
