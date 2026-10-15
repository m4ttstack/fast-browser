# Third-party notices

Fast Browser is licensed under the MIT License (see LICENSE). It installs and
runs artifacts built from the Playwright project, which are NOT covered by
that license: Playwright is licensed under the Apache License 2.0.

- Playwright license: https://github.com/microsoft/playwright/blob/main/LICENSE
- Source repository: https://github.com/m4ttheweric/playwright
- Source commit: `b2cc1e33da0a0f7f0612fe57cb3c14d2bd9a3a15`

The MIT license covers this plugin's own source. The runtime and Chrome
extension artifacts it downloads remain Apache-2.0 works of the Playwright
project and its contributors.

## Locked artifacts

The URLs in `runtime-lock.json` are immutable release coordinates: a specific
tag, never `latest`, so the bytes behind them cannot change without the lock
changing. The artifacts are built from that commit of the fork; publishing the
`fast-browser-v0.1.5` tag and its release assets is part of cutting
the release this lock belongs to, and the installer verifies both checksums
after download regardless.

- Runtime: `fast-browser-mcp-0.1.5.tar.gz`
  SHA-256 `e876b671c70cfb8a82e6bc17eea671291dba53c61fd84e9a836163a2c6ddf29f`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.5/fast-browser-mcp-0.1.5.tar.gz
- Chrome extension: `fast-browser-extension-0.1.5.zip`
  SHA-256 `b6bccac5cdd19c5588b6c9f77847877a88021acb55a67ad3153085ac2efe63a7`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.5/fast-browser-extension-0.1.5.zip
  Extension ID `fnfikoifhimpdedpdepehibjjkcfbacm`, version `0.2.11`
- Signed Chrome extension: `fast-browser-extension-0.1.5.crx`
  SHA-256 `b98600eb6b42a2e3d40cc4a165c02a7b64da7cfefc288e4b4214756cec8a41ca`
  https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.5/fast-browser-extension-0.1.5.crx
  The zip above wrapped in a CRX3 signature, so the two install identical
  bytes. `setup` installs the zip; the CRX is for an unattended installer that
  registers the extension with Chrome itself.
- Compose renderer: Chromium headless shell, revision `1234`, used by
  `fast-browser compose` to render evidence images. Chromium is licensed under
  the BSD-3-Clause license (https://chromium.googlesource.com/chromium/src/+/main/LICENSE),
  not the Apache License 2.0 above.
  - `mac-arm64`: `chromium-headless-shell-1234-mac-arm64.zip`
    SHA-256 `cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d`
    https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.2/chromium-headless-shell-1234-mac-arm64.zip
  - `mac-x64`: `chromium-headless-shell-1234-mac-x64.zip`
    SHA-256 `608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea`
    https://github.com/m4ttheweric/playwright/releases/download/fast-browser-v0.1.2/chromium-headless-shell-1234-mac-x64.zip

Every value above is reproduced from the committed runtime lock, so the notice
can be checked against the installer contract. A release-gate test asserts they
still agree; hand-editing either one alone fails that gate rather than silently
publishing stale provenance.

An unpublished local build can still be installed with a URL-free
`fast-browser-release-0.1.5.json` beside the runtime and extension archives it
names, passed via `--runtime-lock`. That local manifest and the locked hashes provide the
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

## Inter

`assets/fonts/InterVariable.woff2` is Inter 4.1 by Rasmus Andersson
(https://github.com/rsms/inter), licensed under the SIL Open Font License 1.1
(`assets/fonts/OFL.txt`). SHA-256 of the bundled file: 693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3.
It is embedded into `fast-browser compose` renders so they never fetch fonts.
