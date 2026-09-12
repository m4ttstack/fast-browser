# Chrome Web Store submission package

Everything needed to publish the Fast Browser extension (0.2.11) as an **unlisted** Chrome Web Store item.

## What is in this directory

| File | Purpose |
|---|---|
| `upload/fast-browser-0.2.11-store.zip` | The extension's built `dist/` content, manifest `key` field included. Try this first. |
| `upload/fast-browser-0.2.11-store-nokey.zip` | Identical content with the manifest `key` field removed. The fallback if the dashboard rejects the first zip. |
| `listing.md` | Every Store listing field, ready to paste. |
| `justifications.md` | Every Privacy tab field: single purpose, per-permission justifications, remote code answer, data usage disclosures. |
| `privacy-policy.md` | The privacy policy. Its GitHub blob URL is the dashboard's privacy policy field. |
| `icon-128.png` | The 128x128 store icon for the listing (same file as the extension's `icons/icon-128.png`). |
| `screenshots/` | Two 1280x800 PNG screenshots for the listing. |

Both zips were built from `packages/extension/dist/` in the runtime fork worktree (`fast-browser-runtime` branch, built at version 0.2.11). Rebuild there with `node utils/build/build.js` if the extension changes, then re-zip.

## The extension id question (read before uploading)

The manifest carries a `key` field whose derived id is `fnfikoifhimpdedpdepehibjjkcfbacm`. Keeping that id matters: `runtime-lock.json` in this repo pins it, and `fast-browser doctor`'s extension checks look for it. A store-assigned different id would make the store-installed copy look like a stranger to the CLI.

What research found (September 2026):

- The official `key` field documentation (developer.chrome.com/docs/extensions/reference/manifest/key) covers keeping a stable id for an unpacked extension during development. It does not say whether a store upload may include the field.
- A chromium-extensions thread (groups.google.com/a/chromium.org/g/chromium-extensions/c/Su50pbNzRms) reports that uploading a brand new item WITH a manifest `key` field is rejected with "key field not allowed in manifest", confirmed by a Chrome extensions team member, while later uploads of an existing item may carry it.
- The same thread describes the way to keep a chosen id on a first upload: remove `key` from the manifest and place the private key at the root of the zip as `key.pem`. The store derives the id from that key.

So the honest position: the first zip (with `key`) will most likely be rejected on a new-item upload, and the reliable way to keep the id is the `key.pem` variant below. Both community-documented behaviors could have changed; the dashboard's own error message is the ground truth.

### Option A: keep the id with key.pem (recommended)

The private key lives at `~/.fast-browser/keys/crx-signing.pem` on this machine, and its public half matches the manifest `key` exactly (verified), so its derived id is `fnfikoifhimpdedpdepehibjjkcfbacm`. Build the upload zip in a temporary directory, never inside this repo:

```bash
tmp=$(mktemp -d)
cd "$tmp"
unzip -q /path/to/fast-browser/store/upload/fast-browser-0.2.11-store-nokey.zip -d pkg
cp ~/.fast-browser/keys/crx-signing.pem pkg/key.pem
cd pkg && zip -r -X ../fast-browser-0.2.11-store-withpem.zip . && cd ..
echo "$tmp/fast-browser-0.2.11-store-withpem.zip"
```

Upload that zip. **Never commit it and never share it: it contains the private signing key.** Delete the temp directory after the upload succeeds.

### Option B: try the committed zips

1. Upload `upload/fast-browser-0.2.11-store.zip`. If it is accepted, the id should come from the embedded `key`.
2. If the dashboard rejects it over the `key` field, either switch to Option A, or upload `upload/fast-browser-0.2.11-store-nokey.zip` and accept a store-assigned id. Accepting a new id means updating `runtime-lock.json`'s extension `id` (and anything else `grep fnfikoifhimpdedpdepehibjjkcfbacm` finds) if the store copy should ever be the one the CLI recognizes.

The id is fixed by the first successful upload and can never change afterward, so settle this before clicking upload.

## Dashboard walkthrough

### 1. One-time registration

- Sign in to the developer dashboard: https://chrome.google.com/webstore/devconsole
- Register as a Chrome Web Store developer and pay the one-time 5 USD registration fee.
- In the **Account** tab: verify the contact email (required before anything can be submitted) and complete the trader / non-trader declaration. For a free, open-source personal tool, non-trader is the fitting answer; note that non-trader items cannot charge money, which is fine here.

### 2. Create the item

- Dashboard home, click **+ New item**.
- Upload the zip chosen above. The dashboard parses the manifest and creates the draft item.
- After upload, the **Package** tab shows the manifest it read; confirm version 0.2.11 and check which id the draft was given before going further.

### 3. Store listing tab

Paste from `listing.md`:

- Title and summary come from the manifest (read-only; confirm they look right).
- Description: the plain-text block from `listing.md`.
- Category: **Developer Tools**. Language: **English**.
- Store icon: upload `icon-128.png`.
- Screenshots: upload both PNGs from `screenshots/`.
- Homepage URL and support URL as listed in `listing.md`.

### 4. Privacy tab

Paste from `justifications.md`:

- Single purpose description.
- One justification per permission (debugger, activeTab, tabs, tabGroups, storage, host permission).
- Remote code: **No**, with the justification text.
- Data usage: check no collection categories, check all three certifications.
- Privacy policy URL: `https://github.com/m4ttstack/fast-browser/blob/main/store/privacy-policy.md` (valid once this directory is on main).

### 5. Distribution tab

- Visibility: **Unlisted**. Anyone with the link can install it; it does not appear in search or browse. It still goes through the same review as a public item.
- Distribution: all regions is fine.

### 6. Submit

- **Submit for review**. If a "publish automatically after review" option is offered, leaving it on is fine for an unlisted item.

## Expected review timeline

Most items clear review within a few days. This one uses `debugger` plus `<all_urls>` host access, which routinely routes into the slower, deeper review lane: allow one to three weeks, and expect a possible rejection round asking to justify the broad permissions (the answers in `justifications.md` are written to survive that). The `debugger` permission also means Chrome shows users a "Started debugging this browser" warning bar while an agent is attached; that is normal and cannot be suppressed.

## After approval

- The item page URL will be `https://chromewebstore.google.com/detail/<the-id>`; that is the link to share for installs.
- Updates are new zip uploads of the same item (bump the manifest version first). Updates re-enter review but keep the id regardless of the `key` field question.
