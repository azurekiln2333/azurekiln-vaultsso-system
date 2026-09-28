const path = require('node:path');

const pages = Object.freeze({
  login: { file: 'auth/login.html', access: 'public' },
  mfa: { file: 'auth/mfa.html', access: 'pending-login' },
  error: { file: 'auth/error.html', access: 'public' },
  profile: { file: 'account/profile.html', access: 'account' },
  docs: { file: 'docs/api.html', access: 'public', url: '/api-docs.html' },
  admin: { file: 'admin/index.html', access: 'admin', url: '/admin.html' },
  clients: { file: 'admin/clients.html', access: 'admin', url: '/apps.html' },
  tokens: { file: 'admin/tokens.html', access: 'admin', url: '/tokens.html' },
  users: { file: 'admin/users.html', access: 'admin', url: '/users.html' },
  user: { file: 'admin/user.html', access: 'admin', url: '/user.html' },
  smtp: { file: 'admin/smtp.html', access: 'admin', url: '/smtp.html' },
  security: { file: 'admin/security.html', access: 'admin', url: '/security.html' },
  accountBindings: { file: 'admin/user-applications.html', access: 'admin', url: '/account-bindings.html' }
});

function pageFile(name) {
  const page = pages[name];
  if (!page) throw new Error(`Unknown page: ${name}`);
  return path.join(__dirname, page.file);
}

const adminPagePaths = new Map(Object.entries(pages)
  .filter(([, page]) => page.access === 'admin')
  .map(([name, page]) => [page.url, name]));

module.exports = { pages, pageFile, adminPagePaths };
