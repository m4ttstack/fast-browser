# Third-party notices

Fast Browser is licensed under the MIT License (see LICENSE). It installs and
runs artifacts built from the Playwright project, which are NOT covered by
that license: Playwright is licensed under the Apache License 2.0.

- Playwright license: https://github.com/microsoft/playwright/blob/main/LICENSE
- Source repository: https://github.com/m4ttheweric/playwright
- Source commit: `c714013f4bde551e3540e4f69f0a2525479d47f4`

The MIT license covers this plugin's own source. The runtime and Chrome
extension artifacts it downloads remain Apache-2.0 works of the Playwright
project and its contributors.

## Locked artifacts

The URLs in `runtime-lock.json` are immutable release coordinates: a specific
tag, never `latest`, so the bytes behind them cannot change without the lock
changing. That commit, the `fast-browser-v0.1.0-alpha.8` tag, and its release
assets are published in the fork, and the installer verifies both checksums
after download regardless.

- Runtime: `fast-browser-mcp-0.1.0-alpha.8.tar.gz`
  SHA-256 `11a7a0d79580fdd69ecbf62db2ffc2155b0d70921880c36594057e5f194e8f13`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.8/fast-browser-mcp-0.1.0-alpha.8.tar.gz
- Chrome extension: `fast-browser-extension-0.1.0-alpha.8.zip`
  SHA-256 `764beb8d2adca7b50a34a648a98005bfbc845d253fb43d6ef90ad54e52b23ad5`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.8/fast-browser-extension-0.1.0-alpha.8.zip
  Extension ID `bjlfojdaaanoliidngocnbcalhpfmlie`, version `0.2.4`

Every value above is reproduced from the committed runtime lock, so the notice
can be checked against the installer contract. A release-gate test asserts they
still agree; hand-editing either one alone fails that gate rather than silently
publishing stale provenance.

An unpublished local build can still be installed with a URL-free
`fast-browser-release-0.1.0-alpha.8.json` beside those exact two files, passed
via `--runtime-lock`. That local manifest and the locked hashes provide the
same provenance without reaching the network.

The Playwright project, its upstream artifacts, names, and trademarks belong
to their respective owners. This notice does not claim Microsoft or Playwright
artifacts or trademarks as mattstack property.

## Radix Colors

Colour scale values in `lib/annotate/palette.mjs` are derived from
[@radix-ui/colors](https://github.com/radix-ui/colors) v3, used under the MIT
License.

Copyright (c) 2022 WorkOS

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
