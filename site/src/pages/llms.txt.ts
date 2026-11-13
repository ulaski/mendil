// The llms.txt index (https://llmstxt.org): what Mendil is and where each docs page lives as Markdown.
import type { APIRoute } from 'astro';
import { SITE, markdownResponse, markdownUrl, orderedDocs } from '../lib/markdown.mjs';

export const GET: APIRoute = async () => {
  const lines = [
    '# Mendil',
    '',
    '> A self-hosted music bot for TeamSpeak 3 and 6. People type a song in the TeamSpeak chat (`!play <search or link>`) and Mendil plays it in the voice channel. It runs as one Docker container, with a queue, Spotify links, internet radio, admin/listener roles and a web panel. Open source, GPL-3.0.',
    '',
    `Every page is also available as Markdown (the links below). All of them in one file: ${SITE}llms-full.txt`,
    '',
  ];
  for (const group of await orderedDocs()) {
    lines.push(`## ${group.label}`, '');
    for (const e of group.entries) lines.push(`- [${e.data.title}](${markdownUrl(e.id)}): ${e.data.description ?? ''}`.trimEnd());
    lines.push('');
  }
  lines.push('## Optional', '', '- [Source code](https://github.com/ulaski/mendil): the repository on GitHub', '');
  return markdownResponse(lines.join('\n'), 'text/plain');
};
