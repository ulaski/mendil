// All docs pages in sidebar order, as one Markdown file.
import type { APIRoute } from 'astro';
import { markdownResponse, orderedDocs, toMarkdown } from '../lib/markdown.mjs';

export const GET: APIRoute = async () => {
  const pages = (await orderedDocs()).flatMap((g) => g.entries).map(toMarkdown);
  return markdownResponse(pages.join('\n---\n\n'), 'text/plain');
};
