# Fast Browser Extension Privacy Policy

Effective date: September 11, 2026

Fast Browser is a Chrome extension that connects your own browser to the open-source fast-browser runtime running on your own machine, so coding agents you run (such as Claude Code and Codex) can drive tabs you have explicitly attached.

## Data collection

The extension collects no user data. The developer receives nothing: no analytics, no telemetry, no crash reports, no identifiers, no browsing history.

## Where your data goes

Everything stays on your device:

- The extension's only network connection is to the fast-browser runtime on your own machine, over a loopback address (127.0.0.1 or [::1]). It refuses to connect anywhere else.
- Page content, tab titles, and URLs are read only from tabs you have attached to an agent connection, and are handed only to that local runtime, which passes them to the coding agent you are running. What your agent does with that content is governed by the agent and its provider, not by Fast Browser.
- The pairing token that authorizes a connection is generated in the extension and stored only on your device. It is never transmitted to the developer or any third party.
- Local bookkeeping (such as the labels of tab groups the extension created) is kept in Chrome's local extension storage on your device and is not synced.

## Data sale and transfer

No data is sold. No data is transferred to the developer or to any third party. There is nothing to sell or transfer: the developer operates no servers for this extension.

## Changes

Changes to this policy will be published at this URL with an updated effective date.

## Contact

Questions and issues: https://github.com/m4ttstack/fast-browser/issues
