async (page, args) => {
  const { maxLinks = 10 } = args || {};
  const headings = await page.getByRole('heading').allTextContents();
  const links = await page.getByRole('link').evaluateAll((nodes, limit) =>
    nodes.slice(0, limit).map(node => ({
      name: (node.textContent || '').trim(),
      href: node.getAttribute('href') || '',
    })), maxLinks);
  return {
    url: page.url(),
    title: await page.title(),
    headings: headings.slice(0, 10),
    links,
  };
}
