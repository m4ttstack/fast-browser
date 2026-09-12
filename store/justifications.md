# Privacy practices tab answers

Everything below is ready to paste into the dashboard's **Privacy** tab. All statements are true of extension version 0.2.11.

## Single purpose description

```
Fast Browser is a local browser automation bridge. It connects the user's own Chrome to the open-source fast-browser runtime on the same machine, over a loopback connection, so the user's own coding agents (such as Claude Code and Codex) can drive tabs the user has explicitly attached. Every feature of the extension serves that one purpose.
```

## Permission justifications

### debugger

```
The extension automates tabs through the Chrome DevTools Protocol via chrome.debugger: navigating, clicking, typing, reading page state, and taking screenshots. This is the core mechanism by which the user's coding agent drives the browser. The debugger is attached only to tabs the user has approved for an agent connection, and is detached when the connection closes.
```

### activeTab

```
Grants temporary access to the tab the user is interacting with when they invoke the extension, so a connection can start from the page the user is on without requesting anything broader up front.
```

### tabs

```
The extension lists open tabs (title and URL) on its connect page so the user can choose which tab to hand to an agent, tracks which tabs belong to which agent connection, and opens or closes tabs on behalf of the connected agent. Tab metadata is used only inside the extension and the local runtime; it is not sent anywhere else.
```

### tabGroups

```
Each agent connection is placed in its own labelled, colored Chrome tab group so the user can see at a glance which tabs each agent controls and which tabs are their own. The extension creates, updates, and removes only the groups it made.
```

### storage

```
chrome.storage.local holds small local bookkeeping and pairing state: the labels of tab groups the extension created (so stale groups can be cleaned up after the service worker restarts) and local settings. Nothing is synced and nothing leaves the device.
```

### Host permission: <all_urls>

```
The user decides which sites their agent works on, so the extension cannot know the sites in advance: an agent may be asked to operate any page the user chooses to attach. Access is exercised only on tabs the user has explicitly connected to an agent session; the extension does not read or modify other tabs.
```

### Remote code

Answer: **No, I am not using remote code.**

```
All code ships inside the package. The extension loads no remote scripts, injects no remotely hosted code, and evaluates no remotely fetched strings. Its only network connection is a WebSocket to the fast-browser runtime on the user's own machine (loopback only; the extension refuses non-loopback hosts).
```

## Data usage disclosures

In "What user data do you plan to collect from users?", check **none** of the categories (no personally identifiable information, no health, no financial and payment information, no authentication information, no personal communications, no location, no web history, no user activity, no website content).

Rationale, if a reviewer asks: page content and tab metadata are processed transiently on the user's device and handed only to the local runtime the user installed, at the user's direction. The developer receives nothing; nothing is transmitted off the machine by the extension, stored by the developer, or used for any secondary purpose.

Check all three certifications, which are true:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

```
https://github.com/m4ttstack/fast-browser/blob/main/store/privacy-policy.md
```
