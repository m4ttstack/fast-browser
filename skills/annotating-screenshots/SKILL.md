---
name: annotating-screenshots
description: Use when a browser screenshot needs markup before it is shown or shared, such as highlighting a value that changed, pointing at a control, labelling a step, or blurring PII out of a capture
---

# Annotating Screenshots

One `capture-annotated.js` call produces the PNG and the boxes together. Every
number in the config comes from that one call. Nothing is estimated by reading
the image, and nothing is typed by hand.

## The pipeline

1. **Capture and measure in one call.** `browser_run_code_unsafe` with
   `filename: 'capture-annotated.js'` and
   `args: { targets: { <key>: '<selector>' }, out: '<name>', home: '<your $HOME>' }`.
   The macro has no Node globals and cannot read `$HOME` itself, so pass your
   own absolute home directory path. Put every label anchor in `targets` too,
   not just the values you are marking: a chip, a counter and an arrow tail
   each need a measured box exactly as much as a highlight does, and you
   cannot add a key after the call. Under the default `safe` profile this
   prompts for approval every time. Expect the prompt; it is not a failure.
2. **Write the config** from that call's return value.
3. **Draw:** `fast-browser annotate <config-path>`.
4. **Read the output PNG yourself** before reporting: nothing clipped at an
   edge, nothing covering content it should not, blurred text genuinely
   illegible. Then report the output name and every missed key.

If `~/.fast-browser/macros/capture-annotated.js` is absent, run
`fast-browser setup` to install it. Do not write a substitute script.

## One call, one truth

The PNG and the boxes must come from the same return value of the same call.
That adjacency is the only thing that makes the coordinates true: a lazy image,
a font swap, or a dismissing toast between capture and measurement moves
elements, and the boxes then describe a layout the PNG does not show.

**Never:**

- Annotate a PNG captured by an earlier call, an earlier turn, or anyone else.
  Re-run the macro; a fresh capture is cheap and a correlated one is a guess.
- Measure with your own `boundingBox()` or `getBoundingClientRect()` call.
  Correct numbers from a second page visit are still the wrong numbers.
- Type, recompute, or carry over `measured`. Copy `schemaVersion` and
  `viewport` verbatim from the macro return. That block is the check that the
  base image matches the boxes, so hand-writing it passes the check while lying
  to it. Real pages often report differing `inner` and `client` widths (a
  scrollbar), which is exactly what it exists to catch.
- Estimate coordinates by reading the PNG.

## Missed keys

On a call that ran, every key you asked for comes back in exactly one of
`resolved` or `missed`. Draw only from `resolved`. Draw nothing for a missed
key, and name it and its reason in what you report.

| Reason | What to do |
|---|---|
| `no-match` | Fix the selector, re-run the macro |
| `ambiguous` | Make the selector unique, re-run. Never take the first of N matches |
| `not-visible`, `out-of-view` | Scroll or resize so it is in the viewport, re-run |

Every fix is a fresh macro call, never a patch on an old result.

**A redaction target that came back missed has not been redacted.** Say so
plainly rather than delivering the image as redacted.

## Turning boxes into annotations

Pad every measured box by 6 px on each side, then clamp to the image, where `W`
and `H` are `min(inner, client)` of the returned `viewport`. The two differ
whenever the page has a classic scrollbar, and clamping to the larger one can
produce boxes `annotate` refuses as outside the image. The smaller is always
safe.

```
x2 = max(0, x - 6)             y2 = max(0, y - 6)
w2 = min(W, x + w + 6) - x2    h2 = min(H, y + h + 6) - y2
```

Padding, and the conversions below, are the only arithmetic allowed on a
measured number. Do not also nudge by feel.

| Primitive | Fields | Use it for |
|---|---|---|
| `highlight` | `box` | Frame the value that changed, translucent so it stays readable |
| `box` | `box` | Outline a region without tinting it |
| `arrow` | `tail`, `head`, `bow?`, `width?` | Point at one thing |
| `chip` | `xy`, `text`, `size?`, `w?` | A short label |
| `ellipse` | `cx`, `cy`, `rx`, `ry?` | Ring a small badge or icon |
| `counter` | `xy`, `n`, `size?` | Number the steps of a flow |
| `spotlight` | `box`, `dim?` | Isolate one region in a busy view |
| `blur` | `box`, `amount?` | Redact PII |

