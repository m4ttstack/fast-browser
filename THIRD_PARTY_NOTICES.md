# Third-party notices

Fast Browser installs artifacts built from the Playwright project. Playwright
is licensed under the Apache License 2.0:
https://github.com/microsoft/playwright/blob/main/LICENSE

The candidate records this fork provenance:

- Source repository: https://github.com/m4ttheweric/playwright
- Source commit: `23c61fcce87a8d2fcaf9f636751f062641a1bf1e`

At candidate preparation time, that commit, the
`fast-browser-v0.1.0-alpha.1` tag, and its release assets are not public in the
fork. The URLs in bundled `runtime-lock.json` are locked release coordinates,
not a claim that the links currently resolve:

- Runtime:
  `https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.1/fast-browser-mcp-0.1.0-alpha.1.tar.gz`
  (`fast-browser-mcp-0.1.0-alpha.1.tar.gz`,
  SHA-256 `356981ca2e4b76c06272e529becdf0296052b45d533e4ee14eb8dfcc35439950`)
- Chrome extension:
  `https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.1/fast-browser-extension-0.1.0-alpha.1.zip`
  (`fast-browser-extension-0.1.0-alpha.1.zip`,
  SHA-256 `343a49e41a43101dc1c133c2d64788cee321f1e303963207215f29c8f2c598c0`)

The source commit and artifact values above are reproduced from the committed
runtime lock so the notice can be checked against the installer contract.

The verified local candidate instead uses a URL-free
`fast-browser-release-0.1.0-alpha.1.json` beside the exact
`fast-browser-mcp-0.1.0-alpha.1.tar.gz` and
`fast-browser-extension-0.1.0-alpha.1.zip` files. That local manifest and the
locked hashes provide the candidate's provenance while the public commit and
release gates remain unresolved.

The Playwright project, its upstream artifacts, names, and trademarks belong
to their respective owners. This notice does not claim Microsoft or Playwright
artifacts or trademarks as mattstack property.
