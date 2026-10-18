const fs = require('node:fs');
const path = require('node:path');

const viewsDir = 'views/admin';
const jsDir = 'public/js/pages/admin';
const pages = ['clients', 'security', 'smtp', 'tokens', 'user', 'users', 'user-applications'];

const views = {};
for (const file of fs.readdirSync(viewsDir)) {
  if (file.endsWith('.html')) views[file] = fs.readFileSync(path.join(viewsDir, file), 'utf8');
}

const referenced = new Map();
for (const file of fs.readdirSync(jsDir)) {
  const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
  for (const match of source.matchAll(/getElementById\('([^']+)'\)/g)) referenced.set(match[1], file);
  for (const match of source.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) referenced.set(match[1], file);
}

const missing = [];
for (const [id, owner] of referenced) {
  const found = Object.values(views).some(html => html.includes(`id="${id}"`));
  if (!found) missing.push(`${id} (${owner})`);
}

let problems = 0;
for (const page of pages) {
  const html = views[`${page}.html`] || '';
  const counts = {
    h1: (html.match(/<h1\b/g) || []).length,
    hr: (html.match(/<hr\b/g) || []).length,
    footer: (html.match(/<footer\b/g) || []).length,
    bigRadius: (html.match(/rounded-(?:xl|2xl|3xl)\b/g) || []).length,
    panelBody: (html.match(/napi-panel-body/g) || []).length
  };
  if (!html) continue;
  const body = html.split('<body')[1]?.split('</body>')[0] || '';
  const stack = [];
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  let structured = true;
  for (const m of body.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi)) {
    const name = m[1].toLowerCase();
    if (voids.has(name) || m[2] === '/') continue;
    if (!m[0].startsWith('</')) stack.push(name);
    else if (stack.pop() !== name) structured = false;
  }
  if (stack.length || !structured) problems++;
  console.log(page.padEnd(18), JSON.stringify(counts), structured && !stack.length ? 'structure=ok' : 'structure=BROKEN');
}

console.log('\nids referenced by admin js:', referenced.size);
console.log('ids missing from any admin page:', missing.length ? missing.join(', ') : 'none');
process.exitCode = missing.length || problems ? 1 : 0;
