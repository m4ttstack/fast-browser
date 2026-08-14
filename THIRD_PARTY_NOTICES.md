# Third-party notices

Fast Browser is licensed under the MIT License (see LICENSE). It installs and
runs artifacts built from the Playwright project, which are NOT covered by
that license: Playwright is licensed under the Apache License 2.0.

- Playwright license: https://github.com/microsoft/playwright/blob/main/LICENSE
- Source repository: https://github.com/m4ttheweric/playwright
- Source commit: `d9b764589731ebeb4972c1e0065571dd4f1519cd`

The MIT license covers this plugin's own source. The runtime and Chrome
extension artifacts it downloads remain Apache-2.0 works of the Playwright
project and its contributors.

## Locked artifacts

The URLs in `runtime-lock.json` are immutable release coordinates: a specific
tag, never `latest`, so the bytes behind them cannot change without the lock
changing. The artifacts are built from that commit of the fork; publishing the
`fast-browser-v0.1.0-alpha.12` tag and its release assets is part of cutting
the release this lock belongs to, and the installer verifies both checksums
after download regardless.

- Runtime: `fast-browser-mcp-0.1.0-alpha.12.tar.gz`
  SHA-256 `0f323a2bbcfd25167c8c2eeca26de04b6e5e9f9646920e265c623e54e6472b28`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.12/fast-browser-mcp-0.1.0-alpha.12.tar.gz
- Chrome extension: `fast-browser-extension-0.1.0-alpha.12.zip`
  SHA-256 `41687d262ffd59052ec934e793442dcd82052193098f2028d509f04781176125`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.0-alpha.12/fast-browser-extension-0.1.0-alpha.12.zip
  Extension ID `bjlfojdaaanoliidngocnbcalhpfmlie`, version `0.2.7`

Every value above is reproduced from the committed runtime lock, so the notice
can be checked against the installer contract. A release-gate test asserts they
still agree; hand-editing either one alone fails that gate rather than silently
publishing stale provenance.

An unpublished local build can still be installed with a URL-free
`fast-browser-release-0.1.0-alpha.12.json` beside those exact two files, passed
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
