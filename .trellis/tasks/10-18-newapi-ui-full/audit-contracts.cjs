const fs = require('fs');
const path = require('path');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const jsFiles = walk('public/js', []);
const htmlFiles = [];
(function htmlWalk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlWalk(full);
    else if (entry.name.endsWith('.html')) htmlFiles.push(full);
  }
})('views');

const htmlAll = htmlFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const jsAll = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');

// 1) data-* selectors queried from JS must still appear somewhere in the templates
//    (dynamic markup rendered by JS also counts).
const dataSelectors = new Set();
for (const js of jsFiles) {
  const src = fs.readFileSync(js, 'utf8');
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*['"`]\[(data-[a-z0-9-]+)[^\]]*['"`]/gi)) {
    dataSelectors.add(m[1]);
  }
}

const missingData = [];
for (const attr of [...dataSelectors].sort()) {
  const inTemplate = new RegExp(attr + '=').test(htmlAll);
  const inScript = new RegExp(attr + '=').test(jsAll);
  if (!inTemplate && !inScript) missingData.push(attr);
}

// 2) data-i18n keys referenced by templates must exist in the translation table
const i18nSrc = fs.readFileSync('public/js/shared/i18n.js', 'utf8');
const definedKeys = new Set();
for (const m of i18nSrc.matchAll(/'([a-z0-9_.]+)'\s*:/gi)) definedKeys.add(m[1]);

const usedKeys = new Set();
for (const m of htmlAll.matchAll(/data-i18n="([^"]+)"/g)) usedKeys.add(m[1]);
for (const m of jsAll.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/gi)) usedKeys.add(m[1]);

const missingKeys = [...usedKeys].filter(k => !definedKeys.has(k)).sort();

console.log('data-* selectors queried from JS :', dataSelectors.size);
console.log('  unresolved                    :', missingData.length ? missingData.join(', ') : 'none');
console.log('i18n keys used in views/js      :', usedKeys.size);
console.log('  defined in i18n.js            :', definedKeys.size);
console.log('  unresolved                    :', missingKeys.length ? missingKeys.join(', ') : 'none');

if (missingData.length || missingKeys.length) process.exitCode = 1;
