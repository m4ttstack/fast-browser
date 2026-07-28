import { LifecycleError } from '../commands/shared.mjs';

// Vendored from @radix-ui/colors v3 (MIT). Each entry is one Radix light
// scale reduced to the three steps the annotator needs:
//   accent = step 9  (solid)               strokes, borders, counter fill,
//                                          and highlight fill at 14% opacity
//   soft   = step 3  (subtle component bg) chip fill only
//   ink    = step 11 (accessible text)     chip label text
// Radix guarantees step 11 reads accessibly on step 3, which is why the trio
// is taken from one scale rather than hand-picked.
export const RADIX_SCALES = Object.freeze(
  Object.fromEntries(
    Object.entries({
      amber: { accent: '#ffc53d', soft: '#fff7c2', ink: '#ab6400' },
      blue: { accent: '#0090ff', soft: '#e6f4fe', ink: '#0d74ce' },
      bronze: { accent: '#a18072', soft: '#f6edea', ink: '#7d5e54' },
      brown: { accent: '#ad7f58', soft: '#f6eee7', ink: '#815e46' },
      crimson: { accent: '#e93d82', soft: '#ffe9f0', ink: '#cb1d63' },
      cyan: { accent: '#00a2c7', soft: '#def7f9', ink: '#107d98' },
      gold: { accent: '#978365', soft: '#f2f0e7', ink: '#71624b' },
      grass: { accent: '#46a758', soft: '#e9f6e9', ink: '#2a7e3b' },
      gray: { accent: '#8d8d8d', soft: '#f0f0f0', ink: '#646464' },
      green: { accent: '#30a46c', soft: '#e6f6eb', ink: '#218358' },
      indigo: { accent: '#3e63dd', soft: '#edf2fe', ink: '#3a5bc7' },
      iris: { accent: '#5b5bd6', soft: '#f0f1fe', ink: '#5753c6' },
      jade: { accent: '#29a383', soft: '#e6f7ed', ink: '#208368' },
      lime: { accent: '#bdee63', soft: '#eef6d6', ink: '#5c7c2f' },
      mauve: { accent: '#8e8c99', soft: '#f2eff3', ink: '#65636d' },
      mint: { accent: '#86ead4', soft: '#ddf9f2', ink: '#027864' },
      olive: { accent: '#898e87', soft: '#eff1ef', ink: '#60655f' },
      orange: { accent: '#f76b15', soft: '#ffefd6', ink: '#cc4e00' },
      pink: { accent: '#d6409f', soft: '#fee9f5', ink: '#c2298a' },
      plum: { accent: '#ab4aba', soft: '#fbebfb', ink: '#953ea3' },
      purple: { accent: '#8e4ec6', soft: '#f7edfe', ink: '#8145b5' },
      red: { accent: '#e5484d', soft: '#feebec', ink: '#ce2c31' },
      ruby: { accent: '#e54666', soft: '#feeaed', ink: '#ca244d' },
      sage: { accent: '#868e8b', soft: '#eef1f0', ink: '#5f6563' },
      sand: { accent: '#8d8d86', soft: '#f1f0ef', ink: '#63635e' },
      sky: { accent: '#7ce2fe', soft: '#e1f6fd', ink: '#00749e' },
      slate: { accent: '#8b8d98', soft: '#f0f0f3', ink: '#60646c' },
      teal: { accent: '#12a594', soft: '#e0f8f3', ink: '#008573' },
      tomato: { accent: '#e54d2e', soft: '#feebe7', ink: '#d13415' },
      violet: { accent: '#6e56cf', soft: '#f4f0fe', ink: '#6550b9' },
      yellow: { accent: '#ffe629', soft: '#fffab8', ink: '#9e6c00' },
    })
      .map(([name, scale]) => [name, Object.freeze(scale)]),
  ),
);

// Closest Radix scale to the #7C4DFF the source annotator hardcoded.
export const DEFAULT_PALETTE = 'violet';

// What the skill presents on first use. Config accepts any RADIX_SCALES key.
export const OFFERED_PALETTES = Object.freeze([
  'violet', 'iris', 'indigo',
  'crimson', 'red', 'orange',
  'teal', 'cyan', 'grass',
  'slate',
]);

export function resolvePalette(name) {
  // Own-property check: a bare `RADIX_SCALES[name]` would resolve
  // '__proto__' and 'constructor' to objects that are not palettes.
  if (typeof name !== 'string' || !Object.hasOwn(RADIX_SCALES, name)) {
    throw new LifecycleError(
      `unknown annotation palette: ${typeof name === 'string' ? name : '<invalid>'}`,
      { stage: 'validate', exitCode: 2 },
    );
  }
  return { ...RADIX_SCALES[name] };
}
