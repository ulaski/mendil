// Every docs page as Markdown at the same address plus ".md", e.g. /mendil/reference/commands.md
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { markdownResponse, toMarkdown } from '../lib/markdown.mjs';

export const getStaticPaths: GetStaticPaths = async () =>
  (await getCollection('docs')).map((entry) => ({ params: { slug: entry.id }, props: { entry } }));

export const GET: APIRoute = ({ props }) => markdownResponse(toMarkdown(props.entry));
