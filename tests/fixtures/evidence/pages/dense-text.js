// Builds the dense activity page for dense-text.html and dense-text-dark.html: three columns of running
// sentences with a strip of tabs set among them, so no wide band of ground lies near a tab. Each page sets the
// line heights: a word space of ground between lines of a paragraph, none between lines of a tight one.
(function () {
  // Every few words reach below the line, so no line of a column leaves extra ground under it.
  const sentences = [
    'Paging by priority keeps the support group happy, and the triage policy is pinned up top.',
    'Typography gaps on the signup page were patched, apparently by copying the spacing grid.',
    'Grouping by owner played poorly on phones, so the display policy may pick a simpler layout.',
    'Every pending upgrade gets a ping, plus a reply typed up quickly by the deploy group.',
    'Spring planning surfaced a gap: the paging playbook skips the upgrade step for proxy jobs.',
    'Copy for the empty page now says why nothing is pending, quoting the policy plainly.',
    'Syncing jobs stopped piling up, though a gap in the query log may hide a typo again.',
    'Apply the spacing patch, then group pending replies by priority and ping anyone away.',
  ];
  const paragraph = (from, count, tight) => {
    const p = document.createElement('p');
    if (tight) p.className = 'tight';
    p.textContent = Array.from({ length: count }, (_, i) => sentences[(from + i) % sentences.length]).join(' ');
    return p;
  };
  const strip = (names, testid) => {
    const tabs = document.createElement('div'); tabs.className = 'tabs';
    for (const name of names) {
      const tab = document.createElement('span'); tab.className = 'tab'; tab.textContent = name;
      if (name === testid.label) tab.dataset.testid = testid.id;
      tabs.appendChild(tab);
    }
    return tabs;
  };
  const board = document.querySelector('[data-testid=activity]');
  // A tight paragraph leaves no row of ground between its lines; the others leave a word space.
  const columns = [
    [paragraph(0, 9), paragraph(3, 9, true)],
    [paragraph(1, 8), strip(['Overview', 'Activity', 'Files', 'Links'], { label: 'Activity', id: 'activity-tab' }), paragraph(5, 9, true)],
    [paragraph(2, 9, true), strip(['Open', 'Review', 'Done', 'All'], { label: 'Review', id: 'review-tab' }), paragraph(6, 7)],
  ];
  for (const parts of columns) {
    const column = document.createElement('div'); column.className = 'column';
    for (const part of parts) column.appendChild(part);
    board.appendChild(column);
  }
}());
