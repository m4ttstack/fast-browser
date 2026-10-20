import { screenshot } from './screenshot.mjs';

// The real-glyph probes of an imported redaction fill. Each case draws a value in Chromium twice: once to measure
// the redact box (the tight ink box of the glyphs, or of part of them), once as the image the box is drawn on, with
// the decoration, the second line or the trailing word the box leaves out. A case exposes the pixels more than 8 off
// white that lie outside its fill: every pixel in the image is the value's.
const FONT = 'font:14px Helvetica,Arial,sans-serif;color:#111827';
const at = (style, text) => ({ style, text });

export function fillProbeCases() {
  const cases = [];
  const add = (set, name, dpr, measure, shown, adjust = [0, 0, 0, 0]) => cases.push({ set, name, dpr, measure, shown, adjust });

  // real: one value of each kind of shortfall.
  const VALUE = 'jim.quinn@tracker.example';
  add('real', 'R1 2x underlined value', 2, at('', VALUE), at('text-decoration:underline', VALUE));
  add('real', 'R2 1x underline offset 4px', 1, at('', VALUE), at('text-decoration:underline;text-underline-offset:4px', VALUE));
  add('real', 'R3 2x box 6 px short on the right', 2, at('', VALUE), at('', VALUE), [0, 0, -6, 0]);
  add('real', 'R3b 2x box 10 px short on the right', 2, at('', VALUE), at('', VALUE), [0, 0, -10, 0]);
  add('real', 'R4 2x box 2 px short on every side', 2, at('', VALUE), at('', VALUE), [2, 2, -2, -2]);
  add('real', 'R5 1x box over the first word only', 1, at('', 'Jo'), at('', 'Jo Li'));
  add('real', 'R6 2x box top 5 px low', 2, at('', 'minimum run'), at('', 'minimum run'), [0, 5, 0, 0]);

  // real2: plain underlines and boxes a few px short.
  for (const [label, dpr, font] of [['1x 14px', 1, 14], ['2x 14px', 2, 14], ['2x 20px', 2, 20], ['1x 20px', 1, 20]]) {
    const base = `font-size:${font}px;line-height:${font + 6}px;`;
    for (const name of ['Sam Rivera', 'Sam Lee', 'Avi Kumar']) {
      add('real2', `U ${label} ${name}`, dpr, at(base, name), at(`${base}text-decoration:underline`, name));
      add('real2', `U4 ${label} ${name}`, dpr, at(base, name), at(`${base}text-decoration:underline;text-underline-offset:4px`, name));
      for (let short = 1; short <= 10; short += 1) add('real2', `S ${label} ${name} ${short}`, dpr, at(base, name), at(base, name), [0, 0, -short, 0]);
      for (let short = 1; short <= 10; short += 1) add('real2', `L ${label} ${name} ${short}`, dpr, at(base, name), at(base, name), [short, 0, 0, 0]);
    }
    for (const name of ['minimum', 'jim']) for (let low = 1; low <= 10; low += 1) add('real2', `T ${label} ${name} ${low}`, dpr, at(base, name), at(base, name), [0, low, 0, 0]);
  }

  // real3: thick or offset decorations and wrapped values, the box tight to the glyphs.
  for (const dpr of [1, 2]) for (const font of [12, 14, 20]) {
    const base = `font-size:${font}px;line-height:${font + 6}px;`;
    for (const name of ['Sam Rivera', 'mean', 'none', 'anna']) {
      for (const thick of [1, 2, 3, 4]) for (const offset of [2, 3, 4, 6, 8]) {
        add('real3', `TU ${dpr}x ${font}px ${name} ${thick}/${offset}`, dpr, at(base, name), at(`${base}text-decoration:underline;text-decoration-thickness:${thick}px;text-underline-offset:${offset}px`, name));
      }
      for (const border of [1, 2, 3, 4]) for (const pad of [2, 3, 4, 6]) {
        const block = `${base}display:inline-block;padding-bottom:${pad}px;border-bottom:${border}px solid`;
        add('real3', `BB ${dpr}x ${font}px ${name} ${border}/${pad}`, dpr, at(`${block} transparent`, name), at(`${block} #111827`, name));
      }
      add('real3', `SC ${dpr}x ${font}px ${name}`, dpr, at(`${base}font-variant:small-caps`, name), at(`${base}font-variant:small-caps;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:4px`, name));
    }
    for (const lead of [0, 4, 8, 12]) {
      const lines = `font-size:${font}px;line-height:${font + lead}px;`;
      const hidden = (text) => `<span style="color:transparent">${text}</span>`;
      add('real3', `2L ${dpr}x ${font}px +${lead} box on line 1`, dpr, at(lines, `Samantha<br>${hidden('Rivera-Okafor')}`), at(lines, 'Samantha<br>Rivera-Okafor'));
      add('real3', `2L ${dpr}x ${font}px +${lead} box on line 2`, dpr, at(lines, `${hidden('Samantha')}<br>Rivera-Okafor`), at(lines, 'Samantha<br>Rivera-Okafor'));
      add('real3', `2Llc ${dpr}x ${font}px +${lead} box on line 1`, dpr, at(lines, `sam<br>${hidden('rivera')}`), at(lines, 'sam<br>rivera'));
    }
  }

  // real4: a box drawn short of the value's height, over an underline, at 2x and 3x.
  const decorations = ['', ';text-decoration-thickness:2px;text-underline-offset:4px', ';text-decoration-thickness:1px;text-underline-offset:3px'];
  for (const dpr of [2, 3]) for (const font of [12, 14, 16]) for (const name of ['mean', 'Sam Rivera']) for (const inset of [2, 4, 6]) for (const decoration of decorations) {
    const base = `font-size:${font}px;line-height:${font + 6}px;`;
    add('real4', `DU ${dpr}x ${font}px ${name} inset ${inset}${decoration}`, dpr, at(base, name), at(`${base}text-decoration:underline${decoration}`, name), [0, inset, 0, -inset]);
  }
  return cases;
}

