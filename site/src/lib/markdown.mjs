// Docs pages as plain Markdown, for people who paste them into an AI assistant and for agents
// (llms.txt). Links become absolute and the few HTML bits become text, so a page still makes
// sense outside the site.
import { getCollection } from 'astro:content';
import { sidebar } from './sidebar.mjs';

export const SITE = 'https://ulaski.github.io/mendil/';

export const pageUrl = (id) => `${SITE}${id}/`;
export const markdownUrl = (id) => `${SITE}${id}.md`;

/** All docs entries in sidebar order. */
export async function orderedDocs() {
  const entries = new Map((await getCollection('docs')).map((e) => [e.id, e]));
  return sidebar.map((group) => ({
    label: group.label,
    entries: group.items.map((id) => entries.get(id)).filter(Boolean),
  }));
}

export function toMarkdown(entry) {
  const base = pageUrl(entry.id);
  const body = (entry.body ?? '')
    // the "admin" marker on the commands page
    .replace(/<span class="admin-tag">admin<\/span>/g, '(admin)')
    // relative links -> absolute, so they work wherever the text ends up
    .replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_, target) => `](${new URL(target, base).href})`)
    .replace(/\]\(#([^)\s]+)\)/g, (_, anchor) => `](${base}#${anchor})`)
    .trim();
  const lines = [`# ${entry.data.title}`, ''];
  if (entry.data.description) lines.push(`> ${entry.data.description}`, '');
  lines.push(`Source: ${base}`, '', body, '');
  return lines.join('\n');
}

export const markdownResponse = (text, type = 'text/markdown') =>
  new Response(text, { headers: { 'Content-Type': `${type}; charset=utf-8` } });
