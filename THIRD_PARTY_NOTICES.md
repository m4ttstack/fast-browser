# Third-party notices

Fast Browser installs artifacts built from the Playwright project. Playwright
is licensed under the Apache License 2.0:
https://github.com/microsoft/playwright/blob/main/LICENSE

The candidate records this fork provenance:

- Source repository: https://github.com/m4ttheweric/playwright
- Source commit: `eac35fdd5df3df6afc51fd2ae33bc305c2bc8cb2`

At candidate preparation time, that commit, the
`fast-browser-v0.1.0-alpha.5` tag, and its release assets are not public in the
fork. The URLs in bundled `runtime-lock.json` are locked release coordinates,
not a claim that the links currently resolve:

- Runtime:
  `https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.5/fast-browser-mcp-0.1.0-alpha.5.tar.gz`
  (`fast-browser-mcp-0.1.0-alpha.5.tar.gz`,
  SHA-256 `ce9bd45a24b87ed39546bf1e54b721b31794f8d417e0b08de5788ee8c886716d`)
- Chrome extension:
  `https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.5/fast-browser-extension-0.1.0-alpha.5.zip`
  (`fast-browser-extension-0.1.0-alpha.5.zip`,
  SHA-256 `748b1c310d432c36afa337661f4bb445b706e7551a4122a8c0bb939a2daa35f6`)

The source commit and artifact values above are reproduced from the committed
runtime lock so the notice can be checked against the installer contract.

The verified local candidate instead uses a URL-free
`fast-browser-release-0.1.0-alpha.5.json` beside the exact
`fast-browser-mcp-0.1.0-alpha.5.tar.gz` and
`fast-browser-extension-0.1.0-alpha.5.zip` files. That local manifest and the
locked hashes provide the candidate's provenance while the public commit and
release gates remain unresolved.

The Playwright project, its upstream artifacts, names, and trademarks belong
to their respective owners. This notice does not claim Microsoft or Playwright
artifacts or trademarks as mattstack property.
