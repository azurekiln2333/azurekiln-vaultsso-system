const fs = require('fs');
const path = require('path');

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.html')) files.push(full);
  }
})('views');

const results = [];
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const ids = [...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const h1 = (html.match(/<h1/g) || []).length;
  const footer = (html.match(/<footer/g) || []).length;
  if (dupes.length || h1 > 1 || footer > 0) {
    results.push({ file, dupes: [...new Set(dupes)], h1, footer });
  }
}

console.log('Templates scanned:', files.length);
if (!results.length) {
  console.log('No duplicate ids, no multi-h1, no <footer> in views.');
} else {
  for (const r of results) {
    console.log(
      r.file.padEnd(46),
      'dupeIds=' + (r.dupes.join(',') || '-'),
      'h1=' + r.h1,
      'footer=' + r.footer
    );
  }
}
