// The docs' order, shared by the Starlight sidebar (astro.config.mjs) and llms.txt.
export const sidebar = [
  { label: 'Start here', items: ['start/introduction', 'start/quick-start'] },
  {
    label: 'Guides',
    items: ['guides/your-server', 'guides/server-settings', 'guides/roles', 'guides/web-panel', 'guides/radio', 'guides/youtube', 'guides/updating', 'guides/unraid', 'guides/pterodactyl'],
  },
  { label: 'Reference', items: ['reference/commands', 'reference/configuration'] },
  { label: 'Help', items: ['help/troubleshooting', 'help/faq'] },
  { label: 'Project', items: ['project/how-it-works', 'project/contributing', 'project/changelog', 'project/legal'] },
];
