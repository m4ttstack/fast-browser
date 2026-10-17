// The reviewers' attack sets on an imported redaction fill, kept under the names they were found by. Every value in
// them is invented.
//
// `fillAttackCases` feeds runFillProbes (fill-probes.mjs): each case is a cell drawn three times, with only the part
// of the value its box covers (the measure), whole (shown), and with the value hidden. `boardAttackScenes` are whole
// pages imported and composed into a board, read back from the board the engine draws (runBoardScene).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { compose } from '../../../lib/commands/compose.mjs';
import { renderBoard } from '../../../lib/compose/engine.mjs';
import { resolvePaths } from '../../../lib/core/paths.mjs';

const T = (t) => `<span style="color:transparent;text-decoration-color:transparent;border-color:transparent">${t}</span>`;
const TG = (t) => `<span style="color:transparent">${t}</span>`;
const UNDER = (thick, offset) => `text-decoration:underline;text-decoration-thickness:${thick}px;text-underline-offset:${offset}px`;
const BORDER = (width, pad, colour) => `display:inline-block;padding-bottom:${pad}px;border-bottom:${width}px solid ${colour}`;

// Sets A3x to Hcaps, drawn on a white ground in a 520 by 260 cell. The value hides with its decorations and borders.
function groundSets(cases) {
  const add = (set, name, dpr, measure, shown, adjust) => cases.push({ set, name, dpr, cell: [520, 260], rows: 4, masked: true, measure, shown, adjust });
  const one = (set, name, dpr, css, measure, shown, adjust) => {
    const body = (inner) => `<div class=vv style="position:absolute;left:60px;top:50px;${css}">${inner}</div>`;
    add(set, name, dpr, body(measure), body(shown), adjust);
  };
  const bordered = (name, width, pad, colour) => `<span style="${BORDER(width, pad, colour)}">${name}</span>`;

  for (const font of [10, 12, 14]) {
    const base = `font-size:${font}px;line-height:${font + 6}px;`;
    for (const name of ['Sam Rivera', 'mean']) {
      for (const [thick, offset] of [[1, 3], [2, 4], [3, 6], [4, 8]]) one('A3x', `TU 3x ${font}px ${name} ${thick}/${offset}`, 3, base, `<span>${name}</span>`, `<span style="${UNDER(thick, offset)}">${name}</span>`);
      for (const [width, pad] of [[1, 2], [2, 4], [3, 6], [4, 6]]) one('A3x', `BB 3x ${font}px ${name} ${width}/${pad}`, 3, base, bordered(name, width, pad, 'transparent'), bordered(name, width, pad, '#111827'));
    }
    for (const lead of [0, 6, 12]) one('A3x', `2L 3x ${font}px +${lead}`, 3, `font-size:${font}px;line-height:${font + lead}px`, `Samantha<br>${T('Rivera-Okafor')}`, 'Samantha<br>Rivera-Okafor');
  }

  for (const dpr of [1, 2, 3]) for (const adjust of [[-20, 0, 20, 0], [-6, -6, 6, 6], [0, 0, 40, 0], [-30, -10, 30, 10]]) {
    one('Bwide', `wide ${dpr}x adj ${adjust} + 2px underline off 6`, dpr, 'font-size:14px;line-height:20px', 'Sam Rivera', `<span style="${UNDER(2, 6)}">Sam Rivera</span>`, adjust);
    one('Bwide', `wide ${dpr}x adj ${adjust} + wrapped line`, dpr, 'font-size:14px;line-height:22px', `Samantha<br>${T('Rivera-Okafor')}`, 'Samantha<br>Rivera-Okafor', adjust);
  }

  for (const dpr of [1, 2, 3]) {
    one('Cwrap', `long 2nd line no spaces ${dpr}x`, dpr, 'font-size:14px;line-height:20px', `Sam<br>${T('Rivera-Okafor-Delacroix-Montgomery')}`, 'Sam<br>Rivera-Okafor-Delacroix-Montgomery');
    one('Cwrap', `long 2nd line with spaces ${dpr}x`, dpr, 'font-size:14px;line-height:20px', `Samantha<br>${T('Rivera Okafor Delacroix Montgomery')}`, 'Samantha<br>Rivera Okafor Delacroix Montgomery');
    one('Cwrap', `2nd line extends 1 word right ${dpr}x`, dpr, 'font-size:14px;line-height:20px', `Sam<br>${T('Rivera Okafor')}`, 'Sam<br>Rivera Okafor');
    const inline = (inner) => `<div style="position:absolute;left:60px;top:50px;width:190px;font-size:14px;line-height:20px">Assigned to the reviewer <span class=vv>${inner}</span></div>`;
    add('Cwrap', `inline value wraps to left, box on line-1 part ${dpr}x`, dpr, inline(`Samantha ${T('Rivera Okafor')}`), inline('Samantha Rivera Okafor'));
    add('Cwrap', `inline value wraps to left (no-space tail), box on line-1 part ${dpr}x`, dpr, inline(`Samantha ${T('Rivera-Okafor')}`), inline('Samantha Rivera-Okafor'));
    one('Cwrap', `3 words, box on first ${dpr}x`, dpr, 'font-size:14px;line-height:20px', `Jo ${T('Li Smith')}`, 'Jo Li Smith');
  }

  for (const dpr of [1, 2, 3]) {
    const cell = 'border:1px solid #9ca3af;padding:4px 8px';
    const table = (inner) => `<table style="position:absolute;left:40px;top:30px;border-collapse:collapse;font-size:14px"><tr><td style="${cell}">Owner</td><td style="${cell};width:110px"><span class=vv>${inner}</span></td><td style="${cell}">Open</td></tr><tr><td style="${cell}">Due</td><td style="${cell}">Friday</td><td style="${cell}">-</td></tr></table>`;
    add('Dtable', `cell, tight ${dpr}x`, dpr, table('Sam Rivera'), table('Sam Rivera'));
    add('Dtable', `cell, box on first word ${dpr}x`, dpr, table(`Sam ${T('Rivera')}`), table('Sam Rivera'));
    add('Dtable', `cell, wrapped value, box on line 1 ${dpr}x`, dpr, table(`Samantha ${T('Rivera-Okafor')}`), table('Samantha Rivera-Okafor'));
    const link = '<u style="text-decoration-thickness:2px;text-underline-offset:4px">Sam Rivera</u>';
    add('Dtable', `cell, underlined link 2px off 4 ${dpr}x`, dpr, table('Sam Rivera'), table(link));
  }

  for (const dpr of [1, 2, 3]) for (const [bg, fg] of [['#dbeafe', '#1e3a8a'], ['#1d4ed8', '#ffffff'], ['#fde68a', '#111827']]) {
    const chip = (inner) => `<span style="position:absolute;left:60px;top:50px;background:${bg};color:${fg};border-radius:10px;padding:2px 10px;font-size:13px;line-height:18px"><span class=vv>${inner}</span></span>`;
    add('Echip', `chip ${bg} tight ${dpr}x`, dpr, chip('Sam Rivera'), chip('Sam Rivera'));
    add('Echip', `chip ${bg} box on first word ${dpr}x`, dpr, chip(`Sam ${T('Rivera-Okafor')}`), chip('Sam Rivera-Okafor'));
    add('Echip', `chip ${bg} box on first word, 2 more words ${dpr}x`, dpr, chip(`Sam ${T('Li Rivera')}`), chip('Sam Li Rivera'));
  }

  for (const dpr of [1, 2, 3]) for (const gap of [4, 8, 12]) {
    const avatar = (inner) => `<div style="position:absolute;left:40px;top:40px;display:flex;align-items:center;gap:${gap}px"><span style="width:32px;height:32px;border-radius:16px;background:#7c3aed;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px">SR</span><div><div class=vv style="font-size:14px;line-height:18px">${inner}</div><div style="font-size:12px;color:#6b7280;line-height:16px">Reviewer</div></div></div>`;
    add('Favatar', `avatar gap ${gap} tight ${dpr}x`, dpr, avatar('Samantha Rivera'), avatar('Samantha Rivera'));
    add('Favatar', `avatar gap ${gap} box short 1 word ${dpr}x`, dpr, avatar(`Samantha ${T('Rivera')}`), avatar('Samantha Rivera'));
    add('Favatar', `avatar gap ${gap} box short on left ${dpr}x`, dpr, avatar(`${T('Samantha')} Rivera`), avatar('Samantha Rivera'));
  }

  for (const dpr of [2, 3]) for (const font of [12, 14]) {
    const base = `font-size:${font}px;line-height:${font + 8}px;`;
    for (const name of ['jeremy gray', 'Peggy Quigley']) {
      one('Gdensity', `underline-in-box + trailing word ${dpr}x ${font}px ${name}`, dpr, base, `<u>${name}</u> ${T('Montgomery')}`, `<u>${name}</u> <u>Montgomery</u>`);
      one('Gdensity', `underline-in-box + wrapped line ${dpr}x ${font}px ${name}`, dpr, base, `<u>${name}</u><br>${T('<u>Montgomery-Okafor</u>')}`, `<u>${name}</u><br><u>Montgomery-Okafor</u>`);
      one('Gdensity', `underline-in-box + border 2/6 ${dpr}x ${font}px ${name}`, dpr, base, bordered(`<u>${name}</u>`, 2, 6, 'transparent'), bordered(`<u>${name}</u>`, 2, 6, '#111827'));
    }
    for (const name of ['TTTT TYTT', '7717 7177', 'TATE']) {
      one('Gdensity', `bar-heavy "${name}" + border 2/6 ${dpr}x ${font}px`, dpr, base, bordered(name, 2, 6, 'transparent'), bordered(name, 2, 6, '#111827'));
      one('Gdensity', `bar-heavy "${name}" + trailing word ${dpr}x ${font}px`, dpr, base, `${name} ${T('Montgomery')}`, `${name} Montgomery`);
      one('Gdensity', `bar-heavy "${name}" + underline 2/6 ${dpr}x ${font}px`, dpr, base, name, `<span style="${UNDER(2, 6)}">${name}</span>`);
    }
    one('Gdensity', `10px text 3x border 2/6 ${dpr}x`, dpr, 'font-size:10px;line-height:16px', bordered('sam rivera', 2, 6, 'transparent'), bordered('sam rivera', 2, 6, '#111827'));
    one('Gdensity', `9px text border 2/5 ${dpr}x`, dpr, 'font-size:9px;line-height:14px', bordered('sam rivera', 2, 5, 'transparent'), bordered('sam rivera', 2, 5, '#111827'));
  }

  for (const dpr of [1, 2, 3]) for (const tail of ['Rivera Okafor', 'Rivera-Okafor', 'Okafor']) {
    const wrap = (inner) => `<div style="position:absolute;left:60px;top:50px;width:150px;font-size:14px;line-height:20px">Assigned to <span class=vv>${inner}</span></div>`;
    add('C2wrapleft', `wrap to left, tail "${tail}" ${dpr}x`, dpr, wrap(`Samantha ${T(tail)}`), wrap(`Samantha ${tail}`));
  }

  for (const dpr of [1, 2, 3]) for (const font of [11, 12, 13, 14, 16]) for (const name of ['555 0147', '(717) 555-0177', '4111 1111 1111 1111', '17/11/1977', 'TYLER', 'TAYLOR SMITH', 'SAM RIVERA', 'LI', 'Jo', 'tj@tt.io', 'ZZ TOP', '7', 'FIT 7711']) {
    const base = `font-size:${font}px;line-height:${font + 8}px;`;
    one('Hdensity', `"${name}" ${dpr}x ${font}px border 2/6`, dpr, base, bordered(name, 2, 6, 'transparent'), bordered(name, 2, 6, '#111827'));
    one('Hdensity', `"${name}" ${dpr}x ${font}px + word`, dpr, base, `${name}${T('&nbsp;&nbsp;&nbsp;Okafor')}`, `${name}&nbsp;&nbsp;&nbsp;Okafor`);
  }

  for (const dpr of [1, 2, 3]) for (const tail of ['Rivera Okafor', 'Okafor']) {
    const wrap = (inner) => `<div style="position:absolute;left:60px;top:50px;width:170px;font-size:14px;line-height:20px">Reviewer:&emsp;&emsp;<span class=vv>${inner}</span></div>`;
    add('C3wrapleft', `label, 2 em spaces, value wraps to left, tail "${tail}" ${dpr}x`, dpr, wrap(`Samantha ${T(tail)}`), wrap(`Samantha ${tail}`));
  }

  for (const dpr of [2, 3]) for (const font of [12, 14, 20]) for (const name of ['LI', 'ELLIE TILL', 'TYLER', '7171', 'ZETTEL', 'Sam Rivera']) {
    const base = `font-size:${font}px;line-height:${font + 6}px;`;
    for (const [thick, offset] of [[1, 4], [2, 4], [3, 6]]) one('Ibar', `TU ${dpr}x ${font}px "${name}" ${thick}/${offset}`, dpr, base, name, `<span style="${UNDER(thick, offset)}">${name}</span>`);
    for (const [width, pad] of [[1, 2], [2, 3], [2, 6]]) one('Ibar', `BB ${dpr}x ${font}px "${name}" ${width}/${pad}`, dpr, base, bordered(name, width, pad, 'transparent'), bordered(name, width, pad, '#111827'));
    one('Ibar', `2L ${dpr}x ${font}px "${name}" / wrapped`, dpr, base, `${name}<br>${T('OKAFOR-RIVERA')}`, `${name}<br>OKAFOR-RIVERA`);
  }

  for (const dpr of [1, 2, 3]) for (const name of ['LI', 'LEE', 'ELLA', 'TILL', 'FELL', 'LILLE', 'ELLIE', 'TITLE', 'LYTLE', 'JEFF', '1717', '7777', '2222', '4444', '1111', '0000', 'Li', 'Lee', 'Tell', 'Jeff', 'TAYLOR', 'SMITH', 'JONES']) {
    const base = 'font-size:14px;line-height:20px;';
    one('Jwrap', `2L ${dpr}x 14px "${name}" / wrapped`, dpr, base, `${name}<br>${T('OKAFOR-RIVERA')}`, `${name}<br>OKAFOR-RIVERA`);
    one('Jwrap', `BB ${dpr}x 14px "${name}" 2/3`, dpr, base, bordered(name, 2, 3, 'transparent'), bordered(name, 2, 3, '#111827'));
  }

  for (const dpr of [2, 3]) for (const font of [12, 14, 16]) for (const name of ['Li', 'Liu', 'Lin', 'Lui', 'Eli', 'Ed', 'Tia', 'Ty', 'Zoe', 'Li Wei']) {
    const base = `font-size:${font}px;line-height:${font + 6}px;`;
    one('Kname', `2L ${dpr}x ${font}px "${name}"`, dpr, base, `${name}<br>${T('Okafor')}`, `${name}<br>Okafor`);
    one('Kname', `TU ${dpr}x ${font}px "${name}" 2/4`, dpr, base, name, `<span style="${UNDER(2, 4)}">${name}</span>`);
    one('Kname', `BB ${dpr}x ${font}px "${name}" 1/3`, dpr, base, bordered(name, 1, 3, 'transparent'), bordered(name, 1, 3, '#111827'));
  }

  for (const dpr of [1, 2, 3]) for (const [one1, two] of [['Samantha', 'Rivera-Okafor'], ['Sam', 'Rivera Okafor'], ['Jo', 'Montgomery']]) {
    const right = (a, b) => `<div style="position:absolute;left:30px;top:40px;width:400px;font-size:14px;line-height:20px;color:#6b7280">Reviewer</div><div style="position:absolute;left:250px;top:40px;width:150px;text-align:right;font-size:14px;line-height:20px"><span class=vv>${a}<br>${b}</span></div>`;
    add('Lright', `right-aligned wrap, box on line 1 "${one1}" ${dpr}x`, dpr, right(one1, T(two)), right(one1, two));
    add('Lright', `right-aligned wrap, box on line 2 "${two}" ${dpr}x`, dpr, right(T(one1), two), right(one1, two));
  }

  for (const dpr of [1, 2, 3]) for (const gap of [6, 8, 10, 11, 12, 13, 14]) {
    one('Mreach', `"Samantha" + ${gap}px + "Rivera" ${dpr}x`, dpr, 'font-size:14px;line-height:20px', `Samantha<span style="margin-left:${gap}px">${T('Rivera')}</span>`, `Samantha<span style="margin-left:${gap}px">Rivera</span>`);
  }

  const texts = [['Samantha', 'Rivera-Okafor', 'Delacroix'], ['Jo', 'Montgomery-Okafor', 'Li'], ['sam', 'rivera', 'okafor']];
  for (const dpr of [1, 2, 3]) for (const font of [12, 14, 16]) for (const spacing of [1.2, 1.4, 1.5, 1.6, 1.8]) for (const [t, lines] of texts.entries()) for (const boxed of [0, 1, 2]) {
    for (const align of font === 14 ? ['left', 'right', 'center'] : ['left']) {
      const css = `font-size:${font}px;line-height:${Math.round(font * spacing)}px;width:200px;text-align:${align}`;
      one('N3line', `${dpr}x ${font}px lh${spacing} t${t} ${align} box on line ${boxed + 1}`, dpr, css, lines.map((w, i) => (i === boxed ? w : T(w))).join('<br>'), lines.join('<br>'));
    }
  }
  for (const dpr of [1, 2, 3]) for (const spacing of [1.2, 1.4, 1.5, 1.6, 1.8]) for (const boxed of [0, 1, 2]) {
    const words = ['Samantha', 'Rivera Okafor', 'Delacroix Smith'];
    one('N3line', `natural wrap ${dpr}x lh${spacing} box on segment ${boxed + 1}`, dpr, `font-size:14px;line-height:${Math.round(14 * spacing)}px;width:110px`, words.map((w, i) => (i === boxed ? w : T(w))).join(' '), words.join(' '));
  }

  for (const dpr of [1, 2, 3]) for (const lh of [30, 34, 40, 46, 54]) for (const [width, tail] of [[150, 'Rivera Okafor'], [150, 'Okafor'], [150, 'Rivera-Okafor-Delacroix'], [190, 'Okafor']]) for (const align of ['left', 'right', 'center']) {
    const row = (inner) => `<div style="position:absolute;left:60px;top:30px;width:${width}px;font-size:14px;line-height:${lh}px;text-align:${align}">Assigned to <span class=vv>${inner}</span></div>`;
    add('Pleft', `${align} w${width} lh${lh} "${tail}" box line 1 ${dpr}x`, dpr, row(`Samantha ${T(tail)}`), row(`Samantha ${tail}`));
    add('Pleft', `${align} w${width} lh${lh} "${tail}" box line 2 ${dpr}x`, dpr, row(`${T('Samantha')} ${tail}`), row(`Samantha ${tail}`));
  }

  for (const dpr of [1, 2, 3]) for (const adjust of [[0.25, 0.5, -0.25, 0.75], [0.5, -0.5, 0.5, -0.25], [0.75, 0.25, -0.5, 0.5]]) for (const [shade, colour] of [['dark', '#111827'], ['light', '#c4c8ce'], ['faint', '#dfe2e6']]) {
    const css = `font-size:14px;line-height:21px;color:${colour}`;
    one('Qfrac', `3 lines ${shade} ${dpr}x adj ${adjust}`, dpr, css, `Samantha<br>${T('Rivera-Okafor<br>Delacroix')}`, 'Samantha<br>Rivera-Okafor<br>Delacroix', adjust);
    one('Qfrac', `dotted underline ${shade} ${dpr}x adj ${adjust}`, dpr, css, 'Sam Rivera', '<span style="text-decoration:underline dotted;text-decoration-thickness:2px;text-underline-offset:5px">Sam Rivera</span>', adjust);
    one('Qfrac', `border + wrap ${shade} ${dpr}x adj ${adjust}`, dpr, css, `${bordered('Samantha', 2, 5, 'transparent')}<br>${T('Okafor-Rivera')}`, `${bordered('Samantha', 2, 5, colour)}<br>Okafor-Rivera`, adjust);
  }

  for (const dpr of [1, 2, 3]) for (const lh of [30, 34, 40, 46, 54]) for (const tail of ['Rivera Okafor', 'Okafor', 'Rivera-Okafor-Delacroix']) for (const lead of ['indent', 'farlabel']) {
    const pre = lead === 'indent' ? '' : 'Owner:&emsp;&emsp;&emsp;&emsp;';
    const indent = lead === 'indent' ? 'text-indent:90px;' : '';
    const column = (inner) => `<div style="position:absolute;left:60px;top:30px;width:170px;font-size:14px;line-height:${lh}px;${indent}">${pre}<span class=vv>${inner}</span></div>`;
    add('P2left', `${lead} lh${lh} "${tail}" box line 1 ${dpr}x`, dpr, column(`Samantha ${T(tail)}`), column(`Samantha ${tail}`));
    add('P2left', `${lead} lh${lh} "${tail}" box line 2 ${dpr}x`, dpr, column(`${T('Samantha')} ${tail}`), column(`Samantha ${tail}`));
  }

  const icon = '<span style="display:inline-block;width:16px;height:16px;border-radius:8px;background:#7c3aed;vertical-align:-3px"></span>&emsp;&emsp;&emsp;';
  for (const dpr of [1, 2, 3]) for (const lh of [18, 20, 24]) for (const [lead, pre, indent] of [['indent', '', 'text-indent:90px;'], ['label3em', 'Owner:&emsp;&emsp;&emsp;', ''], ['icon', icon, '']]) {
    const column = (inner) => `<div style="position:absolute;left:60px;top:30px;width:150px;font-size:14px;line-height:${lh}px;${indent}">${pre}<span class=vv>${inner}</span></div>`;
    add('P3left', `${lead} lh${lh} box line 1 ${dpr}x`, dpr, column(`Samantha ${T('Okafor')}`), column('Samantha Okafor'));
  }

  for (const dpr of [1, 2, 3]) for (const colour of ['#e6e8eb', '#ebedf0', '#f0f1f3']) {
    const css = `font-size:14px;line-height:21px;color:${colour}`;
    one('Rfaint', `3 lines ${colour} ${dpr}x`, dpr, css, `Samantha<br>${T('Rivera-Okafor<br>Delacroix')}`, 'Samantha<br>Rivera-Okafor<br>Delacroix');
    one('Rfaint', `border+wrap ${colour} ${dpr}x`, dpr, css, `${bordered('Samantha', 2, 5, 'transparent')}<br>${T('Okafor-Rivera')}`, `${bordered('Samantha', 2, 5, colour)}<br>Okafor-Rivera`);
  }

  for (const dpr of [1, 2, 3]) for (const lh of [60, 70, 84, 100]) for (const line of [1, 2]) {
    const column = (inner) => `<div style="position:absolute;left:60px;top:20px;width:170px;font-size:14px;line-height:${lh}px;text-indent:90px"><span class=vv>${inner}</span></div>`;
    add('S1far', `indent lh${lh} box line ${line} ${dpr}x`, dpr, column(line === 1 ? `Samantha ${T('Okafor')}` : `${T('Samantha')} Okafor`), column('Samantha Okafor'));
  }
  for (const dpr of [1, 2, 3]) for (const [lang, a, b, pre] of [['latin', 'Samantha', 'Okafor', 'Owner'], ['hebrew', 'שמואל', 'אוקפור', 'בעלים']]) for (const lead of ['indent', 'label']) for (const line of [1, 2]) {
    const indent = lead === 'indent' ? 'text-indent:90px;' : '';
    const label = lead === 'label' ? `${pre}:&emsp;&emsp;&emsp;&emsp;` : '';
    const column = (inner) => `<div dir=rtl style="position:absolute;left:60px;top:30px;width:170px;font-size:14px;line-height:22px;${indent}">${label}<span class=vv>${inner}</span></div>`;
    add('S2rtl', `${lang} ${lead} box line ${line} ${dpr}x`, dpr, column(line === 1 ? `${a} ${T(b)}` : `${T(a)} ${b}`), column(`${a} ${b}`));
  }
  for (const dpr of [1, 2, 3]) for (const hang of [30, 60, 100]) for (const line of [1, 2]) {
    const column = (inner) => `<div style="position:absolute;left:60px;top:30px;width:190px;font-size:14px;line-height:20px;padding-left:${hang}px;text-indent:-${hang}px">Owner: <span class=vv>${inner}</span></div>`;
    add('S3hang', `hang${hang} box line ${line} ${dpr}x`, dpr, column(line === 1 ? `Samantha ${T('Rivera-Okafor')}` : `${T('Samantha')} Rivera-Okafor`), column('Samantha Rivera-Okafor'));
  }
  for (const dpr of [1, 2, 3]) for (const leftLh of [12, 16, 22]) for (const indent of [0, 50]) for (const line of [1, 2]) {
    const grid = (inner) => `<div style="position:absolute;left:30px;top:20px;display:grid;grid-template-columns:110px 150px;column-gap:16px;font-size:14px"><div style="line-height:${leftLh}px;color:#6b7280">Reviewer<br>Second reviewer<br>Due date<br>Priority</div><div style="line-height:24px;text-indent:${indent}px"><span class=vv>${inner}</span><br>Jordan Okafor</div></div>`;
    add('S4grid', `leftLh${leftLh} indent${indent} box line ${line} ${dpr}x`, dpr, grid(line === 1 ? `Samantha ${T('Rivera-Delacroix')}` : `${T('Samantha')} Rivera-Delacroix`), grid('Samantha Rivera-Delacroix'));
  }
  for (const dpr of [1, 2, 3]) for (const lh of [20, 30, 44]) for (const segment of [1, 2, 3]) {
    const parts = ['Samantha', 'Rivera Okafor', 'Delacroix Montgomery'];
    const column = (inner) => `<div style="position:absolute;left:60px;top:20px;width:150px;font-size:14px;line-height:${lh}px;text-indent:80px"><span class=vv>${inner}</span></div>`;
    add('S5three', `indent lh${lh} box seg ${segment} ${dpr}x`, dpr, column(parts.map((t, i) => (i === segment - 1 ? t : T(t))).join(' ')), column(parts.join(' ')));
  }

  for (const dpr of [1, 2, 3]) for (const colour of ['#f2f3f5', '#f4f5f6', '#f6f7f8']) {
    one('F1fainter', `3 lines ${colour} ${dpr}x`, dpr, `font-size:14px;line-height:21px;color:${colour}`, `Samantha<br>${T('Rivera-Okafor<br>Delacroix')}`, 'Samantha<br>Rivera-Okafor<br>Delacroix');
  }
  for (const dpr of [1, 2, 3]) for (const [ground, fill] of [['tint', '#eef2ff'], ['grey', '#f3f4f6'], ['gradient', 'linear-gradient(90deg,#ffffff,#dbeafe)'], ['dark', '#1f2937']]) for (const colour of ['#3730a3', '#c7d2fe', '#e0e7ff', '#9ca3af']) {
    const panel = (inner) => `<div style="position:absolute;left:30px;top:20px;width:400px;height:150px;background:${fill}"></div><div style="position:absolute;left:60px;top:40px;font-size:14px;line-height:21px;color:${colour}"><span class=vv>${inner}</span></div>`;
    add('F2ground', `${ground} ${colour} ${dpr}x`, dpr, panel(`Samantha<br>${T('Rivera-Okafor<br>Delacroix')}`), panel('Samantha<br>Rivera-Okafor<br>Delacroix'));
  }

  {
    const labels = ['Reviewer', 'Status', 'Priority', 'Due', 'Component', 'Labels'];
    const values = ['Samantha Rivera', 'In review', 'High', 'Friday', 'Exports', 'csv, reports'];
    const grid = ({ cols = '110px 170px', gap = 6, align = 'left', labelText = labels, row }, inner) => `<div style="position:absolute;left:30px;top:20px;display:grid;grid-template-columns:${cols};row-gap:${gap}px;column-gap:16px;line-height:20px;font-size:14px">${labelText.map((l, i) => `<div style="color:#6b7280;text-align:${align}">${l}</div><div>${i === row ? `<span class=vv>${inner}</span>` : values[i]}</div>`).join('')}</div>`;
    const G = (name, dpr, opts, measure, shown) => add('Ggrid', `${name} ${dpr}x`, dpr, grid(opts, measure), grid(opts, shown));
    for (const dpr of [1, 2, 3]) for (const row of [0, 2]) {
      for (const gap of [0, 6]) {
        G(`twoline r${row} gap${gap} box l1`, dpr, { row, gap, cols: '110px 120px' }, `Samantha ${T('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
        G(`twoline r${row} gap${gap} box l2`, dpr, { row, gap, cols: '110px 120px' }, `${T('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
        const twoLabels = labels.map((l, i) => (i === row ? 'Second reviewer' : l));
        G(`twoline+twolabel r${row} gap${gap} box l1`, dpr, { row, gap, cols: '90px 120px', labelText: twoLabels }, `Samantha ${T('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
        G(`twoline+twolabel r${row} gap${gap} box l2`, dpr, { row, gap, cols: '90px 120px', labelText: twoLabels }, `${T('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
        G(`threeline r${row} gap${gap} box l1`, dpr, { row, gap, cols: '110px 90px' }, `Samantha ${T('Rivera Okafor Delacroix')}`, 'Samantha Rivera Okafor Delacroix');
      }
      G(`rightlabels r${row}`, dpr, { row, align: 'right' }, 'Samantha Rivera', 'Samantha Rivera');
      G(`rightlabels twoline r${row} box l1`, dpr, { row, align: 'right', cols: '110px 120px' }, `Samantha ${T('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
      G(`tight r${row}`, dpr, { row, gap: 0 }, 'Samantha Rivera', 'Samantha Rivera');
    }
  }
  for (const dpr of [1, 2, 3]) for (const row of [0, 2]) for (const [tail, width] of [['Okafor', 230], ['Rivera-Okafor-Delacroix', 230], ['Rivera Okafor', 250]]) for (const line of [1, 2]) {
    const rows = ['Reviewer', 'Status', 'Priority', 'Due'];
    const values = ['', 'In review', 'High', 'Friday'];
    const list = (inner) => `<div style="position:absolute;left:30px;top:20px;width:${width}px;font-size:14px;line-height:20px">${rows.map((l, i) => `<div style="margin-bottom:6px"><span style="display:inline-block;width:110px;color:#6b7280">${l}</span>${i === row ? `<span class=vv>${inner}</span>` : values[i]}</div>`).join('')}</div>`;
    add('G2inline', `r${row} "${tail}" w${width} box l${line} ${dpr}x`, dpr, list(line === 1 ? `Samantha ${T(tail)}` : `${T('Samantha')} ${tail}`), list(`Samantha ${tail}`));
  }
  for (const dpr of [1, 2, 3]) for (const line of [1, 2]) {
    const mixed = line === 1 ? `Samantha ${T('אוקפור')}` : `${T('Samantha')} אוקפור`;
    const column = (dir) => (inner) => `<div dir=${dir} style="position:absolute;left:60px;top:30px;width:170px;font-size:14px;line-height:22px;text-indent:90px"><span class=vv>${inner}</span></div>`;
    add('G3mixed', `rtl mixed latin+hebrew box l${line} ${dpr}x`, dpr, column('rtl')(mixed), column('rtl')('Samantha אוקפור'));
    add('G3mixed', `ltr mixed latin+hebrew box l${line} ${dpr}x`, dpr, column('ltr')(mixed), column('ltr')('Samantha אוקפור'));
    const grid = (inner) => `<div dir=rtl style="position:absolute;left:30px;top:20px;display:grid;grid-template-columns:110px 120px;row-gap:6px;column-gap:16px;line-height:20px;font-size:14px"><div style="color:#6b7280">בעלים</div><div><span class=vv>${inner}</span></div><div style="color:#6b7280">מצב</div><div>פתוח</div><div style="color:#6b7280">עדיפות</div><div>גבוהה</div></div>`;
    add('G3mixed', `rtl grid twoline box l${line} ${dpr}x`, dpr, grid(line === 1 ? `שמואל ${T('אוקפור-ריברה')}` : `${T('שמואל')} אוקפור-ריברה`), grid('שמואל אוקפור-ריברה'));
    const label = (inner) => `<div dir=rtl style="position:absolute;left:60px;top:30px;width:170px;font-size:14px;line-height:22px">Owner:&emsp;&emsp;<span class=vv>${inner}</span></div>`;
    add('G3mixed', `rtl latin label box l${line} ${dpr}x`, dpr, label(line === 1 ? `Samantha ${T('Okafor-Rivera')}` : `${T('Samantha')} Okafor-Rivera`), label('Samantha Okafor-Rivera'));
  }

  {
    const base = ['Reviewer', 'Status', 'Priority', 'Due', 'Component'];
    const values = ['', 'In review', 'High', 'Friday', 'Exports'];
    const grid = ({ row, lh, vlh = lh, llh = lh, gap, labelText, cols }, inner) => `<div style="position:absolute;left:30px;top:16px;display:grid;grid-template-columns:${cols};row-gap:${gap}px;column-gap:16px;font-size:14px">${labelText.map((l, i) => `<div style="color:#6b7280;line-height:${llh}px">${l}</div><div style="line-height:${vlh}px">${i === row ? `<span class=vv>${inner}</span>` : values[i]}</div>`).join('')}</div>`;
    const H = (set, name, dpr, opts, [measure, shown]) => add(set, `${name} ${dpr}x`, dpr, grid(opts, measure), grid(opts, shown));
    const two = (line, a, b) => (line === 1 ? [`${a} ${T(b)}`, `${a} ${b}`] : [`${T(a)} ${b}`, `${a} ${b}`]);
    for (const dpr of [1, 2, 3]) for (const row of [0, 2]) for (const line of [1, 2]) {
      const twoLabel = base.map((l, i) => (i === row ? 'Second reviewer' : l));
      for (const lh of [20, 22, 23, 24, 26, 30, 36]) for (const gap of [0, 6]) {
        H('Hpitch', `twolabel lh${lh} gap${gap} r${row} l${line}`, dpr, { row, lh, gap, labelText: twoLabel, cols: '90px 120px' }, two(line, 'Samantha', 'Rivera-Okafor'));
      }
      for (const lh of [20, 24, 30]) {
        const labelText = base.map((l, i) => (i === row ? 'Assigned second reviewer' : l));
        const pair = line === 1 ? [`Samantha ${T('Rivera Okafor-Delacroix')}`, 'Samantha Rivera Okafor-Delacroix'] : [`${T('Samantha')} Rivera ${T('Okafor-Delacroix')}`, 'Samantha Rivera Okafor-Delacroix'];
        H('Hthree', `threelabel lh${lh} r${row} l${line}`, dpr, { row, lh, gap: 6, labelText, cols: '80px 110px' }, pair);
      }
      for (const [vlh, llh] of [[20, 26], [20, 32], [22, 30]]) {
        H('Hlabellh', `vlh${vlh} llh${llh} r${row} l${line}`, dpr, { row, lh: vlh, vlh, llh, gap: 6, labelText: twoLabel, cols: '90px 120px' }, two(line, 'Samantha', 'Rivera-Okafor'));
      }
      for (const vlh of [24, 28, 32, 40]) {
        H('Hvaluelh', `vlh${vlh} r${row} l${line}`, dpr, { row, lh: 20, vlh, llh: 20, gap: 6, labelText: base, cols: '90px 120px' }, two(line, 'Samantha', 'Rivera-Okafor'));
      }
      for (const [a, b] of [['samantha', 'RIVERA-OKAFOR'], ['SAMANTHA', 'rivera-okafor'], ['sam', 'RIVERA']]) for (const lh of [20, 24, 28]) {
        const labelText = base.map((l, i) => (i === row ? 'second reviewer' : l));
        H('Hcaps', `"${a}/${b}" lh${lh} r${row} l${line}`, dpr, { row, lh, gap: 6, labelText, cols: '90px 120px' }, two(line, a, b));
      }
    }
  }
}

// Sets U1link to F4border, on a light and a dark ground in a 560 by 300 cell. Only the value's glyphs are the value:
// its underline or strike, given its own colour, stays in the hidden draw.
const GROUNDS = { light: { bg: '#fff', fg: '#111827', rule: '#e5e7eb', dark: '#9ca3af' }, dark: { bg: '#111827', fg: '#e5e7eb', rule: '#374151', dark: '#6b7280' } };
function decorationSets(cases) {
  for (const dpr of [1, 2, 3]) for (const [g, c] of Object.entries(GROUNDS)) {
    const add = (set, name, page, measure, shown) => {
      const body = (inner) => `<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:${c.bg};color:${c.fg}">${page(inner)}</div>`;
      cases.push({ set, name: `${name} ${g} ${dpr}x`, dpr, cell: [560, 300], rows: 4, masked: true, glyphs: true, measure: body(measure), shown: body(shown) });
    };

    for (const width of [230, 250]) for (const style of ['solid', 'dotted', 'dashed', 'double', 'wavy']) for (const off of ['auto', '2px', '4px']) for (const th of ['1px', '2px']) for (const skip of ['auto', 'none']) {
      if (style !== 'solid' && (skip === 'none' || th === '2px')) continue;
      const deco = `text-decoration:underline ${style} ${c.fg};text-underline-offset:${off};text-decoration-thickness:${th};text-decoration-skip-ink:${skip}`;
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:${width}px;line-height:20px"><span style="${deco}">Assigned to the reviewer <span class=vv>${inner}</span></span></div>`;
      add('U1link', `w${width} ${style} off ${off} th ${th} skip ${skip} box l1`, page, `Samantha ${TG('Rivera Okafor')}`, 'Samantha Rivera Okafor');
      add('U1link', `w${width} ${style} off ${off} th ${th} skip ${skip} box l2`, page, `${TG('Samantha')} Rivera Okafor`, 'Samantha Rivera Okafor');
    }
    for (const width of [160, 180, 200, 240]) for (const off of ['auto', '3px']) for (const lh of [18, 20, 24]) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:${width}px;line-height:${lh}px">This was reported by <span class=vv style="text-decoration:underline ${c.fg};text-underline-offset:${off}">${inner}</span> on Friday</div>`;
      add('U2valuelink', `w${width} off ${off} lh${lh} box l1`, page, `Samantha ${TG('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
      add('U2valuelink', `w${width} off ${off} lh${lh} box l2`, page, `${TG('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
    }
    for (const gap of [0, 1, 2, 3, 4]) for (const name of ['Sam Rivera', 'Gregory Pyke']) {
      const ruled = (inner) => `<div style="position:absolute;left:40px;top:40px;width:420px;line-height:20px;padding-bottom:${gap}px;border-bottom:1px solid ${c.rule}">Owner <span class=vv>${inner}</span> and more</div><div style="position:absolute;left:40px;top:${66 + gap}px;line-height:20px">Next line of the page</div>`;
      add('U3under', `gap ${gap} ${name}`, ruled, name, name);
      const linked = (inner) => `<div style="position:absolute;left:40px;top:40px;line-height:20px"><u style="text-underline-offset:${gap}px;text-decoration-color:${c.fg}">Owner <span class=vv>${inner}</span> and more</u></div>`;
      add('U3under', `link off ${gap} ${name}`, linked, name, name);
    }
    for (const width of [230, 250]) for (const th of ['1px', '2px']) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:${width}px;line-height:20px"><s style="text-decoration-color:${c.fg};text-decoration-thickness:${th}">Assigned to the reviewer <span class=vv>${inner}</span></s></div>`;
      add('S1strike', `w${width} th ${th} box l1`, page, `Samantha ${TG('Rivera Okafor')}`, 'Samantha Rivera Okafor');
      add('S1strike', `w${width} th ${th} box l2`, page, `${TG('Samantha')} Rivera Okafor`, 'Samantha Rivera Okafor');
    }
    for (const h of [18, 20, 22, 24, 28]) for (const lh of [18, 20]) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:200px;height:${h}px;line-height:${lh}px;border-bottom:1px solid ${c.rule};border-radius:0"><div style="width:180px">Requested by <span class=vv>${inner}</span></div></div><div style="position:absolute;left:40px;top:40px;width:420px;height:${h}px;border-bottom:1px solid ${c.rule}"></div>`;
      add('W1overflow', `h${h} lh${lh} box l1`, page, `Samantha ${TG('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
      add('W1overflow', `h${h} lh${lh} box l2`, page, `${TG('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
    }
    for (const size of [3, 4, 5, 6]) {
      const page = (inner) => `<div class=vv style="position:absolute;left:60px;top:50px;line-height:16px">${inner}</div>`;
      const tiny = `<span style="font-size:${size}px;line-height:${size}px">Rivera-Okafor Delacroix Montgomery</span>`;
      add('T1tiny', `font ${size}`, page, `Samantha<br>${TG(tiny)}`, `Samantha<br>${tiny}`);
    }
    for (const rule of ['————————————', '____________', '────────────']) for (const lh of [14, 18, 22]) {
      const page = (inner) => `<div class=vv style="position:absolute;left:60px;top:50px;line-height:${lh}px">${inner}</div>`;
      add('T1dash', `${rule.slice(0, 1)} lh${lh} box l1`, page, `Samantha Rivera<br>${TG(rule)}<br>${TG('Okafor Delacroix')}`, `Samantha Rivera<br>${rule}<br>Okafor Delacroix`);
      add('T1dash', `${rule.slice(0, 1)} lh${lh} box l3`, page, `${TG('Samantha Rivera')}<br>${TG(rule)}<br>Okafor Delacroix`, `Samantha Rivera<br>${rule}<br>Okafor Delacroix`);
    }
    for (const p of [2, 4, 6]) for (const radius of [0, 4, 8]) {
      const input = (clip) => (inner) => `<div style="position:absolute;left:40px;top:40px;border:1px solid ${c.dark};border-radius:${radius}px;padding:${p}px ${p + 2}px;line-height:18px;width:150px${clip ? ';overflow:hidden;white-space:nowrap' : ''}"><span class=vv>${inner}</span></div>`;
      add('I1input', `p${p} r${radius} one line whole`, input(false), 'Sam Rivera', 'Sam Rivera');
      add('I1input', `p${p} r${radius} one line first word`, input(false), `Sam ${TG('Rivera')}`, 'Sam Rivera');
      add('I1input', `p${p} r${radius} wrapped box l1`, input(false), `Samantha ${TG('Rivera-Okafor Delacroix')}`, 'Samantha Rivera-Okafor Delacroix');
      add('I1input', `p${p} r${radius} wrapped box l2`, input(false), `${TG('Samantha')} Rivera-Okafor ${TG('Delacroix')}`, 'Samantha Rivera-Okafor Delacroix');
      add('I1input', `p${p} r${radius} clipped first word`, input(true), `Samantha ${TG('Rivera-Okafor Delacroix')}`, 'Samantha Rivera-Okafor Delacroix');
    }
    for (const pad of [4, 8, 12]) for (const side of ['left', 'right']) for (const lh of [18, 22]) {
      const cell = (inner) => `<td rowspan=2 style="padding:${pad}px;width:120px;vertical-align:top;line-height:${lh}px"><span class=vv>${inner}</span></td>`;
      const other = (t, last) => `<td style="padding:${pad}px;line-height:${lh}px;${last ? '' : `border-bottom:1px solid ${c.rule}`}">${t}</td>`;
      const page = (inner) => `<table style="position:absolute;left:30px;top:30px;border-collapse:collapse">${side === 'left' ? `<tr>${cell(inner)}${other('Open status', false)}${other('Due Friday', false)}</tr><tr>${other('High priority', true)}${other('Two photos', true)}</tr>` : `<tr>${other('Open status', false)}${cell(inner)}</tr><tr>${other('High priority', true)}</tr>`}</table>`;
      add('R1rowspan', `pad${pad} ${side} lh${lh} box l1`, page, `Samantha ${TG('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
      add('R1rowspan', `pad${pad} ${side} lh${lh} box l2`, page, `${TG('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
    }
    for (const pad of [2, 4, 8]) {
      const td = `padding:${pad}px 10px;border-bottom:1px solid ${c.rule}`;
      const page = (inner) => `<table style="position:absolute;left:30px;top:30px;border-collapse:collapse;line-height:18px">${[['Owner', `<span class=vv>${inner}</span>`], ['Status', 'Open'], ['Due', 'Friday']].map(([a, b]) => `<tr><td style="${td};color:${c.dark}">${a}</td><td style="${td};width:110px">${b}</td></tr>`).join('')}</table>`;
      add('R2cellwrap', `pad${pad} box l1`, page, `Samantha ${TG('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
      add('R2cellwrap', `pad${pad} box l2`, page, `${TG('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
    }
    for (const radius of [6, 12, 16]) for (const p of [6, 10]) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:200px;border:1px solid ${c.rule};border-radius:${radius}px;padding:${p}px;line-height:20px"><span class=vv>${inner}</span></div>`;
      add('C1corner', `r${radius} p${p} box l1`, page, `Samantha ${TG('Rivera-Okafor Delacroix')}`, 'Samantha Rivera-Okafor Delacroix');
      add('C1corner', `r${radius} p${p} box l2`, page, `${TG('Samantha')} Rivera-Okafor ${TG('Delacroix')}`, 'Samantha Rivera-Okafor Delacroix');
      add('C1corner', `r${radius} p${p} box first word`, page, `Samantha ${TG('Rivera-Okafor Delacroix')}`, 'Samantha Rivera-Okafor Delacroix');
    }
    for (const start of [70, 90, 110]) for (const below of [4, 6, 10]) {
      const value = (inner) => `<div style="position:absolute;left:40px;top:40px;width:200px;line-height:20px;font-size:14px"><span class=vv>${inner}</span></div>`;
      const corner = (inner) => `${value(inner)}<div style="position:absolute;left:${40 + start}px;top:${80 + below}px;width:330px;height:40px;border-top:1px solid ${c.rule};border-left:1px solid ${c.rule};border-radius:8px 0 0 0"></div>`;
      add('K1clear', `start${start} below${below} box l1`, corner, `Samantha Rivera-Okafor ${TG('Jo')}`, 'Samantha Rivera-Okafor Jo');
      const flat = (inner) => `${value(inner)}<div style="position:absolute;left:${40 + start}px;top:${80 + below}px;width:330px;border-top:1px solid ${c.rule}"></div>`;
      add('K1clear', `flat start${start} below${below} box l1`, flat, `Samantha Rivera-Okafor ${TG('Li')}`, 'Samantha Rivera-Okafor Li');
    }
    for (const p of [4, 8, 12]) {
      const side = (inner) => `<div style="position:absolute;left:40px;top:30px;width:180px;height:200px;border-left:1px solid ${c.rule};padding-left:${p}px;line-height:20px"><span class=vv>${inner}</span></div>`;
      add('V1side', `p${p} box l1`, side, `Samantha ${TG('Rivera-Okafor Delacroix Montgomery')}`, 'Samantha Rivera-Okafor Delacroix Montgomery');
      add('V1side', `p${p} box l2`, side, `${TG('Samantha')} Rivera-Okafor ${TG('Delacroix Montgomery')}`, 'Samantha Rivera-Okafor Delacroix Montgomery');
      const td = `border:1px solid ${c.rule};padding:4px ${p}px`;
      const table = (inner) => `<table style="position:absolute;left:30px;top:30px;border-collapse:collapse;line-height:18px"><tr><td style="${td}">Owner</td><td style="${td};width:100px"><span class=vv>${inner}</span></td><td style="${td}">Open</td></tr></table>`;
      add('V1side', `table p${p} first word`, table, `Samantha ${TG('Rivera-Okafor Li')}`, 'Samantha Rivera-Okafor Li');
    }
    for (const size of [28, 36, 48]) for (const weight of [100, 300]) {
      const page = (inner) => `<div style="position:absolute;left:30px;top:30px;font-size:${size}px;font-weight:${weight};line-height:1.2;white-space:nowrap"><span class=vv>${inner}</span></div>`;
      add('V2stems', `fs${size} w${weight}`, page, `Ava ${TG('Illi Lilli')}`, 'Ava Illi Lilli');
    }

    for (const off of ['auto', '1px', '2px', '3px', '4px']) for (const th of ['1px', '2px']) {
      const deco = `text-decoration:underline ${c.fg};text-underline-offset:${off};text-decoration-thickness:${th}`;
      for (const [width, a, b] of [[120, 'Samantha-Louise', 'Rivera'], [130, 'Samantha-Louise', 'Okafor'], [150, 'Alexandria-Rose', 'Li']]) {
        const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:${width}px;line-height:20px"><span class=vv style="${deco}">${inner}</span></div>`;
        add('E1valuewrap', `w${width} ${a.length}/${b.length} off ${off} th ${th} box l2`, page, `${TG(a)} ${b}`, `${a} ${b}`);
        add('E1valuewrap', `w${width} ${a.length}/${b.length} off ${off} th ${th} box l1`, page, `${a} ${TG(b)}`, `${a} ${b}`);
      }
      const email = (inner) => `<table style="position:absolute;left:30px;top:30px;border-collapse:collapse;line-height:18px"><tr><td style="padding:6px 10px;color:${c.dark}">Email</td><td style="padding:6px 10px;width:130px;word-break:break-all"><span class=vv style="${deco}">${inner}</span></td></tr></table>`;
      add('E2email', `off ${off} th ${th} box l2`, email, `${TG('samantha.rivera-oka')}fortune@example.com`, 'samantha.rivera-okafortune@example.com');
      add('E2email', `off ${off} th ${th} box l1`, email, `samantha.rivera-oka${TG('fortune@example.com')}`, 'samantha.rivera-okafortune@example.com');
      const phrase = (inner) => `<div style="position:absolute;left:40px;top:40px;width:220px;line-height:22px"><a style="${deco}">View the profile of <span class=vv>${inner}</span> here</a></div>`;
      add('E3phrase', `off ${off} th ${th} box l2`, phrase, `${TG('Samantha')} Rivera-Okafor`, 'Samantha Rivera-Okafor');
      add('E3phrase', `off ${off} th ${th} box l1`, phrase, `Samantha ${TG('Rivera-Okafor')}`, 'Samantha Rivera-Okafor');
    }

    for (const off of ['4px', '6px', '8px', '10px']) for (const lh of [20, 24, 28, 32]) {
      const deco = `text-decoration:underline ${c.fg};text-underline-offset:${off};text-decoration-skip-ink:none`;
      for (const width of [200, 240]) {
        const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:${width}px;line-height:${lh}px">Reported by <span class=vv style="${deco}">${inner}</span> today</div>`;
        add('F1midlink', `w${width} off ${off} lh${lh} box l2`, page, `${TG('Samantha-Louise')} Rivera-Okafor`, 'Samantha-Louise Rivera-Okafor');
        add('F1midlink', `w${width} off ${off} lh${lh} box l1`, page, `Samantha-Louise ${TG('Rivera-Okafor')}`, 'Samantha-Louise Rivera-Okafor');
      }
      for (const [a, b] of [['Samantha-Louise', 'Rivera'], ['Gregory-Pyke', 'Quigley']]) {
        const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:${a.length > 12 ? 120 : 100}px;line-height:${lh}px"><span class=vv style="${deco}">${inner}</span></div>`;
        add('F2startlink', `${a} off ${off} lh${lh} box l2`, page, `${TG(a)} ${b}`, `${a} ${b}`);
        add('F2startlink', `${a} off ${off} lh${lh} box l1`, page, `${a} ${TG(b)}`, `${a} ${b}`);
      }
      const phrase = (inner) => `<div style="position:absolute;left:40px;top:40px;width:230px;line-height:${lh}px"><span style="${deco}">View profile of <span class=vv>${inner}</span></span></div>`;
      add('F3phrase', `off ${off} lh${lh} box l1`, phrase, `Samantha ${TG('Rivera-Okafor-Delacroix')}`, 'Samantha Rivera-Okafor-Delacroix');
      add('F3phrase', `off ${off} lh${lh} box l2`, phrase, `${TG('Samantha')} Rivera-Okafor-Delacroix`, 'Samantha Rivera-Okafor-Delacroix');
    }
    for (const below of [4, 6, 7, 8, 10]) for (const lh of [20, 28]) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:420px;height:${lh}px;border-bottom:1px solid ${c.rule}"></div><div style="position:absolute;left:40px;top:40px;width:190px;line-height:${lh}px">Requested by <span class=vv>${inner.replace('<br>', `<br><span style="display:inline-block;margin-top:${below}px"></span>`)}</span></div>`;
      add('F4border', `below${below} lh${lh} box l1`, page, `Samantha<br>${TG('Rivera-Okafor')}`, 'Samantha<br>Rivera-Okafor');
      add('F4border', `below${below} lh${lh} box l2`, page, `${TG('Samantha')}<br>Rivera-Okafor`, 'Samantha<br>Rivera-Okafor');
    }
  }
}

// Sets EMoji to L1far, from the review of the list sparing and the slot blank, in a 640 by 300 cell on white. Only the
// value's glyphs are the value. A case's `blanks` are the empty slots drawn, in CSS px.
function listSets(cases) {
  const add = (set, name, dpr, page, vis, full, blanks) => cases.push({ set, name: `${name} ${dpr}x`, dpr, cell: [640, 300], rows: 4, masked: true, glyphs: true, measure: page(vis), shown: page(full), ...(blanks ? { blanks } : {}) });
  const svg = (sz, style) => `<svg width="${sz}" height="${sz}" viewBox="0 0 16 16" style="${style}"><path d="M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5z" fill="currentColor"/></svg>`;
  const LHS = [16, 20, 24, 28, 32];
  const rowsAfter = (lh, sz = 16, gap = 8, texts = ['Shared with the team', 'Plan is current']) => texts.map((t) => `<div style="display:flex;gap:${gap}px;line-height:${lh}px;margin-top:4px;align-items:center">${svg(sz, 'flex:none')}<span>${t}</span></div>`).join('');
  const heading = (lh) => `<div style="line-height:${lh}px;margin-bottom:16px">A summary of this report is not ready</div>`;
  const icon = (mode, sz, gap, lh) => (mode === 'inline' ? svg(sz, `vertical-align:-3px;margin-right:${gap}px`) : svg(sz, `float:left;margin-right:${gap}px;margin-top:${Math.max(0, (lh - sz) / 2)}px`));

  // EMoji: emoji-led wrapped lines under an inline or float icon, every density, icon size and gap.
  for (const dpr of [1, 2, 3]) for (const lh of LHS) for (const sz of [12, 14, 16, 18]) for (const gap of [6, 8, 10, 12]) for (const tok of ['&#x1F3E0;', '&#x1F4DE;', '&#x1F4CD;', '&#x1F4C5;', '&#x1F464;', '&#x2B50;', '&#x1F697;']) for (const mode of ['inline', 'float']) {
    const page = (inner) => `<div style="position:absolute;left:40px;top:12px;width:300px">${heading(lh)}<div style="line-height:${lh}px;margin-top:4px;width:200px"><span class=vv>${icon(mode, sz, gap, lh)}${inner}</span></div><div style="clear:both"></div>${rowsAfter(lh, sz, gap)}</div>`;
    add('EMoji', `${mode} lh${lh} sz${sz} gap${gap} "${tok}"`, dpr, page, `Reported by Samantha ${TG(`<br>${tok} Okafor Delacroix`)}`, `Reported by Samantha<br>${tok} Okafor Delacroix`);
  }
  // H1hang: a hanging-indent note whose wrapped line starts with a digit at the column where an icon-led list's icons sit below.
  for (const dpr of [1, 2, 3]) for (const lh of LHS) for (const sz of [12, 16]) for (const tok of ['42', 'Dr', 'II']) {
    const page = (inner) => `<div style="position:absolute;left:40px;top:12px;width:300px"><div style="line-height:${lh}px;width:190px;padding-left:24px;text-indent:-24px"><span class=vv>${inner}</span></div>${rowsAfter(lh, sz, 8).replace(/margin-top:4px/g, 'margin-top:4px;margin-left:24px')}</div>`;
    add('H1hang', `lh${lh} sz${sz} "${tok}" box l2`, dpr, page, `${TG('Samantha Rivera at')}<br>${tok} Okafor Delacroix`, `Samantha Rivera at<br>${tok} Okafor Delacroix`);
  }
  // E1blank: an empty mark drawn by eye over a blank tile, too tall by `over` px so it covers the value's first line.
  for (const dpr of [1, 2, 3]) for (const lh of [16, 20, 24]) for (const over of [0, 4, 8, 12, 16]) for (const gapPx of [8, 12]) {
    const tileTop = 20; const tileH = 100; const textTop = tileTop + tileH + gapPx;
    const page = (inner) => `<div style="position:absolute;left:100px;top:${tileTop}px;width:160px;height:${tileH}px;background:#eef2f7;border:1px solid #e2e6ec;border-radius:8px;box-sizing:border-box"></div><div style="position:absolute;left:100px;top:${textTop}px;width:150px;line-height:${lh}px"><span class=vv>${inner}</span></div>`;
    const blanks = [[100, tileTop, 160, tileH + over]];
    add('E1blank', `lh${lh} over${over} gap${gapPx} box l2`, dpr, page, `${TG('Samantha Rivera')}<br>Okafor Delacroix`, `Samantha Rivera<br>Okafor Delacroix`, blanks);
    add('E1blank', `lh${lh} over${over} gap${gapPx} box l1`, dpr, page, `Samantha Rivera${TG('<br>Okafor Delacroix')}`, `Samantha Rivera<br>Okafor Delacroix`, blanks);
  }
  // W2real: an address or phone wraps naturally onto a digit-led line under an inline or float icon.
  for (const dpr of [1, 2, 3]) for (const lh of LHS) for (const sz of [12, 14, 16, 18, 20]) for (const gap of [6, 8, 10]) for (const [kind, text, first] of [['addr', 'Lives at 42 Elm Street', '42'], ['phone', 'Call on 0412 555 123 today', '0412'], ['unit', 'Unit 7 Rivera Court', '7'], ['title', 'Contact Dr Rivera Okafor', 'Dr']]) {
    const [head, ...rest] = text.split(` ${first} `);
    const tail = `${first} ${rest.join('')}`;
    for (const mode of ['inline', 'float']) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:12px;width:300px">${heading(lh)}<div style="line-height:${lh}px;margin-top:4px;width:${mode === 'inline' ? 140 : 150}px"><span class=vv>${icon(mode, sz, gap, lh)}${inner}</span></div><div style="clear:both"></div>${rowsAfter(lh, sz, gap)}</div>`;
      add('W2real', `${mode} ${kind} lh${lh} sz${sz} gap${gap}`, dpr, page, `${head} ${TG(tail)}`, `${head} ${tail}`);
    }
  }
  // W3flex: a flex row whose text wraps, the next list rows below; the box on line 1 with the icon.
  for (const dpr of [1, 2, 3]) for (const lh of LHS) for (const sz of [12, 16, 20]) for (const gap of [6, 8, 10]) for (const tok of ['Mr', 'Dr', '42', 'on', 'II', '&#x1F3E0;', '&#x2611;']) {
    const page = (inner) => `<div style="position:absolute;left:40px;top:12px;width:300px">${heading(lh)}<div style="display:flex;gap:${gap}px;line-height:${lh}px;margin-top:4px;align-items:flex-start"><span class=vv style="display:contents">${svg(sz, `flex:none;margin-top:${Math.max(0, (lh - sz) / 2)}px`)}<span style="width:150px">${inner}</span></span></div>${rowsAfter(lh, sz, gap)}</div>`;
    add('W3flex', `lh${lh} sz${sz} gap${gap} "${tok}"`, dpr, page, `Reported by Samantha ${TG(`<br>${tok} Okafor Delacroix`)}`, `Reported by Samantha<br>${tok} Okafor Delacroix`);
  }
  // L1far: a value at the end of a long first line of a wide paragraph, wrapping to the far left edge.
  for (const dpr of [1, 2, 3]) for (const lh of [18, 20, 24]) for (const w of [260, 320, 400, 480, 560]) for (const tail of ['Okafor', 'Rivera-Okafor', 'Okafor Delacroix']) {
    const page = (inner) => `<div style="position:absolute;left:30px;top:30px;width:${w}px;line-height:${lh}px"><span>This incident was reported to the operator on Friday by the account owner named here, who lives nearby and is called</span> <span class=vv>${inner}</span> and more</div>`;
    add('L1far', `w${w} lh${lh} "${tail}" box l1`, dpr, page, `Samantha ${TG(tail)}`, `Samantha ${tail}`);
    add('L1far', `w${w} lh${lh} "${tail}" box l2`, dpr, page, `${TG('Samantha')} ${tail}`, `Samantha ${tail}`);
  }
}

// Sets NS to HI, from the review of the zero-bare round: a row's border with a short wrapped surname past it (NS),
// or with the value at the end of a longer first line (NO); a mid-sentence link underlined in a lighter colour
// (LU); the F4border shape inside a box, a card, a cell or sides (BX); an empty slot drawn too tall over a tile,
// swallowing a short first line (SC); separator rows of other glyphs inside the value (TD); the refused shapes
// with the box widened as the message says (RC); a hanging indent whose first line is a short word (HI). Only
// the value's glyphs are the value.
function reviewSets(cases) {
  const forEachGround = (fn) => { for (const dpr of [1, 2, 3]) for (const [g, c] of Object.entries(GROUNDS)) fn(dpr, g, c); };
  const adder = (dpr, g, c) => (set, name, page, measure, shown) => {
    const body = (inner) => `<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:${c.bg};color:${c.fg}">${page(inner)}</div>`;
    cases.push({ set, name: `${name} ${g} ${dpr}x`, dpr, cell: [560, 300], rows: 4, masked: true, glyphs: true, measure: body(measure), shown: body(shown) });
  };
  const below = (inner, px) => inner.replace('<br>', `<br><span style="display:inline-block;margin-top:${px}px"></span>`);

  forEachGround((dpr, g, c) => {
    const add = adder(dpr, g, c);
    for (const short of ['Ng', 'Li', 'Wu', 'Jr', 'Xu', 'Rivera']) for (const under of [4, 6, 8, 10]) for (const lh of [20, 28]) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:420px;height:${lh}px;border-bottom:1px solid ${c.rule}"></div><div style="position:absolute;left:40px;top:40px;width:190px;line-height:${lh}px">Requested by <span class=vv>${below(inner, under)}</span></div>`;
      add('NS', `"${short}" below${under} lh${lh} box l1`, page, `Samantha<br>${TG(short)}`, `Samantha<br>${short}`);
      add('NS', `"${short}" below${under} lh${lh} box l2`, page, `${TG('Samantha')}<br>${short}`, `Samantha<br>${short}`);
    }
    for (const lead of ['Owner', 'Account owner', 'Reported today by', 'Requested on Friday by']) for (const under of [4, 8]) for (const lh of [20, 28]) for (const w of [190, 230]) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:420px;height:${lh}px;border-bottom:1px solid ${c.rule}"></div><div style="position:absolute;left:40px;top:40px;width:${w}px;line-height:${lh}px">${lead} <span class=vv>${below(inner, under)}</span></div>`;
      add('NO', `"${lead}" w${w} below${under} lh${lh} box l1`, page, `Samantha<br>${TG('Rivera-Okafor')}`, 'Samantha<br>Rivera-Okafor');
    }
    for (const colour of [c.dark, c.rule]) for (const off of ['2px', '4px', '6px']) for (const lh of [20, 24]) for (const b of ['Li', 'Ng', 'Rivera', 'Rivera-Okafor']) {
      const deco = `text-decoration:underline ${colour};text-underline-offset:${off};text-decoration-skip-ink:none`;
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:200px;line-height:${lh}px">Reported by <span class=vv style="${deco}">${inner}</span> today</div>`;
      add('LU', `${colour === c.dark ? 'dark' : 'rule'} "${b}" off ${off} lh${lh} box l1`, page, `Samantha-Louise ${TG(b)}`, `Samantha-Louise ${b}`);
      add('LU', `${colour === c.dark ? 'dark' : 'rule'} "${b}" off ${off} lh${lh} box l2`, page, `${TG('Samantha-Louise')} ${b}`, `Samantha-Louise ${b}`);
    }
    for (const kind of ['card', 'cell', 'sides']) for (const under of [4, 6, 8, 10]) for (const lh of [20, 28]) for (const b of ['Rivera-Okafor', 'Ng']) {
      const border = kind === 'card' ? `border:1px solid ${c.rule};border-radius:8px` : kind === 'cell' ? `border:1px solid ${c.rule}` : `border-left:1px solid ${c.rule};border-right:1px solid ${c.rule};border-bottom:1px solid ${c.rule}`;
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:420px;height:${lh + 8}px;${border};box-sizing:border-box"></div><div style="position:absolute;left:52px;top:44px;width:190px;line-height:${lh}px">Requested by <span class=vv>${below(inner, under)}</span></div>`;
      add('BX', `${kind} "${b}" below${under} lh${lh} box l1`, page, `Samantha<br>${TG(b)}`, `Samantha<br>${b}`);
      add('BX', `${kind} "${b}" below${under} lh${lh} box l2`, page, `${TG('Samantha')}<br>${b}`, `Samantha<br>${b}`);
    }
    for (const under of [4, 8]) for (const lh of [20, 28]) {
      const td = `border:1px solid ${c.rule};padding:0 10px;vertical-align:top;height:${lh}px;line-height:${lh}px`;
      const page = (inner) => `<table style="position:absolute;left:30px;top:30px;border-collapse:collapse"><tr><td style="${td}">Owner</td><td style="${td};width:170px"><div style="width:170px"><span class=vv>${below(inner, under)}</span></div></td><td style="${td}">Open</td></tr><tr><td style="${td}">Due</td><td style="${td}"></td><td style="${td}">-</td></tr></table>`;
      add('BX', `table below${under} lh${lh} box l1`, page, `Samantha Rivera<br>${TG('Okafor-Delacroix')}`, 'Samantha Rivera<br>Okafor-Delacroix');
      add('BX', `table below${under} lh${lh} box l2`, page, `${TG('Samantha Rivera')}<br>Okafor-Delacroix`, 'Samantha Rivera<br>Okafor-Delacroix');
    }
    for (const under of [4, 8]) for (const lh of [20, 28]) for (const b of ['Rivera-Okafor', 'Ng']) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:420px;height:${lh}px;border-bottom:1px solid ${c.rule}"></div><div style="position:absolute;left:40px;top:40px;width:190px;line-height:${lh}px">Requested by <span class=vv>${below(inner, under)}</span></div>`;
      add('RC', `rule widened "${b}" below${under} lh${lh}`, page, `Samantha<br>${b}`, `Samantha<br>${b}`);
    }
    for (const first of ['Dr', 'Mr', 'Ms', 'Jo']) for (const indent of [12, 16, 20, 24]) for (const lh of [18, 24]) {
      const page = (inner) => `<div style="position:absolute;left:40px;top:40px;width:200px;line-height:${lh}px;padding-left:${indent}px;text-indent:-${indent}px"><span class=vv>${inner}</span></div>`;
      add('HI', `"${first}" indent${indent} lh${lh} box l1`, page, `${first}<br>${TG('Samantha Rivera-Okafor')}`, `${first}<br>Samantha Rivera-Okafor`);
    }
  });

  const tile = (lh, gapPx) => (inner) => `<div style="position:absolute;left:100px;top:20px;width:160px;height:100px;background:#eef2f7;border:1px solid #e2e6ec;border-radius:8px;box-sizing:border-box"></div><div style="position:absolute;left:100px;top:${120 + gapPx}px;width:150px;line-height:${lh}px"><span class=vv>${inner}</span></div>`;
  for (const dpr of [1, 2, 3]) for (const lh of [16, 20]) for (const over of [8, 12, 16, 20]) for (const gapPx of [2, 4, 8]) for (const first of ['Ng', 'Dr', 'Samantha']) {
    const page = tile(lh, gapPx);
    cases.push({ set: 'SC', name: `"${first}" lh${lh} over${over} gap${gapPx} box l2 ${dpr}x`, dpr, cell: [640, 300], rows: 4, masked: true, glyphs: true, measure: page(`${TG(first)}<br>Okafor Delacroix`), shown: page(`${first}<br>Okafor Delacroix`), blanks: [[100, 20, 160, 100 + over]] });
  }
  for (const dpr of [1, 2, 3]) for (const colour of ['#111827', '#6b7280']) for (const rule of ['━━━━━━━━━━━━', '════════════', '▬▬▬▬▬▬▬▬▬', '■■■■■■■■■', '••••••••••••', '~~~~~~~~~~~~', '- - - - - - - -', '············', '▔▔▔▔▔▔▔▔▔', '▁▁▁▁▁▁▁▁▁', '============', '************', '############', '————————————']) for (const lh of [14, 18, 22]) {
    const page = (inner) => `<div class=vv style="position:absolute;left:60px;top:50px;line-height:${lh}px;color:${colour}">${inner}</div>`;
    const tag = `${rule.slice(0, 1)} ${colour === '#111827' ? 'ink' : 'grey'}`;
    cases.push({ set: 'TD', name: `${tag} lh${lh} box l1 ${dpr}x`, dpr, cell: [560, 300], rows: 4, masked: true, glyphs: true, measure: page(`Samantha Rivera<br>${TG(rule)}<br>${TG('Okafor Delacroix')}`), shown: page(`Samantha Rivera<br>${rule}<br>Okafor Delacroix`) });
    cases.push({ set: 'TD', name: `${tag} lh${lh} box l3 ${dpr}x`, dpr, cell: [560, 300], rows: 4, masked: true, glyphs: true, measure: page(`${TG('Samantha Rivera')}<br>${TG(rule)}<br>Okafor Delacroix`), shown: page(`Samantha Rivera<br>${rule}<br>Okafor Delacroix`) });
  }
  for (const dpr of [1, 2, 3]) for (const lh of [16, 20]) for (const over of [12, 16]) for (const gapPx of [8, 12]) {
    const page = tile(lh, gapPx);
    cases.push({ set: 'RC', name: `blank widened lh${lh} over${over} gap${gapPx} ${dpr}x`, dpr, cell: [640, 300], rows: 4, masked: true, glyphs: true, measure: page('Samantha Rivera<br>Okafor Delacroix'), shown: page('Samantha Rivera<br>Okafor Delacroix'), blanks: [[100, 20, 160, 100 + over]] });
  }
}

// From the re-review of the default-refuse gate. FT: a faint value, 9 to 55 levels off its ground, past a row's
// border, which a reading at full contrast does not see.
function faintSets(cases) {
  for (const dpr of [1, 2, 3]) for (const colour of ['#c8c8c8', '#dcdcdc', '#e4e4e4', '#e8e8e8', '#ececec']) for (const below of [4, 8]) for (const lh of [20, 28]) {
    const body = (inner) => `<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:#fff;color:${colour}"><div style="position:absolute;left:40px;top:40px;width:420px;height:${lh}px;border-bottom:1px solid #e5e7eb"></div><div style="position:absolute;left:40px;top:40px;width:190px;line-height:${lh}px">Requested by <span class=vv>${inner.replace('<br>', `<br><span style="display:inline-block;margin-top:${below}px"></span>`)}</span></div></div>`;
    const add = (name, measure, shown) => cases.push({ set: 'FT', name: `${colour} below${below} lh${lh} ${name} ${dpr}x`, dpr, cell: [560, 300], rows: 4, masked: true, glyphs: true, measure: body(measure), shown: body(shown) });
    add('box l1', `Samantha<br>${TG('Rivera-Okafor')}`, 'Samantha<br>Rivera-Okafor');
    add('box l2', `${TG('Samantha')}<br>Rivera-Okafor`, 'Samantha<br>Rivera-Okafor');
  }
}

export function fillAttackCases() {
  const cases = [];
  groundSets(cases);
  decorationSets(cases);
  listSets(cases);
  reviewSets(cases);
  faintSets(cases);
  return cases;
}

// Hidden, or refused: a written board shows no pixel of the value, warned or not.
export const verdictOf = (r) => (r.bare === 0 ? 'hidden' : r.refused ? 'refused' : 'bare');

// Whole pages, imported at 1x, 2x or 3x and composed. `box` names the element the redact box is drawn round (the
// first line of its text with `firstText`, its first `firstLines` 20 px lines, or set `off` it as below), grown by a
// device px each side; `value` is every element whose glyphs are the value; the frame is the card grown by 4.
const CARD = 'body{margin:0;font:14px Helvetica,Arial,sans-serif;background:#f6f7f9;color:#111827}';
const doc = (css, body) => `<!doctype html><meta charset=utf-8><style>${CARD}${css}</style>${body}`;

export function boardAttackScenes() {
  const scenes = [];
  const reviewer = (height, inner) => doc(`.card{position:absolute;left:40px;top:40px;width:420px;height:${height}px;box-sizing:border-box;background:#fff;border:1px solid #e5e7eb;border-radius:12px}
.l{position:absolute;left:20px;top:24px;line-height:20px;color:#6b7280}.v{position:absolute;left:220px;top:24px;line-height:20px;overflow-wrap:anywhere}`, `<div class=card id=frame><div class=l>Reviewer</div>${inner}</div>`);
  const wraps = [
    ['li-wrap', 2, '<div class=v style="width:60px">Li <span>Okafor-Rivera</span></div>'],
    ['liu-wrap-3x', 3, '<div class=v style="width:60px">Liu <span>Okafor-Rivera</span></div>'],
    ['right-wrap', 2, '<div class=v style="width:110px;text-align:right">Jo <span>Montgomery</span></div>'],
    ['lee-wrap', 2, '<div class=v style="width:50px">Lee <span>Okafor-Rivera-Delacroix</span></div>'],
  ];
  const threeLines = [
    ['three-line-2x', 2, '<div class=v style="width:150px;line-height:21px">Samantha<br><span>Rivera-Okafor<br>Delacroix</span></div>'],
    ['three-line-1x', 1, '<div class=v style="width:150px;line-height:21px">Samantha<br><span>Rivera-Okafor<br>Delacroix</span></div>'],
    ['three-line-3x', 3, '<div class=v style="width:150px;line-height:22px">Samantha<br><span>Rivera-Okafor<br>Delacroix</span></div>'],
  ];
  const firstText = { sel: '.v', firstText: true };
  for (const [name, dpr, inner] of wraps) scenes.push({ set: 'run', name, dpr, viewport: [600, 300], html: reviewer(120, inner), value: '.v', box: firstText });
  for (const [name, dpr, inner] of [...threeLines, ...wraps]) scenes.push({ set: 'run3', name, dpr, viewport: [600, 300], html: reviewer(140, inner), value: '.v', box: firstText });

  const card = '.card{position:absolute;left:40px;top:40px;width:520px;box-sizing:border-box;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px}table{border-collapse:collapse}td{padding:8px 12px;vertical-align:top}.b td{border-bottom:1px solid #e5e7eb}';
  const names = ['Samantha Rivera', 'Jordan Okafor', 'Priya Delacroix', 'Mateo Lindqvist', 'Ana Montgomery', 'Wei Chen'];
  const table = (cls) => doc(card, `<div class=card id=frame><table class="${cls}">${names.map((n, i) => `<tr><td id=n${i}>${n}</td><td id=s${i} style="color:#6b7280">${['Open', 'Closed', 'Open', 'Review', 'Open', 'Closed'][i]}</td></tr>`).join('')}</table></div>`);
  const addr = (gap) => doc(card, `<div class=card id=frame><div style="color:#6b7280;line-height:20px">Ship to</div><div id=v style="line-height:20px">14 Larkspur Lane<br>Apartment 3B<div style="margin-top:${gap}px">Springfield 62704</div></div><div id=st style="margin-top:28px;color:#6b7280;line-height:20px">Delivery pending</div></div>`);
  const owner = doc(card, '<div class=card id=frame><div style="color:#6b7280;line-height:20px">Owner</div><div id=v style="line-height:20px">Samantha Rivera</div><div id=w style="margin-top:14px;line-height:20px">samantha.rivera@tracker.example</div><div id=st style="margin-top:28px;color:#6b7280;line-height:20px">Delivery pending</div></div>');
  const street = { sel: '#v', firstLines: 2 };
  const wide = (set, name, dpr, html, value, box, marks = []) => scenes.push({ set, name, dpr, viewport: [640, 420], html, value, box, marks });
  for (const dpr of [1, 2, 3]) {
    wide('run6', `table-plain-${dpr}x`, dpr, table(''), '#n0', { sel: '#n0' });
    wide('run6', `table-borders-${dpr}x`, dpr, table('b'), '#n0', { sel: '#n0' });
    wide('run6', `table-plain-lift-row4-${dpr}x`, dpr, table(''), '#n0', { sel: '#n0' }, [{ kind: 'lift', sel: '#n3' }]);
    wide('run6', `table-plain-context-row3-${dpr}x`, dpr, table(''), '#n0', { sel: '#n0' }, [{ kind: 'context', sel: '#n2' }]);
    wide('run6', `table-plain-redact-mid-${dpr}x`, dpr, table(''), '#n2', { sel: '#n2' });
    for (const gap of [10, 14, 18, 24, 32]) wide('run6', `addr-gap${gap}-ctx-${dpr}x`, dpr, addr(gap), '#v', street, [{ kind: 'context', sel: '#st' }]);
  }
  for (const dpr of [1, 2, 3]) {
    for (const gap of [10, 14, 18, 24, 32, 40, 48, 64]) wide('run7', `addr-gap${gap}-${dpr}x`, dpr, addr(gap), '#v', street);
    for (const off of ['above', 'left', 'inGap', 'below2']) wide('run7', `noink-${off}-${dpr}x`, dpr, addr(24), '#v', { ...street, off: `run7 ${off}` });
    wide('run7', `tworedact-${dpr}x`, dpr, owner, '#v', { sel: '#v' }, [{ kind: 'redact', sel: '#w' }]);
  }
  const padded = (gap, { head = false, status = false, padding }) => doc(card, `<div class=card id=frame style="padding:${padding}">${head ? '<div id=hd style="color:#6b7280;line-height:20px;margin-bottom:40px">Ship to</div>' : ''}<div id=v style="line-height:20px">14 Larkspur Lane<br>Apartment 3B<div style="margin-top:${gap}px">Springfield 62704</div></div>${status ? '<div id=st style="margin-top:44px;color:#6b7280;line-height:20px">Delivery pending</div>' : ''}</div>`);
  for (const dpr of [1, 2, 3]) for (const gap of [24, 40]) for (const off of ['above', 'left', 'right', 'inGap', 'aboveTight']) {
    wide('run8', `noink-${off}-gap${gap}-${dpr}x`, dpr, padded(gap, { padding: '60px 80px' }), '#v', { ...street, off, gap });
  }
  for (const dpr of [1, 2, 3]) for (const gap of [24, 40]) for (const off of ['aboveTight', 'above', 'inGap', 'left']) {
    wide('run9', `noinkctx-${off}-gap${gap}-${dpr}x`, dpr, padded(gap, { status: true, padding: '60px 80px' }), '#v', { ...street, off, gap }, [{ kind: 'context', sel: '#st' }]);
  }
  for (const dpr of [1, 2, 3]) for (const gap of [24, 40]) for (const off of ['aboveTight', 'above', 'inGap']) {
    wide('run10', `noinkctx-${off}-gap${gap}-${dpr}x`, dpr, padded(gap, { head: true, status: true, padding: '20px 80px 40px' }), '#v', { ...street, off, gap }, [{ kind: 'context', sel: '#hd' }, { kind: 'context', sel: '#st' }]);
  }

  // A card with a heading and a status line, both context marks; the box drawn round one span of the value.
  const review = (width, inner, statusLh = 20) => doc(`.card{position:absolute;left:40px;top:40px;width:${width}px;box-sizing:border-box;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px}`, `<div class=card id=frame><div id=hd style="color:#6b7280;line-height:20px;margin-bottom:12px">Review</div>${inner}<div id=st style="margin-top:16px;color:#6b7280;line-height:${statusLh}px">Review requested</div></div>`);
  const context = [{ kind: 'context', sel: '#hd' }, { kind: 'context', sel: '#st' }];
  const reviewed = (set, name, dpr, viewport, html, on, value = '#a,#b') => scenes.push({ set, name, dpr, viewport, html, value, box: { sel: on }, marks: context });
  const indent = (lh, width = 150) => `<div style="width:${width}px;line-height:${lh}px;text-indent:90px"><span id=a>Samantha</span> <span id=b>Okafor</span></div>`;
  const farLabel = '<div style="width:170px;line-height:30px">Owner:&emsp;&emsp;&emsp;&emsp;<span id=a>Samantha</span> <span id=b>Okafor</span></div>';
  reviewed('run11', 'indent-2x', 2, [420, 320], review(300, '<div style="width:150px;line-height:20px;text-indent:90px">Reviewer <span id=a>Samantha</span> <span id=b>Okafor</span></div>'), '#a');
  reviewed('run11', 'indent-3x', 3, [420, 320], review(300, indent(20)), '#a');
  reviewed('run11', 'indent-1x', 1, [420, 320], review(300, indent(20)), '#a');
  reviewed('run11', 'farlabel-line2-2x', 2, [420, 320], review(300, farLabel), '#b');
  const rtl = '<div dir=rtl style="width:170px;line-height:22px;text-indent:90px"><span id=a>Samantha</span> <span id=b>Okafor</span></div>';
  reviewed('run12', 'rtl-indent-2x', 2, [460, 400], review(340, rtl), '#a');
  reviewed('run12', 'rtl-indent-line2-3x', 3, [460, 400], review(340, rtl), '#b');
  reviewed('run12', 'three-lh44-2x', 2, [460, 400], review(340, '<div style="width:150px;line-height:44px;text-indent:80px"><span id=a>Samantha</span> <span id=b>Rivera Okafor Delacroix Montgomery</span></div>'), '#a');
  reviewed('run12', 'far-lh60-2x', 2, [460, 400], review(340, indent(60, 170)), '#a');
  reviewed('run12', 'indent-3x', 3, [460, 400], review(340, indent(20)), '#a');
  reviewed('run12', 'indent-1x', 1, [460, 400], review(340, indent(20)), '#a');
  reviewed('run12', 'indent-line2-2x', 2, [460, 400], review(340, indent(20)), '#b');
  reviewed('run12', 'farlabel-line2-2x', 2, [460, 400], review(340, farLabel), '#b');
  const label = (l) => `<div style="color:#6b7280">${l}</div>`;
  const details = `<div style="display:grid;grid-template-columns:110px 170px;row-gap:6px;column-gap:16px;line-height:20px">${[['Reviewer', 'Samantha Rivera'], ['Status', 'In review'], ['Priority', 'High'], ['Due', 'Friday'], ['Component', 'Exports'], ['Labels', 'csv, reports']].map(([l, v], i) => `${label(l)}<div id=v${i}>${v}</div>`).join('')}</div>`;
  const emails = `<table style="border-collapse:collapse;line-height:20px">${[['Samantha Rivera', 'sam.rivera@tracker.example'], ['Jordan Okafor', 'jordan@tracker.example'], ['Priya Delacroix', 'priya.d@tracker.example'], ['Mateo Lind', 'mateo@tracker.example']].map(([n, e], i) => `<tr><td style="padding:4px 12px 4px 0">${n}</td><td id=e${i} style="padding:4px 0">${e}</td></tr>`).join('')}</table>`;
  reviewed('run13', 'grid-row1-1x', 1, [520, 400], review(400, details), '#v0', '#v0');
  reviewed('run13', 'grid-row1-2x', 2, [520, 400], review(400, details), '#v0', '#v0');
  reviewed('run13', 'grid-row3-2x', 2, [520, 400], review(400, details), '#v2', '#v2');
  reviewed('run13', 'table-email1-1x', 1, [520, 400], review(400, emails), '#e0', '#e0');
  reviewed('run13', 'table-email1-2x', 2, [520, 400], review(400, emails), '#e0', '#e0');
  const twoLabel = (lh) => `<div style="display:grid;grid-template-columns:90px 120px;row-gap:6px;column-gap:16px;line-height:${lh}px">${label('Second reviewer')}<div><span id=a>Samantha</span> <span id=b>Rivera-Okafor</span></div>${label('Status')}<div>In review</div>${label('Priority')}<div>High</div>${label('Due')}<div>Friday</div></div>`;
  for (const dpr of [1, 2, 3]) reviewed('run14', `twolabel-${dpr}x`, dpr, [520, 400], review(400, twoLabel(20)), '#a');
  for (const dpr of [1, 2, 3]) reviewed('run15', `twolabel24-${dpr}x`, dpr, [520, 400], review(400, twoLabel(24), 24), '#a');

  // A value-only link wrapping in a narrow column, the box on its second line.
  for (const [dpr, off] of [[2, '4px'], [3, 'auto'], [2, 'auto']]) {
    const html = doc('', `<div id=frame style="position:absolute;left:40px;top:40px;width:420px;height:200px;background:#fff;border:1px solid #e5e7eb;border-radius:12px"><div style="position:absolute;left:20px;top:20px;color:#6b7280">Contact</div><div style="position:absolute;left:20px;top:44px;width:120px;line-height:20px"><span id=v style="text-decoration:underline;text-underline-offset:${off}">Samantha-Louise <span id=l2>Rivera</span></span></div><div style="position:absolute;left:220px;top:44px;line-height:20px">Status open</div></div>`);
    scenes.push({ set: 'e1', name: `${dpr}x off ${off}`, dpr, viewport: [640, 360], html, value: '#v', glyphs: true, box: { sel: '#l2' } });
  }
  reviewScenes(scenes);
  rereviewScenes(scenes);
  gateReviewScenes(scenes);
  return scenes;
}

// Whole pages from the re-review of the default-refuse gate. WL, WL2: a fixed-width label before the value, which
// wraps under it to the container's edge; the box on either line. FG: the value's second line a lead or more past a
// row's border. SH, PR: a short or straight-stemmed second line just under the first, inside the walk's rect. FT: a
// faint value past a row's border. TR, TR4: neighbouring bordered rows, two redactions, or one with the next row
// marked context as the `rule` refusal asks (the recoveries must be written).
function gateReviewScenes(scenes) {
  const page = (body) => `<!doctype html><meta charset=utf-8><style>body{margin:0;font:14px Helvetica,Arial,sans-serif;background:#f6f7f9;color:#111827}</style>${body}`;
  const card = (w, h, inner) => page(`<div id=frame style="position:absolute;left:40px;top:40px;width:${w}px;height:${h}px;background:#fff;border:1px solid #e5e7eb;border-radius:12px">${inner}</div>`);
  const push = (set, name, dpr, html, box, marks = [], viewport = [680, 420]) => scenes.push({ set, name, dpr, viewport, html, value: '#v', box, marks });
  const L1 = { sel: '#v', firstText: true }; const L2 = { sel: '#l2' }; const WHOLE = { sel: '#v' };
  const status = (top) => `<div style="position:absolute;left:20px;top:${top}px;color:#6b7280">Status open</div>`;
  const label = (W) => `<span style="display:inline-block;width:${W}px;color:#6b7280">Requested by</span>`;
  for (const dpr of [1, 2, 3]) for (const W of [120, 160, 200, 240]) for (const l2 of ['Rivera-Okafor', 'Ng']) {
    const html = card(520, 200, `<div style="position:absolute;left:20px;top:30px;width:400px;line-height:20px">${label(W)}<span id=v>Samantha<br><span id=l2>${l2}</span></span></div>${status(140)}`);
    push('WL', `W${W} "${l2}" box l1 ${dpr}x`, dpr, html, L1);
    push('WL', `W${W} "${l2}" box l2 ${dpr}x`, dpr, html, L2);
  }
  for (const dpr of [1, 2, 3]) for (const W of [160, 200, 240]) {
    const html = card(520, 200, `<div style="position:absolute;left:20px;top:30px;width:${W + 92}px;line-height:20px">${label(W)}<span id=v>Samantha <span id=l2>Rivera-Okafor</span></span></div>${status(140)}`);
    push('WL', `nat W${W} box l1 ${dpr}x`, dpr, html, L1);
    push('WL', `nat W${W} box l2 ${dpr}x`, dpr, html, L2);
    push('WL', `nat W${W} widen ${dpr}x`, dpr, html, WHOLE);
  }
  for (const dpr of [1, 2, 3]) for (const W of [240, 280, 320, 360]) {
    const br = card(600, 200, `<div style="position:absolute;left:20px;top:30px;width:${W + 120}px;line-height:20px">${label(W)}<span id=v>Samantha<br><span id=l2>Rivera-Okafor</span></span></div>${status(140)}`);
    push('WL2', `br W${W} box l1 ${dpr}x`, dpr, br, L1, [], [700, 420]);
    push('WL2', `br W${W} box l2 ${dpr}x`, dpr, br, L2, [], [700, 420]);
    const nat = card(600, 200, `<div style="position:absolute;left:20px;top:30px;width:${W + 92}px;line-height:20px">${label(W)}<span id=v>Samantha <span id=l2>Rivera-Okafor</span></span></div>${status(140)}`);
    push('WL2', `nat W${W} box l1 ${dpr}x`, dpr, nat, L1, [], [700, 420]);
    push('WL2', `nat W${W} box l2 ${dpr}x`, dpr, nat, L2, [], [700, 420]);
  }
  const lead = (shape, lh, top) => (shape === 'hang' ? `<div style="position:absolute;left:32px;top:${top}px;width:260px;line-height:${lh}px;padding-left:90px;text-indent:-90px">By ` : `<div style="position:absolute;left:32px;top:${top}px;width:190px;line-height:${lh}px">Requested by `);
  for (const dpr of [1, 2, 3]) for (const shape of ['under', 'hang']) for (const below of [16, 20, 24, 28, 32]) {
    const lh = 28;
    const html = card(520, 220, `<div style="position:absolute;left:20px;top:20px;width:360px;height:${lh + 8}px;border-bottom:1px solid #e5e7eb;box-sizing:border-box"></div>${lead(shape, lh, 24)}<span id=v>Samantha<br><span id=l2 style="display:inline-block;margin-top:${below}px;text-indent:0">Rivera-Okafor</span></span></div><div style="position:absolute;left:32px;top:160px;color:#6b7280">Status open</div>`);
    push('FG', `${shape} below${below} box l1 ${dpr}x`, dpr, html, L1);
  }
  for (const dpr of [1, 2, 3]) for (const shape of ['under', 'hang']) for (const lh of [40, 48, 56]) {
    const html = card(520, 220, `<div style="position:absolute;left:20px;top:10px;width:360px;height:${lh + 2}px;border-bottom:1px solid #e5e7eb;box-sizing:border-box"></div>${lead(shape, lh, 10)}<span id=v>Samantha<br><span id=l2>Rivera-Okafor</span></span></div><div style="position:absolute;left:32px;top:170px;color:#6b7280">Status open</div>`);
    push('FG', `${shape} lh${lh} box l1 ${dpr}x`, dpr, html, L1);
  }
  const SHORT = ['Jr', 'Li', 'Il', 'Jo', 'II', 'IV', 'K.', 'Ng'];
  for (const dpr of [1, 2, 3]) for (const lh of [14, 16, 18, 20]) for (const short of SHORT) {
    const hang = card(520, 200, `<div style="position:absolute;left:32px;top:24px;width:260px;line-height:${lh}px;padding-left:90px;text-indent:-90px">By <span id=v><u>Samantha</u><br><span id=l2 style="text-indent:0">${short}</span></span></div><div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div>`);
    push('SH', `hang "${short}" lh${lh} box l1 ${dpr}x`, dpr, hang, L1);
    const edge = card(520, 200, `<div style="position:absolute;left:32px;top:24px;width:260px;line-height:${lh}px"><span style="display:inline-block;width:22px">By</span><span id=v><u>Samantha</u><br><span id=l2>${short}</span></span></div><div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div>`);
    push('SH', `edge "${short}" lh${lh} box l1 ${dpr}x`, dpr, edge, L1);
  }
  const bordered = (colour, l2) => `<div style="position:absolute;left:20px;top:20px;width:360px;height:36px;border-bottom:1px solid #e5e7eb;box-sizing:border-box"></div><div style="position:absolute;left:32px;top:24px;width:190px;line-height:28px${colour ? `;color:${colour}` : ''}">Requested by <span id=v>Samantha<br>${l2}</span></div><div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div>`;
  for (const dpr of [1, 2, 3]) for (const short of SHORT) for (const below of [4, 8]) {
    push('SH', `border "${short}" below${below} box l1 ${dpr}x`, dpr, card(520, 200, bordered(null, `<span id=l2 style="display:inline-block;margin-top:${below}px">${short}</span>`)), L1);
  }
  for (const dpr of [1, 2, 3]) for (const lh of [14, 16, 18, 20]) for (const l2 of ['Rivera-Okafor', 'Okafor', 'II']) for (const deco of ['u', 'plain']) {
    const first = deco === 'u' ? '<u>Samantha</u>' : 'Samantha';
    const edge = card(600, 200, `<div style="position:absolute;left:32px;top:24px;width:260px;line-height:${lh}px"><span style="display:inline-block;width:22px">By</span><span id=v>${first}<br><span id=l2>${l2}</span></span></div><div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div>`);
    push('PR', `edge ${deco} "${l2}" lh${lh} box l1 ${dpr}x`, dpr, edge, L1, [], [700, 420]);
    const hang = card(600, 200, `<div style="position:absolute;left:32px;top:24px;width:260px;line-height:${lh}px;padding-left:90px;text-indent:-90px">By <span id=v>${first}<br><span id=l2 style="text-indent:0">${l2}</span></span></div><div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div>`);
    push('PR', `hang ${deco} "${l2}" lh${lh} box l1 ${dpr}x`, dpr, hang, L1, [], [700, 420]);
  }
  for (const dpr of [1, 2, 3]) for (const colour of ['#c8c8c8', '#dcdcdc', '#e4e4e4', '#e8e8e8', '#ececec']) for (const below of [4, 8]) {
    const html = card(520, 200, bordered(colour, `<span id=l2 style="display:inline-block;margin-top:${below}px">Rivera-Okafor</span>`));
    push('FT', `${colour} below${below} box l1 ${dpr}x`, dpr, html, L1);
    push('FT', `${colour} below${below} box l2 ${dpr}x`, dpr, html, L2);
  }
  for (const dpr of [1, 2]) for (const gap of [0, 4]) {
    const row = (id, name, text) => `<div style="display:flex;height:36px;line-height:36px;border-bottom:1px solid #e5e7eb;margin-bottom:${gap}px"><div id=${id}label style="width:120px;color:#6b7280">${name}</div><div><span id=${id}>${text}</span></div></div>`;
    const html = card(520, 220, `<div style="position:absolute;left:20px;top:20px;width:400px">${row('v', 'Name', 'Samantha Rivera-Okafor')}${row('e', 'Email', 'samantha.ro@tracker.example')}${row('s', 'Status', 'Open')}</div>`);
    push('TR', `name+email gap${gap} ${dpr}x`, dpr, html, WHOLE, [{ kind: 'redact', sel: '#e' }]);
    push('TR', `name+email+context gap${gap} ${dpr}x`, dpr, html, WHOLE, [{ kind: 'redact', sel: '#e' }, { kind: 'context', sel: '#e' }]);
    push('TR', `name alone gap${gap} ${dpr}x`, dpr, html, WHOLE, []);
  }
  for (const dpr of [1, 2, 3]) for (const pad of [2, 4, 8, 12, 16]) {
    const row = (id, name, text) => `<div id=${id}row style="display:flex;line-height:18px;padding:${pad}px 0;border-bottom:1px solid #e5e7eb"><div id=${id}label style="width:120px;color:#6b7280">${name}</div><div><span id=${id}>${text}</span></div></div>`;
    const html = card(520, 240, `<div style="position:absolute;left:20px;top:20px;width:400px">${row('v', 'Name', 'Samantha Rivera-Okafor')}${row('e', 'Email', 'samantha.ro@tracker.example')}${row('s', 'Status', 'Open')}</div>`);
    push('TR4', `pad${pad} name alone ${dpr}x`, dpr, html, WHOLE);
    push('TR4', `pad${pad} context on email row ${dpr}x`, dpr, html, WHOLE, [{ kind: 'context', sel: '#erow' }]);
    push('TR4', `pad${pad} context on email and name labels ${dpr}x`, dpr, html, WHOLE, [{ kind: 'context', sel: '#erow' }, { kind: 'context', sel: '#vlabel' }]);
  }
}

// Whole pages from the re-review of the zero-bare round's first fixes. AR: the value's second line past a row's
// border, a mark on it or on a badge over part of it, the line under the value's columns or at a hanging indent
// wholly beside them. AW2: a bold label set off by a margin, the value after it wrapping under the label to the
// container's left edge, off the fill's columns, with a mark on that line or on the word after it. AR2: a short
// hanging label, the value's lines under each other with a row's border between them and a mark on the second.
// A context mark on a line past a rule is the driver's word that the line is not the value (`word`): what lies
// inside its box is not counted as the value's, and everything else is.
function rereviewScenes(scenes) {
  const card = (h, inner) => `<!doctype html><meta charset=utf-8><style>body{margin:0;font:14px Helvetica,Arial,sans-serif;background:#f6f7f9;color:#111827}</style><div id=frame style="position:absolute;left:40px;top:40px;width:520px;height:${h}px;background:#fff;border:1px solid #e5e7eb;border-radius:12px">${inner}</div>`;
  const push = (set, name, dpr, html, box, marks = [], word = false) => scenes.push({ set, name, dpr, viewport: [680, 420], html, value: '#v', box, marks, ...(word ? { word } : {}) });
  for (const dpr of [1, 2, 3]) for (const shape of ['hang', 'under']) for (const kind of ['lift', 'loupe', 'badge-lift', 'none']) {
    const lh = 28;
    const lead = shape === 'hang' ? `<div style="position:absolute;left:32px;top:24px;width:260px;line-height:${lh}px;padding-left:90px;text-indent:-90px">By ` : `<div style="position:absolute;left:32px;top:24px;width:190px;line-height:${lh}px">Requested by `;
    const badge = kind === 'badge-lift' ? `<div id=bd style="position:absolute;left:${shape === 'hang' ? 110 : 20}px;top:${24 + lh + 6}px;width:90px;height:28px;background:rgba(219,234,254,.35);border-radius:10px"></div>` : '';
    const html = card(200, `<div style="position:absolute;left:20px;top:20px;width:360px;height:${lh + 8}px;border-bottom:1px solid #e5e7eb;box-sizing:border-box"></div>${lead}<span id=v>Samantha<br><span id=l2 style="display:inline-block;margin-top:8px;text-indent:0">Rivera-Okafor</span></span></div>${badge}<div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div>`);
    const marks = kind === 'none' ? [] : kind === 'badge-lift' ? [{ kind: 'lift', sel: '#bd' }] : [{ kind, sel: '#l2' }];
    push('AR', `${shape} ${kind} ${dpr}x`, dpr, html, { sel: '#v', firstText: true }, marks);
  }
  for (const dpr of [1, 2, 3]) for (const lh of [20, 24]) for (const tail of ['', 'today']) {
    const html = card(200, `<div style="position:absolute;left:20px;top:30px;width:260px;line-height:${lh}px"><b style="margin-right:60px">Requested by</b><span id=v><span id=l1>Samantha</span> <span id=l2>Rivera-Okafor</span></span>${tail ? ` <span id=tail>${tail}</span>` : ''}</div><div style="position:absolute;left:20px;top:140px;color:#6b7280">Status open</div>`);
    const t = tail ? 'tail' : 'notail';
    push('AW2', `lift on l2 lh${lh} ${t} ${dpr}x`, dpr, html, { sel: '#l1' }, [{ kind: 'lift', sel: '#l2' }]);
    push('AW2', `context on l2 lh${lh} ${t} ${dpr}x`, dpr, html, { sel: '#l1' }, [{ kind: 'context', sel: '#l2' }]);
    if (tail) push('AW2', `context on tail lh${lh} ${t} ${dpr}x`, dpr, html, { sel: '#l1' }, [{ kind: 'context', sel: '#tail' }]);
    push('AW2', `nomark lh${lh} ${t} ${dpr}x`, dpr, html, { sel: '#l1' }, []);
  }
  for (const dpr of [1, 2, 3]) for (const kind of ['lift', 'loupe', 'ghost', 'context', 'none']) {
    const lh = 28;
    const html = card(200, `<div style="position:absolute;left:20px;top:20px;width:360px;height:${lh + 4}px;border-bottom:1px solid #e5e7eb;box-sizing:border-box"></div><div style="position:absolute;left:32px;top:24px;width:200px;line-height:${lh}px;padding-left:24px;text-indent:-24px">By <span id=v>Samantha<br><span id=l2 style="display:inline-block;margin-top:6px;text-indent:0">Rivera-Okafor</span></span></div><div style="position:absolute;left:32px;top:140px;color:#6b7280">Status open</div>`);
    push('AR2', `${kind} on l2 ${dpr}x`, dpr, html, { sel: '#v', firstText: true }, kind === 'none' ? [] : [{ kind, sel: '#l2' }], kind === 'context');
  }
}

// Whole pages from the review of the zero-bare round. BX: a card header whose value overflows its bordered row,
// the box on the overflowed second line. PG: the value's colour is the page's outside the frame. CX: a context or
// lift mark drawn on the value's own wrapped line, or over the whole value. BR: an address whose last line sits
// past a gap, with a chip beside the gap. SL: an empty slot drawn 12 CSS px too tall over a tile, swallowing a
// short first line under it. BK: the value's second line past a row's border shares its row with a lifted badge,
// another redacted field or a context mark, to the mark's right.
function reviewScenes(scenes) {
  const page = (bg, body) => `<!doctype html><meta charset=utf-8><style>body{margin:0;font:14px Helvetica,Arial,sans-serif;background:${bg};color:#111827}</style>${body}`;
  const push = (set, name, dpr, html, value, box, marks = []) => scenes.push({ set, name, dpr, viewport: [640, 420], html, value, box, marks });
  for (const dpr of [1, 2, 3]) for (const kind of ['card', 'cell']) for (const under of [4, 8]) {
    const border = kind === 'card' ? 'border:1px solid #e5e7eb;border-radius:8px' : 'border:1px solid #e5e7eb';
    const html = page('#f6f7f9', `<div id=frame style="position:absolute;left:40px;top:40px;width:420px;height:200px;background:#fff;border:1px solid #e5e7eb;border-radius:12px"><div style="position:absolute;left:20px;top:20px;width:360px;height:36px;${border};box-sizing:border-box"></div><div style="position:absolute;left:32px;top:24px;width:190px;line-height:28px">Requested by <span id=v>Samantha<br><span id=l2 style="display:inline-block;margin-top:${under}px">Rivera-Okafor</span></span></div><div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div></div>`);
    push('BX', `${kind} below${under} box l2 ${dpr}x`, dpr, html, '#v', { sel: '#l2' });
    push('BX', `${kind} below${under} box l1 ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true });
  }
  for (const dpr of [1, 2, 3]) for (const [name, bg, card, fg] of [['white-on-dark', '#fff', '#1f2937', '#fff'], ['gray50-on-dark', '#f9fafb', '#1f2937', '#f9fafb'], ['dark-on-white-darkpage', '#111827', '#fff', '#111827'], ['dark-on-white-near', '#0f172a', '#fff', '#111827']]) {
    const html = page(bg, `<div id=frame style="position:absolute;left:40px;top:40px;width:420px;height:140px;background:${card};color:${fg};border-radius:8px"><div style="position:absolute;left:20px;top:24px;opacity:.7">Reviewer</div><div id=v style="position:absolute;left:220px;top:24px;width:110px;line-height:20px">Samantha <span id=l2>Rivera-Okafor</span></div><div style="position:absolute;left:220px;top:90px;opacity:.7">Status open</div></div>`);
    push('PG', `${name} box l1 ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true });
    push('PG', `${name} box l2 ${dpr}x`, dpr, html, '#v', { sel: '#l2' });
    push('PG', `${name} whole ${dpr}x`, dpr, html, '#v', { sel: '#v' });
  }
  for (const dpr of [1, 2]) {
    const html = page('#f6f7f9', `<div id=frame style="position:absolute;left:40px;top:40px;width:420px;height:160px;background:#fff;border:1px solid #e5e7eb;border-radius:12px"><div id=hd style="position:absolute;left:20px;top:20px;color:#6b7280">Contact</div><div id=v style="position:absolute;left:20px;top:44px;width:120px;line-height:20px">Samantha-Louise <span id=l2>Rivera</span></div><div id=st style="position:absolute;left:220px;top:44px;line-height:20px">Status open</div></div>`);
    push('CX', `context on line 2 ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true }, [{ kind: 'context', sel: '#l2' }]);
    push('CX', `context on heading (sane) ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true }, [{ kind: 'context', sel: '#hd' }]);
    push('CX', `lift on line 2 ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true }, [{ kind: 'lift', sel: '#l2' }]);
    push('CX', `context on whole value, box l1 ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true }, [{ kind: 'context', sel: '#v' }]);
  }
  for (const dpr of [1, 2, 3]) for (const gap of [40, 48, 64]) for (const chip of ['beside', 'none']) {
    const html = page('#f6f7f9', `<div id=frame style="position:absolute;left:40px;top:40px;width:520px;height:260px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;box-sizing:border-box"><div style="color:#6b7280;line-height:20px">Ship to</div><div id=v style="line-height:20px;width:200px">14 Larkspur Lane<br>Apartment 3B<div style="margin-top:${gap}px">Springfield 62704</div></div>${chip === 'beside' ? `<div style="position:absolute;left:300px;top:${70 + gap / 2}px;background:#dbeafe;color:#1e3a8a;border-radius:10px;padding:2px 10px;font-size:13px;line-height:18px">Delivered</div>` : ''}<div style="margin-top:28px;color:#6b7280;line-height:20px">Delivery pending</div></div>`);
    push('BR', `gap${gap} chip-${chip} ${dpr}x`, dpr, html, '#v', { sel: '#v', firstLines: 2 });
  }
  for (const dpr of [1, 2, 3]) for (const first of ['Dr', 'Samantha']) for (const gapPx of [2, 8]) {
    const html = page('#f6f7f9', `<div id=frame style="position:absolute;left:40px;top:40px;width:420px;height:220px;background:#fff;border:1px solid #e5e7eb;border-radius:12px"><div id=tile style="position:absolute;left:20px;top:20px;width:160px;height:100px;background:#eef2f7;border:1px solid #e2e6ec;border-radius:8px;box-sizing:border-box"></div><div id=slotbox style="position:absolute;left:20px;top:20px;width:160px;height:112px"></div><div style="position:absolute;left:20px;top:${120 + gapPx}px;width:150px;line-height:16px"><span id=v>${first}<br><span id=l2>Okafor Delacroix</span></span></div></div>`);
    push('SL', `"${first}" gap${gapPx} over12 ${dpr}x`, dpr, html, '#v', { sel: '#l2' }, [{ kind: 'empty', sel: '#slotbox' }]);
  }
  for (const dpr of [1, 2, 3]) for (const other of ['lift', 'redact', 'context']) {
    const lh = 28;
    const html = page('#f6f7f9', `<div id=frame style="position:absolute;left:40px;top:40px;width:420px;height:200px;background:#fff;border:1px solid #e5e7eb;border-radius:12px"><div style="position:absolute;left:20px;top:20px;width:360px;height:${lh + 8}px;border-bottom:1px solid #e5e7eb;box-sizing:border-box"></div><div style="position:absolute;left:32px;top:24px;width:260px;line-height:${lh}px;padding-left:90px;text-indent:-90px">By <span id=v>Samantha<br><span id=l2 style="display:inline-block;margin-top:8px">Rivera-Okafor</span></span></div><div id=w style="position:absolute;left:32px;top:${24 + lh + 10}px;line-height:20px;${other === 'lift' ? 'background:#dbeafe;color:#1e3a8a;border-radius:10px;padding:0 10px;' : ''}">${other === 'lift' ? 'Verified' : other === 'redact' ? 'jo@ex.io' : 'Open'}</div><div style="position:absolute;left:32px;top:120px;color:#6b7280">Status open</div></div>`);
    push('BK', `${other} lh${lh} ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true }, [{ kind: other, sel: '#w' }]);
    push('BK', `${other} lh${lh} nomark ${dpr}x`, dpr, html, '#v', { sel: '#v', firstText: true }, []);
  }
}

// The redact box in image px: the element's rect (or the first rect of its first text, or its first lines) grown by
// a px each side, then set off it as the scene says.
function boxFor(rect, { off, gap }, d) {
  const box = rect.map((v, i) => Math.round(v * d) + (i < 2 ? -1 : 2));
  const [bx, by, bw, bh] = box;
  switch (off) {
    case 'run7 above': return [bx, by - bh - 3 * d, bw, bh];
    case 'run7 left': return [bx - bw - 4 * d, by, bw, bh];
    case 'run7 inGap': return [bx, by + bh + 2 * d, bw, 18 * d];
    case 'run7 below2': return [bx, by - 6 * d - bh / 2, bw, bh / 2];
    case 'above': return [bx, by - 22 * d, bw, 20 * d];
    case 'aboveTight': return [bx, by - 12 * d, bw, 10 * d];
    case 'left': return [bx - 42 * d, by, 40 * d, bh];
    case 'right': return [bx + bw + 2 * d, by, 40 * d, bh];
    case 'inGap': return [bx, by + bh + d, bw, Math.max(4, (gap === 40 ? 36 : 20) * d)];
    default: return box;
  }
}

// Imports the scene's page, composes a board that redacts its value, and counts the value's pixels the board shows:
// each pixel inside the drawn frame whose centre, carried onto the board, lies under no rect the board paints.
export async function runBoardScene({ browser, renderer, scene }) {
  const home = await mkdtemp(path.join(tmpdir(), 'fb-attack-'));
  try {
    const paths = resolvePaths({ homeDir: home, pluginRoot: path.resolve('.') });
    const page = await browser.newPage({ viewport: { width: scene.viewport[0], height: scene.viewport[1] }, deviceScaleFactor: scene.dpr });
    let shown; let hidden; let box; let frame; let marks;
    try {
      await page.setContent(scene.html);
      const rectOf = (sel, firstText) => page.evaluate(({ sel, firstText }) => {
        const el = document.querySelector(sel);
        let b = el.getBoundingClientRect();
        if (firstText) { const range = document.createRange(); range.selectNodeContents(el.firstChild); b = range.getClientRects()[0]; }
        return [b.left, b.top, b.width, b.height];
      }, { sel, firstText });
      const at = await rectOf(scene.box.sel, scene.box.firstText);
      if (scene.box.firstLines) at[3] = 20 * scene.box.firstLines;
      box = boxFor(at, scene.box, scene.dpr);
      frame = (await rectOf('#frame')).map((v, i) => Math.round(v * scene.dpr) + (i < 2 ? -4 : 8));
      marks = await Promise.all((scene.marks ?? []).map(async (m) => ({ ...m, box: (await rectOf(m.sel)).map((v) => Math.round(v * scene.dpr)) })));
      shown = await page.screenshot({ type: 'png' });
      const glyphs = scene.value.split(',').map((s) => `${s},${s} *`).join(',');
      await page.addStyleTag({ content: `${glyphs}{color:transparent!important${scene.glyphs ? ';text-decoration-color:#111827!important' : ''}}` });
      hidden = await page.screenshot({ type: 'png' });
    } finally { await page.close(); }
    const shot = path.join(home, 'scene.png');
    await writeFile(shot, shown);
    const options = { paths, rendererLocation: async () => renderer };
    const { sidecar } = await compose({ command: 'compose', import: shot, out: 'scene.c1', origin: 'https://tracker.example/issues/1' }, options);
    const boxes = { value: box }; const specMarks = [{ redact: 'value' }];
    marks.forEach((m, i) => {
      boxes[`m${i}`] = m.box;
      specMarks.push(m.kind === 'redact' ? { redact: `m${i}` } : m.kind === 'lift' ? { lift: `m${i}`, title: 'Status' } : { [m.kind]: `m${i}` });
    });
    const spec = { state: 'FOUND', title: 'The record is set on the release task', layout: 'single', out: 'scene.png', panels: [{ capture: path.basename(sidecar), frame, boxes, marks: specMarks }] };
    const specPath = path.join(paths.screenshotsDir, 'scene.spec.json');
    await writeFile(specPath, JSON.stringify(spec));
    let layout;
    let warnings;
    try {
      ({ warnings } = await compose({ command: 'compose', spec: specPath }, { ...options, renderBoard: async (args) => { const r = await renderBoard(args); layout = r.report; return r; } }));
    } catch (error) {
      // A board refused for a redaction, or for a box the spec places outside its frame, is never written.
      if (error.name === 'LifecycleError' && /^a redaction on panel|^a redact mark on panel|has a box outside the frame/.test(error.message)) {
        return { set: scene.set, name: scene.name, refused: true, bare: await valueInk(browser, shown, hidden, null), warnings: [error.message] };
      }
      throw error;
    }
    const panel = layout.panels[0];
    // A glyph's antialiased edge reaches 2 CSS px past the element's box.
    const word = scene.word ? marks.filter((m) => m.kind === 'context').map(({ box: [x, y, w, h] }) => [x - 2 * scene.dpr, y - 2 * scene.dpr, w + 4 * scene.dpr, h + 4 * scene.dpr]) : [];
    const bare = await valueInk(browser, shown, hidden, { frame: panel.frame, capture: panel.capture, painted: panel.redactions.flatMap((r) => r.rects), word });
    return { set: scene.set, name: scene.name, refused: false, bare, warnings };
  } finally { await rm(home, { recursive: true, force: true }); }
}

// The value's pixels (more than 8 apart between the shown and hidden draws), or with `board` those the board shows,
// less those inside a box the driver marked context (`word`).
async function valueInk(browser, shown, hidden, board) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ shown, hidden, board }) => {
      const load = async (b64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [s, k] = await Promise.all([load(shown), load(hidden)]);
      const scale = board ? board.capture[2] / board.frame[2] : 1;
      let n = 0;
      for (let y = 0; y < s.height; y += 1) for (let x = 0; x < s.width; x += 1) {
        const a = (y * s.width + x) * 4;
        if (![0, 1, 2].some((c) => Math.abs(s.data[a + c] - k.data[a + c]) > 8)) continue;
        if (!board) { n += 1; continue; }
        const [fx, fy, fw, fh] = board.frame;
        if (x < fx || y < fy || x >= fx + fw || y >= fy + fh) continue;
        if (board.word.some(([wx, wy, ww, wh]) => x >= wx && y >= wy && x < wx + ww && y < wy + wh)) continue;
        const bx = board.capture[0] + (x + 0.5 - fx) * scale; const by = board.capture[1] + (y + 0.5 - fy) * scale;
        if (!board.painted.some(([rx, ry, rw, rh]) => bx >= rx && bx <= rx + rw && by >= ry && by <= ry + rh)) n += 1;
      }
      return n;
    }, { shown: shown.toString('base64'), hidden: hidden.toString('base64'), board });
  } finally { await page.close(); }
}
