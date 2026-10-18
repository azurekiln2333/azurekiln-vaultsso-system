const fs = require('fs');
const path = require('path');

const pairs = [
  ['public/js/pages/admin/users.js', 'views/admin/users.html'],
  ['public/js/pages/admin/clients.js', 'views/admin/clients.html'],
  ['public/js/pages/admin/security.js', 'views/admin/security.html'],
  ['public/js/pages/admin/smtp.js', 'views/admin/smtp.html'],
  ['public/js/pages/admin/tokens.js', 'views/admin/tokens.html'],
  ['public/js/pages/admin/user.js', 'views/admin/user.html'],
  ['public/js/pages/admin/user-applications.js', 'views/admin/user-applications.html'],
  ['public/js/pages/account/profile.js', 'views/account/profile.html'],
  ['public/js/pages/account/authenticators.js', 'views/account/profile.html'],
  ['public/js/pages/auth/mfa.js', 'views/auth/mfa.html'],
  ['public/js/pages/auth/login.js', 'views/auth/login.html'],
  ['public/js/pages/auth/error.js', 'views/auth/error.html']
];

let failures = 0;

for (const [jsFile, htmlFile] of pairs) {
  if (!fs.existsSync(jsFile) || !fs.existsSync(htmlFile)) {
    console.log('SKIP'.padEnd(6), jsFile, '(missing)');
    continue;
  }
  const js = fs.readFileSync(jsFile, 'utf8');
  const html = fs.readFileSync(htmlFile, 'utf8');

  const ids = [...new Set([...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]))];
  const missing = ids.filter(id => !new RegExp(`id=["']${id}["']`).test(html));

  if (missing.length) failures += missing.length;
  console.log(
    path.basename(jsFile).padEnd(24),
    ('ids=' + ids.length).padStart(7),
    missing.length ? 'MISSING: ' + missing.join(', ') : 'all present'
  );
}

console.log(failures ? `\nFAILED: ${failures} missing id(s)` : '\nAll getElementById targets resolve.');
