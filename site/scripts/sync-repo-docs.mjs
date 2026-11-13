// Copies CONTRIBUTING.md and CHANGELOG.md into the docs, and the logo and demo recording into
// the site's assets, so the repo's own files stay the only source. Runs before every build and
// dev start; the copies are git-ignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(site, '..');
const GH = 'https://github.com/ulaski/mendil/blob/main/';
const out = path.join(site, 'src/content/docs/project');

const pages = [
  { from: 'CONTRIBUTING.md', to: 'contributing.md', title: 'Contributing', description: 'Reporting bugs, running the tests, translating Mendil and sending pull requests.' },
  { from: 'CHANGELOG.md', to: 'changelog.md', title: 'Changelog', description: 'What changed in each release.' },
];

for (const p of pages) {
  let text = fs.readFileSync(path.join(repo, p.from), 'utf8');
  text = text.replace(/^# .*\n+/, ''); // the page title comes from frontmatter
  // Links to other repo files point at GitHub; the site has no copies of them.
  text = text.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, target) => `](${GH}${target.replace(/^\.\//, '')})`);
  const frontmatter = `---\ntitle: ${JSON.stringify(p.title)}\ndescription: ${JSON.stringify(p.description)}\neditUrl: ${GH.replace('/blob/', '/edit/')}${p.from}\n---\n\n`;
  fs.writeFileSync(path.join(out, p.to), frontmatter + text);
}
for (const asset of ['logo.png', 'demo.gif']) {
  fs.copyFileSync(path.join(repo, 'docs/assets', asset), path.join(site, 'src/assets', asset));
}
console.log('synced CONTRIBUTING.md, CHANGELOG.md, logo.png and demo.gif');