Geometry that is not guessable:

- **`chip.xy`, `counter.xy` and `arrow.tail` come from a resolved anchor box,
  never from looking at the image.** Inside an anchor `[x, y, w, h]`, centre a
  label with `xy = [x + (w - width) / 2, y + (h - height) / 2]`. This is why
  the anchor goes in `targets` with everything else.
- `chip.xy` is its **top left** corner. Its height is `size * 2` and its width
  is `characters * size * 0.58 + size * 1.4`, so at the default `size: 22` a
  chip is 44 px tall and roughly `13 * characters + 31` px wide. Set `w` to fix
  the width instead. When no anchor is 44 px tall, drop `size` to 16 or 14,
  which gives a 32 or 28 px chip. Shrink the label rather than put it on
  content.
- `counter.xy` is its **centre**, unlike `chip`. Its radius is `size * 0.9`,
  about 16 px at the default `size: 18`.
- `annotate` bounds-checks only the anchor point of a `chip` and a `counter`,
  so it will not catch a label running off the canvas. Check yourself that
  `x + width <= W` and `y + height <= H`.
- An `ellipse` takes a centre and radii rather than a box. Convert a resolved
  `[x, y, w, h]` with `cx = x + w / 2`, `cy = y + h / 2`, `rx = w / 2 + 6`,
  `ry = h / 2 + 6`, which is the same 6 px of breathing room.
- `blur.amount` is half the box height rounded up, clamped to 8 through 40. The
  default 8 covers one line of body text; a 40 px heading needs 20.
- Coordinates are always in base image pixels. `scale` is an integer from 1 to
  4, defaults to 2, and only changes the output resolution.

## Composition

- A highlight must fully enclose its value. Never clip the first or last
  character; widen it.
- Labels go in genuinely empty space, never over card content. A chip dropped
  on a card's other fields is the most common obstruction.
- Never blur the value the screenshot exists to prove.

## The config

`base` and `out` are names inside `~/.fast-browser/screenshots/`, never paths,
and `out` must differ from `base`. Use the macro's returned `name` as `base`.

The capture behind this one asked for three keys: `estimate` and `name` for the
two values, and `band` for the empty strip the label sits in.

```json
{
  "base": "claim.png",
  "out": "claim-annotated.png",
  "measured": {
    "schemaVersion": 1,
    "viewport": { "inner": [900, 560], "client": [885, 560] }
  },
  "annotations": [
    { "type": "highlight", "box": [777, 194, 84, 29] },
    { "type": "blur", "box": [314, 122, 111, 29], "amount": 15 },
    { "type": "chip", "xy": [358, 473], "text": "new estimate" }
  ]
}
```

Every number above is derived. The two boxes are the resolved `estimate` and
`name`, `[783, 200, 72, 17]` and `[320, 128, 99, 17]`, after the 6 px pad. The
chip is 184 px wide by 44 px tall and centred in the resolved `band`
`[40, 460, 820, 70]`. Nothing was read off the image.

## First annotation on a machine

`annotate` refuses to draw with no palette configured. Offer these ten, then run
the choice once:

`violet` (recommended), `iris`, `indigo`, `crimson`, `red`, `orange`, `teal`,
`cyan`, `grass`, `slate`

```bash
fast-browser configure --palette <name>
```

Later annotations are silent. Output lands in `~/.fast-browser/screenshots/`,
which `fast-browser uninstall --purge-data` destroys, so deliver anything worth
keeping rather than leaving it there.

## When something fails

| Symptom | Cause and fix |
|---|---|
| The return has `failedStep` and no `resolved` | Nothing was captured or measured, so there is no partition to read. Fix the named argument, usually `home`, and call again |
| `annotate` reports a missing renderer | `brew install librsvg`, then `fast-browser doctor` to confirm |
| `annotate` refuses a box as outside the image | You clamped to the larger viewport width. Use `min(inner, client)` |
