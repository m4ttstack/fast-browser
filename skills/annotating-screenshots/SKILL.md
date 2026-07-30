---
name: annotating-screenshots
description: Use when a browser screenshot needs markup before it is shown or shared, such as highlighting a value that changed, pointing at a control, labelling a step, or blurring PII out of a capture
---

# Annotating Screenshots

One `capture-annotated.js` call produces the PNG and the boxes together. Every
number in the config comes from that one call. Nothing is estimated by reading
the image, and nothing is typed by hand.

## The pipeline

1. **Capture and measure in one call.** `browser_run_code_unsafe` with the
   macro's installed path as `filename`, never a bare name: a relative
   `filename` is resolved against the browser server's own working directory
   and then checked for containment, so a bare name fails before the macro
   runs. Pass the `Script:` path from `~/.fast-browser/macros/MACROS.md`,
   `~/.fast-browser/macros/capture-annotated.js`, with `~` written out as your
   own absolute home directory path. Then
   `args: { targets: { <key>: '<selector>' }, out: '<name>', home: '<your $HOME>' }`.
   The macro cannot read `$HOME` itself, so pass your own absolute home
   directory path there too. `targets` is for elements: the values you mark
   and anything an arrow points at. The empty space a label sits in is
   usually not an element, so the macro measures that for you: the return's
   `space` map gives each resolved key up to four verified-empty bands
   (`{ side, box }`, sides `above`/`below`/`left`/`right`, a side omitted
   wherever no empty room of useful size exists). What that verification
   covers, and the blind spots it cannot, is stated under Composition. You
   cannot add a key after the call. Under the default `safe` profile this prompts for approval every
   time. Expect the prompt; it is not a failure.
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

- **`chip.xy`, `counter.xy` and `arrow.tail` anchor inside a band from the
  macro's `space` map, never at a spot read off the image.** Pick one of the
  target's returned bands and place with fixed arithmetic only, padding and
  centring, no nudging by feel. The three are not anchored alike, so each has
  its own derivation from a band `[x, y, w, h]`:
  - A `chip` is anchored by its top left, so centring it has to subtract its
    own size: `xy = [x + (w - width) / 2, y + (h - height) / 2]`, using the
    chip width and height given below. In a deep band, centre across it but
    sit 6 px inside the edge nearest the target rather than centring on the
    long axis, e.g. `y + 6` in a `below` band, so the label stays visually
    attached to what it names.
  - A `counter` is anchored by its centre, so its centre is the band's
    centre: `xy = [x + w / 2, y + h / 2]`. Using the chip formula puts every
    counter up and left of where you meant by its radius, about 16 px at the
    default size.
  - An `arrow.tail` is a bare point placed in the band the same way as a
    counter; the head comes from the target's own resolved box.
  - When `space` has no band for a target, anchor at the target's own padded
    box corner, the `[x2, y2]` from the padding step, and say plainly in your
    report that the label sits on content because no empty band existed.
    Eyeballing empty space on a live capture remains forbidden.
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
- Labels go in a `space` band, which is the only measured evidence a spot is
  empty. The measurement is geometric, so it catches what point hit-testing
  cannot: pointer-events:none text, a background image an ancestor (or the
  body) paints under a transparent container, an iframe's content, text
  smaller than any sampling grid. It still has stated blind spots -- closed
  shadow roots, and decoration painted only by borders, box shadows, or
  background colours can sit under a returned band -- which is one more
  reason step 4 makes you read the output PNG before reporting. A chip
  dropped on a card's other fields is the most common obstruction, and it is
  exactly what an unmeasured "that looks clear" produces.
- Never blur the value the screenshot exists to prove.

## The config

`base` and `out` are names inside `~/.fast-browser/screenshots/`, never paths,
and `out` must differ from `base`. Use the macro's returned `name` as `base`.

The capture behind this one asked for two keys, `estimate` and `name`, and
took the label's spot from the `space` bands the same call measured.

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
    { "type": "chip", "xy": [760, 229], "text": "new estimate", "size": 14 }
  ]
}
```

Every number above is derived. The two boxes are the resolved `estimate` and
`name`, `[783, 200, 72, 17]` and `[320, 128, 99, 17]`, after the 6 px pad. The
chip is 117 px wide by 28 px tall at `size: 14`, centred across the `below`
band `space` returned for `estimate`, `[759, 223, 120, 240]`, and 6 px inside
its top edge, the edge nearest the target. Nothing was read off the image.

## Foreign images

A PNG that did not come from `capture-annotated.js` -- a bug screenshot pulled
off a ticket, an image somebody handed you -- has no macro return to copy from,
so the pipeline above cannot produce it. Use import mode: replace `base` and
`measured` with `import`, the image's absolute path (`~` written out in full,
as with the macro path), which must be outside `~/.fast-browser/screenshots/`.
`out` is still a name in that directory, never a path.

```json
{
  "import": "~/Downloads/ticket-4471.png",
  "out": "ticket-4471-redacted.png",
  "annotations": [
    { "type": "blur", "box": [314, 122, 111, 29], "amount": 15 }
  ]
}
```

Coordinates are read off the image, because there is no live page to measure.
This is the **only** situation where reading coordinates off the image is
allowed. Anything you can re-render is a live capture, and every rule above
still binds it: one call, one truth, and never a hand-authored `measured`. The
`blur.amount` rule applies to a foreign image exactly as to a capture, and so
does step 4: read the output PNG yourself before delivering it.

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
| `browser_run_code_unsafe` reports `ENOENT` for the macro, or refuses it as outside the allowed roots | `filename` was a bare or relative name, so it resolved against the browser server's working directory. Pass `~/.fast-browser/macros/capture-annotated.js` with your home directory written out in full. If the file is genuinely absent, run `fast-browser setup` |
| The macro ran and returned `failedStep` with no `resolved` | Nothing was captured or measured, so there is no partition to read. Fix the named argument, usually `home`, and call again |
| `annotate` reports a missing renderer | `brew install librsvg`, then `fast-browser doctor` to confirm |
| `annotate` refuses a box as outside the image | You clamped to the larger viewport width. Use `min(inner, client)` |
