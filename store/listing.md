# Chrome Web Store listing fields

Everything below is ready to paste into the dashboard's **Store listing** tab.

## Item title

```
Fast Browser
```

The title is read from the uploaded package's manifest `name` field. The dashboard shows it read-only; changing it requires a new package upload.

## Summary (max 132 characters)

```
Connect your existing Chrome session to Fast Browser for local Claude Code and Codex automation.
```

96 characters. Like the title, the summary is sourced from the manifest `description` field of the uploaded package and is read-only in the dashboard. To change it, change `packages/extension/manifest.json` in the runtime fork and re-upload.

## Category

Developer Tools

## Language

English

## Description (plain text, paste as-is)

```
Fast Browser lets coding agents such as Claude Code and Codex drive the Google Chrome you already have open: your profile, your logins, your tabs. It is the browser half of the open-source fast-browser CLI, which runs a local MCP runtime on your machine.

How it works:

1. Install the fast-browser CLI on your machine (npx @mattstack/fast-browser setup).
2. Load this extension and approve the connection when your agent asks to pair.
3. The agent drives the tabs you attached through Chrome's debugger API, inside its own labelled tab group.

What makes it different:

- It attaches to your real Chrome, so agents start from a browser that is already signed in to the things you use. No blank automation profile, no re-login, no consent banners.
- Multiple agents can work in the same Chrome at once. Each connection gets its own colored, labelled tab group and can only control the tabs it attached. Your own tabs are never touched.
- It stays out of your way. Agents do not steal window focus, so you can keep using the browser while they work.

Privacy:

- The extension talks only to the fast-browser runtime on your own machine, over a loopback connection (127.0.0.1). It makes no other network connections of its own.
- No analytics, no tracking, no remote servers, no data collection, no data sale. The pairing token never leaves your device.
- You approve every connection in the browser, and you can disconnect any agent at any time from the extension's status page.

This extension does nothing on its own; it pairs with the fast-browser CLI. Setup, documentation, and source: https://github.com/m4ttstack/fast-browser
```

## Store icon (128x128)

Upload `store/icon-128.png` (copied from the extension's `icons/icon-128.png`).

## Screenshots (1280x800)

Upload both files from `store/screenshots/`:

- `screenshot-1-hero-1280x800.png`
- `screenshot-2-how-it-works-1280x800.png`

## Additional fields

- Homepage URL: `https://github.com/m4ttstack/fast-browser`
- Support URL: `https://github.com/m4ttstack/fast-browser/issues`
- Official URL: leave blank (requires a site verified in Search Console)
- Promo video: none
- Global promo images (440x280 small tile, 1400x560 marquee): optional, skip
