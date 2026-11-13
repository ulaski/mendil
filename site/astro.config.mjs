// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const repo = 'https://github.com/ulaski/mendil';

/**
 * Copies each table's column headings onto its cells as data-label, so on phones (where rows
 * stack and the header row is hidden) docs.css can say what each line is.
 */
function tableCellLabels() {
  const text = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(text).join(''));
  const walk = (node) => {
    if (node.tagName === 'table') {
      const rows = [];
      const collect = (n) => (n.tagName === 'tr' ? rows.push(n) : (n.children ?? []).forEach(collect));
      collect(node);
      const head = rows.find((r) => r.children.some((c) => c.tagName === 'th'));
      const labels = head ? head.children.filter((c) => c.tagName === 'th').map((c) => text(c).trim()) : [];
      for (const row of rows) {
        row.children.filter((c) => c.tagName === 'td').forEach((cell, i) => {
          if (labels[i]) cell.properties = { ...cell.properties, dataLabel: labels[i] };
        });
      }
    }
    (node.children ?? []).forEach(walk);
  };
  return (tree) => {
    walk(tree);
  };
}

// Served from GitHub Pages as a project site: https://ulaski.github.io/mendil/
export default defineConfig({
  site: 'https://ulaski.github.io',
  base: '/mendil',
  trailingSlash: 'always',
  markdown: { rehypePlugins: [tableCellLabels] },
  integrations: [
    starlight({
      title: 'Mendil',
      description: 'A self-hosted music bot for TeamSpeak 3 and 6. Write a song in chat and Mendil plays it in your channel.',
      logo: { src: './src/assets/logo.png', alt: 'Mendil' },
      favicon: '/favicon.ico',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      customCss: [
        '@fontsource-variable/archivo/wdth.css',
        '@fontsource/courier-prime/400.css',
        '@fontsource/courier-prime/700.css',
        './src/styles/docs.css',
      ],
      components: {
        PageTitle: './src/components/PageTitle.astro',
      },
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://ulaski.github.io/mendil/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/mendil/icon.png' } },
      ],
      sidebar: [
        { label: 'Start here', items: ['start/introduction', 'start/quick-start'] },
        {
          label: 'Guides',
          items: ['guides/your-server', 'guides/server-settings', 'guides/roles', 'guides/web-panel', 'guides/radio', 'guides/youtube', 'guides/updating'],
        },
        { label: 'Reference', items: ['reference/commands', 'reference/configuration'] },
        { label: 'Help', items: ['help/troubleshooting', 'help/faq'] },
        { label: 'Project', items: ['project/how-it-works', 'project/contributing', 'project/changelog', 'project/legal'] },
      ],
    }),
  ],
});
