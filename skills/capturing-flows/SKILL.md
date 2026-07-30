---
name: capturing-flows
description: Use when motion is the evidence, such as demonstrating a multi-step flow, a transition, a loading state, or a bug that only shows while it happens, by recording a browser session and delivering it as a GIF
---

# Capturing Flows

A recording shows what a screenshot cannot: the order things happened in.
Fast Browser records the browser session it drives to WebM and converts the
result to shareable GIFs with `fast-browser gif`.

## Which sessions record

Recording covers the session Fast Browser drives: the real Chrome tabs
attached through the extension relay, the ordinary connected setup. Only the
tabs Fast Browser controls are recorded -- other tabs, windows, and profiles
stay untouched, and the fast-browsing browser boundaries hold unchanged;
there is no separate isolated browser to record in. Because the recording is
of the user's real Chrome, everything visible in the driven tab lands in the
file, which makes the PII rule below load-bearing, not theoretical.

## The pipeline

1. **Enable recording once:**

   ```bash
   fast-browser configure --video 1280x720
   ```

   The size is the recorded frame size, `<width>x<height>` from 320x240 up to
   3840x2160. `fast-browser configure --video off` turns recording back off,
   and either invocation touches only the video setting, never your profile,
   sessions, or palette. The new setting applies to sessions started after it,
   not to one already running.

2. **Record one flow per tab.** Every page records into its own file, so a
   recording that mixes flows cannot be split afterwards. Open a fresh tab,
   drive exactly the flow you are demonstrating, and stop.

3. **Close to finalize.** The WebM is written incrementally and only becomes
   a valid, complete file when the tab or the session closes cleanly; a
   session that dies without closing its tab loses the recording. Never
   collect a recording from a tab that is still open; close it first.

4. **Collect from the videos directory.** Recordings land in
   `~/.fast-browser/videos/` under generated names. The newest `.webm` there
   is the recording that just finished.

5. **Convert with the CLI:**

   ```bash
   fast-browser gif <name>.webm --fps 8 --width 800
   ```

   `<name>` is a name inside `~/.fast-browser/videos/`, never a path. The GIF
   lands in `~/.fast-browser/screenshots/` (same name, `.gif`, or choose one
   with `--out`). `--fps` is 1 to 30 and defaults to 8; `--width` caps the
   output width at up to 1200 px, defaults to 1200, and never upscales.
   Conversion needs ffmpeg; if the command reports it missing, run
   `brew install ffmpeg`, then `fast-browser doctor` to confirm.

6. **Watch the output GIF yourself** before delivering it: the whole flow is
   visible, nothing sensitive is in frame, the file is a sane size. Lower
   `--fps` or `--width` when it is too heavy.

## PII in motion

A video cannot carry `annotate`'s redactions: there is no blur pass over a
recording, so anything visible in any frame ships exactly as it appeared.
When the flow you recorded shows PII, do not deliver the recording. Either
re-record a cleaner flow that keeps the PII out of frame (test data, a
narrower window, a different case), or fall back to annotated stills: capture
the key steps with the annotating-screenshots skill and blur what needs
blurring there. Say plainly which you did; never deliver motion evidence
containing PII on the promise that nobody will look closely.

## When something fails

| Symptom | Cause and fix |
|---|---|
| No `.webm` appears in `~/.fast-browser/videos/` | Recording was enabled after the session started; the setting only applies to sessions started after it. Enable first, then start a fresh session and re-drive the flow |
| The `.webm` is tiny or unreadable | The session is still open, so the file is not finalized yet. Close the tab or session, then collect |
| `gif` reports the renderer missing | `brew install ffmpeg`, then `fast-browser doctor` to confirm |
| `gif` refuses the name | `<name>` must be a bare name inside the videos directory, and `--out` a bare name for the screenshots directory, never paths |

Output lands in `~/.fast-browser/screenshots/`, which
`fast-browser uninstall --purge-data` destroys, so deliver anything worth
keeping rather than leaving it there.