// Values whose fill reads its density or its lines wrong unless it takes care: capitals and digits whose inkiest row
// is one bar (the foot of an L, the top of a 7), wrapped values whose other line runs left or right past the box, and
// a trailing word just past the box's reach. Each is drawn three times: with the box's part of the value alone (the
// measure), whole (shown), and with the value hidden, so the value's ink is what differs between the last two. A
// case must leave none of it bare, or be refused.
export function fillProbeHardCases() {
  const cases = [];
  const hidden = (text) => `<span style="color:transparent;text-decoration-color:transparent;border-color:transparent">${text}</span>`;
  const at = (css) => (inner) => `<div class=vv style="position:absolute;left:60px;top:50px;${css}">${inner}</div>`;
  const add = (set, name, dpr, body, measure, shown) => cases.push({ set, name, dpr, cell: [500, 160], masked: true, measure: body(measure), shown: body(shown) });
  const border = (width, pad, colour) => `display:inline-block;padding-bottom:${pad}px;border-bottom:${width}px solid ${colour}`;
  const underline = (thick, offset) => `text-decoration:underline;text-decoration-thickness:${thick}px;text-underline-offset:${offset}px`;

  for (const dpr of [1, 2, 3]) for (const font of [11, 12, 13, 14, 16]) for (const name of ['555 0147', '(717) 555-0177', '4111 1111 1111 1111', '17/11/1977', 'TYLER', 'TAYLOR SMITH', 'SAM RIVERA', 'LI', 'Jo', 'tj@tt.io', 'ZZ TOP', '7', 'FIT 7711']) {
    const body = at(`font-size:${font}px;line-height:${font + 8}px`);
    add('density', `"${name}" ${dpr}x ${font}px border 2/6`, dpr, body, `<span style="${border(2, 6, 'transparent')}">${name}</span>`, `<span style="${border(2, 6, '#111827')}">${name}</span>`);
    add('density', `"${name}" ${dpr}x ${font}px and a word`, dpr, body, `${name}${hidden('&nbsp;&nbsp;&nbsp;Okafor')}`, `${name}&nbsp;&nbsp;&nbsp;Okafor`);
  }
  for (const dpr of [2, 3]) for (const font of [12, 14, 20]) for (const name of ['LI', 'ELLIE TILL', 'TYLER', '7171', 'ZETTEL', 'Sam Rivera']) {
    const body = at(`font-size:${font}px;line-height:${font + 6}px`);
    for (const [thick, offset] of [[1, 4], [2, 4], [3, 6]]) add('bar', `TU ${dpr}x ${font}px "${name}" ${thick}/${offset}`, dpr, body, name, `<span style="${underline(thick, offset)}">${name}</span>`);
    for (const [width, pad] of [[1, 2], [2, 3], [2, 6]]) add('bar', `BB ${dpr}x ${font}px "${name}" ${width}/${pad}`, dpr, body, `<span style="${border(width, pad, 'transparent')}">${name}</span>`, `<span style="${border(width, pad, '#111827')}">${name}</span>`);
    add('bar', `2L ${dpr}x ${font}px "${name}"`, dpr, body, `${name}<br>${hidden('OKAFOR-RIVERA')}`, `${name}<br>OKAFOR-RIVERA`);
  }
  for (const dpr of [1, 2, 3]) for (const name of ['LI', 'LEE', 'ELLA', 'TILL', 'FELL', 'LILLE', 'ELLIE', 'TITLE', 'LYTLE', 'JEFF', '1717', '7777', '2222', '4444', '1111', '0000', 'Li', 'Lee', 'Tell', 'Jeff', 'TAYLOR', 'SMITH', 'JONES']) {
    const body = at('font-size:14px;line-height:20px');
    add('bar', `2L ${dpr}x 14px "${name}" wrapped`, dpr, body, `${name}<br>${hidden('OKAFOR-RIVERA')}`, `${name}<br>OKAFOR-RIVERA`);
    add('bar', `BB ${dpr}x 14px "${name}" 2/3`, dpr, body, `<span style="${border(2, 3, 'transparent')}">${name}</span>`, `<span style="${border(2, 3, '#111827')}">${name}</span>`);
  }
  for (const dpr of [2, 3]) for (const font of [12, 14, 16]) for (const name of ['Li', 'Liu', 'Lin', 'Lui', 'Eli', 'Ed', 'Tia', 'Ty', 'Zoe', 'Li Wei']) {
    const body = at(`font-size:${font}px;line-height:${font + 6}px`);
    add('bar', `2L ${dpr}x ${font}px "${name}"`, dpr, body, `${name}<br>${hidden('Okafor')}`, `${name}<br>Okafor`);
    add('bar', `TU ${dpr}x ${font}px "${name}" 2/4`, dpr, body, name, `<span style="${underline(2, 4)}">${name}</span>`);
    add('bar', `BB ${dpr}x ${font}px "${name}" 1/3`, dpr, body, `<span style="${border(1, 3, 'transparent')}">${name}</span>`, `<span style="${border(1, 3, '#111827')}">${name}</span>`);
  }

  for (const dpr of [1, 2, 3]) {
    const body = at('font-size:14px;line-height:20px');
    add('wrap', `long second line ${dpr}x`, dpr, body, `Sam<br>${hidden('Rivera-Okafor-Delacroix-Montgomery')}`, 'Sam<br>Rivera-Okafor-Delacroix-Montgomery');
    add('wrap', `long second line of words ${dpr}x`, dpr, body, `Samantha<br>${hidden('Rivera Okafor Delacroix Montgomery')}`, 'Samantha<br>Rivera Okafor Delacroix Montgomery');
    add('wrap', `second line a word longer ${dpr}x`, dpr, body, `Sam<br>${hidden('Rivera Okafor')}`, 'Sam<br>Rivera Okafor');
    add('wrap', `three words, box on the first ${dpr}x`, dpr, body, `Jo ${hidden('Li Smith')}`, 'Jo Li Smith');
    const sentence = (width, prefix) => (inner) => `<div style="position:absolute;left:60px;top:50px;width:${width}px;font-size:14px;line-height:20px">${prefix} <span class=vv>${inner}</span></div>`;
    for (const tail of ['Rivera Okafor', 'Rivera-Okafor', 'Okafor']) add('wrap', `wraps to the left edge, "${tail}" ${dpr}x`, dpr, sentence(150, 'Assigned to'), `Samantha ${hidden(tail)}`, `Samantha ${tail}`);
    for (const tail of ['Rivera Okafor', 'Okafor']) add('wrap', `after a label, wraps to the left edge, "${tail}" ${dpr}x`, dpr, sentence(170, 'Reviewer:&emsp;&emsp;'), `Samantha ${hidden(tail)}`, `Samantha ${tail}`);
    for (const [one, two] of [['Samantha', 'Rivera-Okafor'], ['Sam', 'Rivera Okafor'], ['Jo', 'Montgomery']]) {
      const right = (inner) => `<div style="position:absolute;left:30px;top:40px;width:400px;font-size:14px;line-height:20px;color:#6b7280">Reviewer</div><div style="position:absolute;left:250px;top:40px;width:150px;text-align:right;font-size:14px;line-height:20px"><span class=vv>${inner}</span></div>`;
      add('wrap', `right-aligned, box on line 1 "${one}" ${dpr}x`, dpr, right, `${one}<br>${hidden(two)}`, `${one}<br>${two}`);
      add('wrap', `right-aligned, box on line 2 "${two}" ${dpr}x`, dpr, right, `${hidden(one)}<br>${two}`, `${one}<br>${two}`);
    }
    // A value wrapped onto three or four lines, the box on one of them.
    for (const font of [12, 14, 16]) for (const spacing of [1.2, 1.4, 1.5, 1.6, 1.8]) {
      const lines = (css) => at(`font-size:${font}px;line-height:${Math.round(font * spacing)}px;width:200px;${css}`);
      const texts = font === 14 ? [['Samantha', 'Rivera-Okafor', 'Delacroix'], ['Jo', 'Montgomery-Okafor', 'Li'], ['sam', 'rivera', 'okafor'], ['Samantha', 'Rivera-Okafor', 'Delacroix', 'Smith']] : [['Samantha', 'Rivera-Okafor', 'Delacroix'], ['Jo', 'Montgomery-Okafor', 'Li'], ['sam', 'rivera', 'okafor']];
      for (const [t, words] of texts.entries()) for (const align of font === 14 ? ['left', 'right', 'center'] : ['left']) for (const boxed of words.keys()) {
        add('lines', `${words.length} lines ${dpr}x ${font}px ${spacing} t${t} ${align}, box on line ${boxed + 1}`, dpr, lines(`text-align:${align}`), words.map((w, i) => (i === boxed ? w : hidden(w))).join('<br>'), words.join('<br>'));
      }
    }
    for (const spacing of [1.2, 1.4, 1.5, 1.6, 1.8]) {
      const words = ['Samantha', 'Rivera Okafor', 'Delacroix Smith'];
      for (const boxed of words.keys()) add('lines', `wrapped in a narrow column ${dpr}x ${spacing}, box on part ${boxed + 1}`, dpr, at(`font-size:14px;line-height:${Math.round(14 * spacing)}px;width:110px`), words.map((w, i) => (i === boxed ? w : hidden(w))).join(' '), words.join(' '));
    }
    // An address whose last line sits past a margin, the box on its first two lines.
    for (const margin of [10, 14, 18, 24, 32]) {
      const address = (inner) => `<div style="position:absolute;left:60px;top:20px;line-height:20px;color:#6b7280">Ship to</div><div class=vv style="position:absolute;left:60px;top:40px;line-height:20px">${inner}</div>`;
      add('gap', `address, last line ${margin} CSS px on ${dpr}x`, dpr, address, `14 Larkspur Lane<br>Apartment 3B<div style="margin-top:${margin}px">${hidden('Springfield 62704')}</div>`, `14 Larkspur Lane<br>Apartment 3B<div style="margin-top:${margin}px">Springfield 62704</div>`);
    }
    for (const space of [6, 8, 10, 11, 12, 13, 14]) add('reach', `a word ${space} CSS px past the box ${dpr}x`, dpr, body, `Samantha<span style="margin-left:${space}px">${hidden('Rivera')}</span>`, `Samantha<span style="margin-left:${space}px">Rivera</span>`);
    // A box drawn just off the address, holding no ink of its own: above its first line, in the gap before its last
    // line, or beside it (`place`, read against the ink box of the first two lines).
    for (const gap of [24, 40]) for (const kind of ['aboveTight', 'above', 'inGap', 'left']) {
      const address = (inner) => `<div style="position:absolute;left:80px;top:20px;line-height:20px;color:#6b7280">Ship to</div><div class=vv style="position:absolute;left:80px;top:80px;line-height:20px">${inner}</div><div style="position:absolute;left:80px;top:${184 + gap}px;line-height:20px;color:#6b7280">Delivery pending</div>`;
      const lines = (last) => `14 Larkspur Lane<br>Apartment 3B<div style="margin-top:${gap}px">${last}</div>`;
      cases.push({ set: 'off', name: `box ${kind} the address, last line ${gap} CSS px on ${dpr}x`, dpr, cell: [500, 300], masked: true, place: { kind, gap }, measure: address(lines(hidden('Springfield 62704'))), shown: address(lines('Springfield 62704')) });
    }
    // A value that starts mid-line, after a text indent or a label set far off, and wraps to its container's left
    // edge: the second line lies wholly left of the first line's columns, a lead or two below it.
    for (const spacing of [20, 30, 40, 54]) for (const [lead, pre, indent] of [['indent', '', 'text-indent:90px;'], ['far label', 'Owner:&emsp;&emsp;&emsp;&emsp;', '']]) for (const tail of ['Okafor', 'Rivera Okafor']) {
      const column = (inner) => `<div style="position:absolute;left:60px;top:40px;width:170px;font-size:14px;line-height:${spacing}px;${indent}">${pre}<span class=vv>${inner}</span></div>`;
      add('wrapleft', `${lead}, "${tail}" wraps left, ${spacing} px lines, box on line 1 ${dpr}x`, dpr, column, `Samantha ${hidden(tail)}`, `Samantha ${tail}`);
      add('wrapleft', `${lead}, "${tail}" wraps left, ${spacing} px lines, box on line 2 ${dpr}x`, dpr, column, `${hidden('Samantha')} ${tail}`, `Samantha ${tail}`);
    }
    // Text that runs right to left, indented from the right or after a label, wrapping to the column's right edge.
    for (const [lead, pre, indent] of [['indent', '', 'text-indent:90px;'], ['label', 'Owner:&emsp;&emsp;&emsp;&emsp;', '']]) {
      const column = (inner) => `<div dir=rtl style="position:absolute;left:60px;top:40px;width:170px;font-size:14px;line-height:22px;${indent}">${pre}<span class=vv>${inner}</span></div>`;
      add('rtl', `${lead}, wraps right, box on line 1 ${dpr}x`, dpr, column, `Samantha ${hidden('Okafor')}`, 'Samantha Okafor');
      add('rtl', `${lead}, wraps right, box on line 2 ${dpr}x`, dpr, column, `${hidden('Samantha')} Okafor`, 'Samantha Okafor');
    }
    // A definition grid whose redacted row has a two-line label beside a two-line value, with and without a row gap.
    for (const row of [0, 2]) for (const gap of [0, 6]) for (const boxed of [1, 2]) {
      const labels = ['Reviewer', 'Status', 'Priority', 'Due'].map((l, i) => (i === row ? 'Second reviewer' : l));
      const values = ['', 'In review', 'High', 'Friday'];
      const cell = (inner) => `<div style="position:absolute;left:30px;top:20px;display:grid;grid-template-columns:90px 120px;row-gap:${gap}px;column-gap:16px;line-height:20px;font-size:14px">${labels.map((l, i) => `<div style="color:#6b7280">${l}</div><div>${i === row ? `<span class=vv>${inner}</span>` : values[i]}</div>`).join('')}</div>`;
      add('grid', `two-line label, row ${row + 1}, gap ${gap}, box on line ${boxed} ${dpr}x`, dpr, cell, boxed === 1 ? `Samantha ${hidden('Rivera-Okafor')}` : `${hidden('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
    }
    // Icon-led lists at line-heights 16 to 32: the value one row of them, with the other rows and the heading
    // spared as rows of its list, and every way a value's own wrapped line could pass for one: wrapped under the
    // text column, wrapped to the container's edge under an inline icon, wrapped onto a line led by a bullet or
    // an emoji, boxed on a second line that an inline icon leads, a second value in the next row, a grid of
    // icon-sized labels, text that runs right to left, faint text, and an underlined link.
    for (const lh of [16, 20, 24, 28, 32]) {
      const icon = (inline = false) => `<svg width="16" height="16" viewBox="0 0 16 16" style="${inline ? 'vertical-align:-3px;margin-right:8px' : `flex:none;margin-top:${Math.max(0, (lh - 16) / 2)}px`}"><path d="M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5z" fill="currentColor"/></svg>`;
      const item = (inner, width = 220) => `<div style="display:flex;gap:8px;line-height:${lh}px;margin-top:4px;width:${width + 24}px">${icon()}<span style="width:${width}px">${inner}</span></div>`;
      // The heading stands `gap` CSS px over the first row, against the 4 between rows.
      const list = (own, { dir = 'ltr', colour = '#111827', gap = 16, rows = ['Shared with the team', 'Plan is current'] } = {}) => (inner) => `<div dir=${dir} style="position:absolute;left:40px;top:12px;width:300px;font-size:14px;color:${colour}"><div style="line-height:${lh}px;margin-bottom:${gap}px">A summary of this report is not ready</div>${own(inner)}${rows.map((text) => item(text)).join('')}</div>`;
      const own = (inner, width) => `<span class=vv style="display:contents">${item(inner, width)}</span>`;
      const listCase = (name, scene, measure, shown) => cases.push({ set: 'list', name: `${name}, ${lh} px lines ${dpr}x`, dpr, cell: [500, 200], masked: true, measure: scene(measure), shown: scene(shown) });
      listCase('one row of an icon-led list', list(own), 'Reported by Samantha', 'Reported by Samantha');
      listCase('one row of an icon-led list under a heading with a small gap', list(own, { gap: 6 }), 'Reported by Samantha', 'Reported by Samantha');
      listCase('the value wraps under its text column', list((inner) => own(inner, 90)), `Reported by ${hidden('Samantha Rivera-Okafor')}`, 'Reported by Samantha Rivera-Okafor');
      listCase('the next row is a second value', list((inner) => `<span class=vv style="display:contents">${item('Reported by Samantha')}${inner}</span>`), hidden(item('Second reviewer Li')), item('Second reviewer Li'));
      const inline = (inner, width = 120) => `<div style="line-height:${lh}px;margin-top:4px;width:${width}px"><span class=vv>${icon(true)}${inner}</span></div>`;
      listCase('wrapped to the edge under an inline icon', list(inline), `Reported by ${hidden('Samantha Rivera')}`, 'Reported by Samantha Rivera');
      listCase('the wrapped line starts with a bullet', list(inline), `Samantha Rivera ${hidden('&bull; Okafor')}`, 'Samantha Rivera &bull; Okafor');
      listCase('the wrapped line starts with an emoji', list(inline), `Samantha Rivera ${hidden('&#x1F3E0; Okafor')}`, 'Samantha Rivera &#x1F3E0; Okafor');
      listCase('boxed on a second line an inline icon leads', list((inner) => `<div style="line-height:${lh}px;margin-top:4px;width:200px"><span class=vv>${inner}</span></div>`), `${hidden('Reported by')}<br>${icon(true)}Samantha Rivera`, `Reported by<br>${icon(true)}Samantha Rivera`);
      listCase('text that runs right to left', list(own, { dir: 'rtl' }), 'Reported by Samantha', 'Reported by Samantha');
      listCase('right to left, the value wraps under its text column', list((inner) => own(inner, 90), { dir: 'rtl' }), `Reported by ${hidden('Samantha Rivera-Okafor')}`, 'Reported by Samantha Rivera-Okafor');
      listCase('faint text and icons', list((inner) => own(inner, 90), { colour: '#e6e8eb' }), `Reported by ${hidden('Samantha Rivera-Okafor')}`, 'Reported by Samantha Rivera-Okafor');
      listCase('an underlined link wraps', list((inner) => own(`<u style="text-decoration-thickness:2px;text-underline-offset:4px">${inner}</u>`, 90)), `Reported by ${hidden('Samantha Rivera-Okafor')}`, 'Reported by Samantha Rivera-Okafor');
      const grid = (labels, values) => (inner) => `<div class=vv style="position:absolute;left:40px;top:20px;display:grid;grid-template-columns:40px 110px;column-gap:8px;row-gap:4px;line-height:${lh}px;font-size:14px">${labels.map((l, i) => `<div style="color:#6b7280">${i ? l : inner.label}</div><div>${i ? values[i] : inner.value}</div>`).join('')}</div>`;
      listCase('a grid of icon-sized labels', grid(['ID', 'No.', 'At'], ['', '4471', 'Friday']), { label: 'ID', value: 'Samantha' }, { label: 'ID', value: 'Samantha' });
      listCase('a two-line icon-sized label beside a two-line value', grid(['ID no', 'At'], ['', 'Friday']), { label: `ID ${hidden('no')}`, value: `Samantha ${hidden('Rivera-Okafor')}` }, { label: 'ID no', value: 'Samantha Rivera-Okafor' });
    }
  }
  return cases;
}

// Cells drawn many to a page and cut apart: 400 by 120 CSS px with the value at 60, 40 for the first sets, 500 by
// 160 for the hard ones. A case may take fewer `rows` to a page, so a tall cell keeps the page small enough to decode.
const COLUMNS = 6;
const ROWS = 8;
const HIDE = '.hide .vv,.hide .vv *{color:transparent!important;text-decoration-color:transparent!important;border-color:transparent!important}';
// A case marked `glyphs` counts only its value's glyphs as the value: its decorations stay in the hidden draw.
const HIDE_GLYPHS = '.glyphs .vv,.glyphs .vv *{color:transparent!important}';
const sheet = (cell, bodies, hide) => `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#fff;${FONT}}
.c{position:absolute;width:${cell[0]}px;height:${cell[1]}px;overflow:hidden}.v{position:absolute;left:60px;top:40px;line-height:20px}${HIDE}${HIDE_GLYPHS}</style>
${bodies.map((body, i) => `<div class="c${hide ? ` ${hide[i]}` : ''}" style="left:${(i % COLUMNS) * cell[0]}px;top:${Math.floor(i / COLUMNS) * cell[1]}px">${body}</div>`).join('')}`;
const asBody = ({ style, text }) => `<span class=v style="${style}">${text}</span>`;

// For every case: the pixels of its value its fill leaves bare, under `fill` (importFill) and under the 1x pad alone
// (fillRect); whether the fill holds all of the pad's; and what the board would say: grown, capped, refused, and
// `whys` the reasons it is refused for.
export async function runFillProbes({ browser, geometrySource, cases = fillProbeCases() }) {
  const decoder = await browser.newPage();
  await decoder.addScriptTag({ content: geometrySource });
  const results = [];
  const normal = cases.map((c) => (c.cell ? c : { ...c, cell: [400, 120], measure: asBody(c.measure), shown: asBody(c.shown) }));
  try {
    const groupOf = (c) => `${c.dpr} ${c.cell} ${Boolean(c.masked)} ${c.rows ?? ROWS}`;
    for (const key of [...new Set(normal.map(groupOf))]) {
      const group = normal.filter((c) => groupOf(c) === key);
      const { dpr, cell, masked, rows = ROWS } = group[0];
      const page = await browser.newPage({ viewport: { width: cell[0] * COLUMNS, height: cell[1] * rows }, deviceScaleFactor: dpr });
      for (let from = 0; from < group.length; from += COLUMNS * rows) {
        const batch = group.slice(from, from + COLUMNS * rows);
        const shots = [];
        for (const [part, hide] of [['measure', null], ['shown', null], ...(masked ? [['shown', batch.map((c) => (c.glyphs ? 'glyphs' : 'hide'))]] : [])]) {
          await page.setContent(sheet(cell, batch.map((c) => c[part]), hide));
          shots.push((await screenshot(page, { type: 'png' })).toString('base64'));
        }
        const found = await decoder.evaluate(async ({ shots, adjusts, places, blanksOf, dpr, cell, columns }) => {
          const decode = async (b64) => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
            const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
            const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0);
            return (i) => {
              const d = ctx.getImageData((i % columns) * cell[0] * dpr, Math.floor(i / columns) * cell[1] * dpr, cell[0] * dpr, cell[1] * dpr);
              return { data: d.data, width: d.width, height: d.height };
            };
          };
          const apart = (p, q, x, y) => { const a = (y * p.width + x) * 4; return [0, 1, 2].some((c) => Math.abs(p.data[a + c] - (q ? q.data[a + c] : 255)) > 8); };
          const inside = (x, y, [rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;
          const g = globalThis.__composeGeometry;
          const [measured, shown, bare] = await Promise.all(shots.map(decode));
          return adjusts.map((adjust, i) => {
            const m = measured(i); const px = shown(i); const hiddenPx = bare ? bare(i) : null;
            let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
            for (let y = 0; y < m.height; y += 1) for (let x = 0; x < m.width; x += 1) if (apart(m, hiddenPx, x, y)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
            const ink = [x0 + adjust[0], y0 + adjust[1], x1 + 1 + adjust[2] - x0 - adjust[0], y1 + 1 + adjust[3] - y0 - adjust[1]];
            // A box placed off the ink: its bottom 6 CSS px above the ink, 10 CSS px tall (aboveTight) or 20 (above),
            // in the gap before the last line, or 2 CSS px to the left of it.
            const place = places[i]; const [bx, by, bw, bh] = ink; const d = dpr;
            const box = !place ? ink
              : place.kind === 'aboveTight' ? [bx, by - 16 * d, bw, 10 * d]
                : place.kind === 'above' ? [bx, by - 26 * d, bw, 20 * d]
                  : place.kind === 'inGap' ? [bx, by + bh + 3 * d, bw, (place.gap - 4) * d]
                    : [bx - 42 * d, by, 40 * d, bh];
            // A case's `blanks` are empty slots drawn by eye, in CSS px of the cell, snapped as page-layout snaps them.
            const blanks = (blanksOf[i] ?? []).map((b) => g.snapSlot(px, b.map((v) => v * dpr), { keep: [] }));
            const fill = g.importFill(px, box, { pad: 12, back: 2, blanks });
            const pad = [...g.fillRect(px, box, { reach: 12, back: 2 })];
            // The fill is the union of its rects; the gate's crop reaches `peek`.
            let left = 0; let padBare = 0; let unseen = 0;
            for (let y = 0; y < px.height; y += 1) for (let x = 0; x < px.width; x += 1) {
              if (!apart(px, hiddenPx, x, y)) continue;
              if (!fill.rects.some((rect) => inside(x, y, rect))) { left += 1; if (!inside(x, y, fill.peek)) unseen += 1; }
              if (!inside(x, y, pad)) padBare += 1;
            }
            const holds = fill.rects.some(([fx, fy, fw, fh]) => fx <= pad[0] && fy <= pad[1] && fx + fw >= pad[0] + pad[2] && fy + fh >= pad[1] + pad[3]);
            return { box, rect: [...fill.rect], rects: fill.rects.map((rect) => [...rect]), bare: left, unseen, padBare, holds, grew: fill.grew, capped: fill.capped.length, extended: fill.extended.length, spared: fill.spared.length, near: fill.near.length, refused: fill.capped.some((c) => c.refuse), whys: fill.capped.filter((c) => c.refuse).map((c) => c.why) };
          });
        }, { shots, adjusts: batch.map((c) => c.adjust ?? [0, 0, 0, 0]), places: batch.map((c) => c.place ?? null), blanksOf: batch.map((c) => c.blanks ?? null), dpr, cell, columns: COLUMNS });
        batch.forEach((c, i) => results.push({ set: c.set, name: c.name, ...found[i] }));
      }
      await page.close();
    }
  } finally { await decoder.close(); }
  return results;
}
