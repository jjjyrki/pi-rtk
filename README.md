# pi-rtk

This extension moved to the
[pi-extensions](https://github.com/sherif-fanous/pi-extensions) monorepo. Its
code, issues, and changelog are now in
[packages/pi-rtk](https://github.com/sherif-fanous/pi-extensions/tree/main/packages/pi-rtk).
This repository is archived with its history up to 0.6.0.

Install the upstream package with:

```shell
pi install npm:@sherif-fanous/pi-rtk
```

## Fork changes

This fork preserves the standalone 0.6.0 integration. Its changes are not in the
upstream npm package linked above.

Known output-sensitive forms keep their original execution path:
file-enumeration and machine-format flags, pipelines/redirections, unresolved
shell expansions, end-of-options separators (`--`), and package-selection flags.
Quoted flags are handled conservatively. Rewrites to `rtk find` are declined
because its expression subset is narrower than native `find`. Those commands
lose compression rather than their output contract; no potentially
side-effecting rewrite is executed and retried. The same selection applies to
context-visible user commands and preserves Pi's permission hooks.

Run `npm test` (also included in `mise run check`) for regression tests using
Pi's real bash tool and temporary CLI fixtures. No live model or installed RTK
binary is required.
