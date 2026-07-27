# Third-party notices

Fast Browser is licensed under the MIT License (see LICENSE). It installs and
runs artifacts built from the Playwright project, which are NOT covered by
that license: Playwright is licensed under the Apache License 2.0.

- Playwright license: https://github.com/microsoft/playwright/blob/main/LICENSE
- Source repository: https://github.com/m4ttheweric/playwright
- Source commit: `7af0ff16ddb30f46adccc1f837eba6a738e40c2a`

The MIT license covers this plugin's own source. The runtime and Chrome
extension artifacts it downloads remain Apache-2.0 works of the Playwright
project and its contributors.

## Locked artifacts

The URLs in `runtime-lock.json` are immutable release coordinates, not a claim
that the links currently resolve. At candidate preparation time that commit,
the `fast-browser-v0.1.0-alpha.7` tag, and its release assets are not public in the
fork.

- Runtime: `fast-browser-mcp-0.1.0-alpha.7.tar.gz`
  SHA-256 `fa9fe1fda148d9e2604591fa8d31482e25252ab19f30e945b6b5fa2679c2eea7`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.7/fast-browser-mcp-0.1.0-alpha.7.tar.gz
- Chrome extension: `fast-browser-extension-0.1.0-alpha.7.zip`
  SHA-256 `764beb8d2adca7b50a34a648a98005bfbc845d253fb43d6ef90ad54e52b23ad5`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.7/fast-browser-extension-0.1.0-alpha.7.zip
  Extension ID `bjlfojdaaanoliidngocnbcalhpfmlie`, version `0.2.4`

Every value above is reproduced from the committed runtime lock, so the notice
can be checked against the installer contract. A release-gate test asserts they
still agree; hand-editing either one alone fails that gate rather than silently
publishing stale provenance.

The verified local candidate flow instead uses a URL-free
`fast-browser-release-0.1.0-alpha.7.json` beside those exact two files. That local
manifest and the locked hashes provide the candidate's provenance while the
public commit and release gates remain unresolved.

The Playwright project, its upstream artifacts, names, and trademarks belong
to their respective owners. This notice does not claim Microsoft or Playwright
artifacts or trademarks as mattstack property.
