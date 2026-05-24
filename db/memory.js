function clone(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date();
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function likeValue(value, pattern) {
  return String(value || '').toLowerCase() === String(pattern || '').toLowerCase();
}

class MemoryConnection {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params = []) {
    return this.pool.execute(sql, params);
  }

  release() {}
}

class MemoryPool {
  constructor() {
    this.users = [];
    this.clients = [];
    this.authCodes = [];
    this.accessTokens = [];
    this.refreshTokens = [];
  }

  async getConnection() {
    return new MemoryConnection(this);
  }

  async query(sql, params = []) {
    return this.execute(sql, params);
  }

  async execute(sql, params = []) {
    const normalized = normalizeSql(sql);
    const lower = normalized.toLowerCase();

    if (lower.startsWith('create table') || lower.startsWith('alter table')) {
      return [{ affectedRows: 0 }, []];
    }

    if (lower.startsWith('show columns from')) {
      return [[{ Field: params[0] }], []];
    }

    if (lower === 'select count(*) as total from users where role = ?') {
      return [[{ total: this.users.filter(user => user.role === params[0]).length }], []];
    }

    if (lower === 'select id, email from users where role = ? limit 1') {
      return [this.users.filter(user => user.role === params[0]).slice(0, 1).map(user => clone(user)), []];
    }

    if (lower === 'select id, email from users where lower(email) = ? limit 1') {
      return [this.users.filter(user => likeValue(user.email, params[0])).slice(0, 1).map(user => clone(user)), []];
    }

    if (lower === 'select id, email from users order by created_at asc, id asc limit 1') {
      return [this.users.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, 1).map(user => clone(user)), []];
    }

    if (lower === 'insert into users (id, username, email, password, name, avatar, email_verified, role) values (?, ?, ?, ?, ?, ?, ?, ?)') {
      const [id, username, email, password, name, avatar, emailVerified, role] = params;
      const createdAt = now();
      this.users.push({
        id,
        username,
        email,
        password,
        name,
        avatar,
        email_verified: Boolean(emailVerified),
        role,
        created_at: createdAt,
        updated_at: createdAt
      });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from users where id = ?') {
      return [this.users.filter(user => user.id === params[0]).map(user => clone(user)), []];
    }

    if (lower === 'select * from users where username = ? or email = ?') {
      return [this.users.filter(user => user.username === params[0] || user.email === params[1]).map(user => clone(user)), []];
    }

    if (lower === 'select * from users where email = ?') {
      return [this.users.filter(user => user.email === params[0]).map(user => clone(user)), []];
    }

    if (lower === 'select id, username, email, name, avatar, email_verified, role, created_at from users') {
      return [this.users.map(user => clone(user)), []];
    }

    if (lower === 'update users set password = ? where id = ?') {
      return [this.updateRows(this.users, row => row.id === params[1], row => {
        row.password = params[0];
        row.updated_at = now();
      }), []];
    }

    if (lower === 'update users set role = ? where id = ?') {
      return [this.updateRows(this.users, row => row.id === params[1], row => {
        row.role = params[0];
        row.updated_at = now();
      }), []];
    }

    if (lower.startsWith('update users set ') && lower.endsWith(' where id = ?')) {
      return [this.updateDynamic(this.users, normalized, params, 'id'), []];
    }

    if (lower === 'delete from users where id = ?') {
      return [this.deleteRows(this.users, row => row.id === params[0]), []];
    }

    if (lower === 'insert into clients (id, name, secret, redirect_uris, scopes, logo_url, is_active) values (?, ?, ?, ?, ?, ?, ?)') {
      const [id, name, secret, redirectUris, scopes, logoUrl, isActive] = params;
      const createdAt = now();
      this.clients.push({
        id,
        name,
        secret,
        redirect_uris: redirectUris,
        scopes,
        logo_url: logoUrl,
        is_active: Boolean(isActive),
        created_at: createdAt,
        updated_at: createdAt
      });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from clients where id = ?') {
      return [this.clients.filter(client => client.id === params[0]).map(client => clone(client)), []];
    }

    if (lower === 'select * from clients order by created_at desc') {
      return [this.clients.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(client => clone(client)), []];
    }

    if (lower.startsWith('update clients set ') && lower.endsWith(' where id = ?')) {
      return [this.updateDynamic(this.clients, normalized, params, 'id'), []];
    }

    if (lower === 'delete from clients where id = ?') {
      const clientId = params[0];
      const result = this.deleteRows(this.clients, row => row.id === clientId);
      this.authCodes = this.authCodes.filter(row => row.client_id !== clientId);
      this.accessTokens = this.accessTokens.filter(row => row.client_id !== clientId);
      this.refreshTokens = this.refreshTokens.filter(row => row.client_id !== clientId);
      return [result, []];
    }

    if (lower === 'insert into access_tokens (id, token, user_id, client_id, scopes, expires_at) values (?, ?, ?, ?, ?, ?)') {
      const [id, token, userId, clientId, scopes, expiresAt] = params;
      this.accessTokens.push({
        id,
        token,
        user_id: userId,
        client_id: clientId,
        scopes,
        expires_at: expiresAt,
        created_at: now()
      });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from access_tokens where id = ?') {
      return [this.accessTokens.filter(token => token.id === params[0]).map(token => clone(token)), []];
    }

    if (lower === 'select * from access_tokens where token = ?') {
      return [this.accessTokens.filter(token => token.token === params[0]).map(token => clone(token)), []];
    }

    if (lower === 'select * from access_tokens where user_id = ? order by created_at desc') {
      return [this.accessTokens.filter(token => token.user_id === params[0]).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(token => clone(token)), []];
    }

    if (lower.startsWith('select at.*, u.name as user_name')) {
      const rows = this.accessTokens
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(token => {
          const user = this.users.find(row => row.id === token.user_id);
          const client = this.clients.find(row => row.id === token.client_id);
          return {
            ...clone(token),
            user_name: user?.name || null,
            user_email: user?.email || null,
            client_name: client?.name || null
          };
        });
      return [rows, []];
    }

    if (lower === 'delete from access_tokens where id = ?') {
      return [this.deleteRows(this.accessTokens, row => row.id === params[0]), []];
    }

    if (lower === 'delete from access_tokens where user_id = ?') {
      return [this.deleteRows(this.accessTokens, row => row.user_id === params[0]), []];
    }

    if (lower === 'insert into refresh_tokens (id, token, user_id, client_id, scopes, expires_at) values (?, ?, ?, ?, ?, ?)') {
      const [id, token, userId, clientId, scopes, expiresAt] = params;
      this.refreshTokens.push({
        id,
        token,
        user_id: userId,
        client_id: clientId,
        scopes,
        expires_at: expiresAt,
        created_at: now()
      });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from refresh_tokens where id = ?') {
      return [this.refreshTokens.filter(token => token.id === params[0]).map(token => clone(token)), []];
    }

    if (lower === 'select * from refresh_tokens where token = ?') {
      return [this.refreshTokens.filter(token => token.token === params[0]).map(token => clone(token)), []];
    }

    if (lower === 'delete from refresh_tokens where id = ?') {
      return [this.deleteRows(this.refreshTokens, row => row.id === params[0]), []];
    }

    if (lower === 'insert into auth_codes (code, user_id, client_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)') {
      const [code, userId, clientId, redirectUri, scopes, codeChallenge, codeChallengeMethod, expiresAt] = params;
      this.authCodes.push({
        code,
        user_id: userId,
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        expires_at: expiresAt,
        created_at: now()
      });
      return [{ affectedRows: 1, insertId: code }, []];
    }

    if (lower === 'select * from auth_codes where code = ?') {
      return [this.authCodes.filter(code => code.code === params[0]).map(code => clone(code)), []];
    }

    if (lower === 'delete from auth_codes where code = ?') {
      return [this.deleteRows(this.authCodes, row => row.code === params[0]), []];
    }

    if (lower === 'delete from access_tokens where expires_at < ?') {
      return [this.deleteRows(this.accessTokens, row => new Date(row.expires_at) < new Date(params[0])), []];
    }

    if (lower === 'delete from refresh_tokens where expires_at < ?') {
      return [this.deleteRows(this.refreshTokens, row => new Date(row.expires_at) < new Date(params[0])), []];
    }

    if (lower === 'delete from auth_codes where expires_at < ?') {
      return [this.deleteRows(this.authCodes, row => new Date(row.expires_at) < new Date(params[0])), []];
    }

    throw new Error(`Memory DB does not support SQL: ${normalized}`);
  }

  updateRows(rows, predicate, updater) {
    let affectedRows = 0;
    rows.forEach(row => {
      if (predicate(row)) {
        updater(row);
        affectedRows += 1;
      }
    });
    return { affectedRows };
  }

  deleteRows(rows, predicate) {
    const before = rows.length;
    const kept = rows.filter(row => !predicate(row));
    rows.splice(0, rows.length, ...kept);
    return { affectedRows: before - rows.length };
  }

  updateDynamic(rows, sql, params, idColumn) {
    const setPart = sql.slice(sql.toLowerCase().indexOf(' set ') + 5, sql.toLowerCase().lastIndexOf(' where '));
    const assignments = setPart.split(',').map(part => part.trim());
    const targetId = params[params.length - 1];
    const updates = assignments.map((assignment, index) => ({
      column: assignment.split('=')[0].trim(),
      value: params[index]
    }));

    return this.updateRows(rows, row => row[idColumn] === targetId, row => {
      updates.forEach(update => {
        row[update.column] = update.value;
      });
      row.updated_at = now();
    });
  }

  async end() {}
}

function createMemoryPool() {
  return new MemoryPool();
}

module.exports = {
  createMemoryPool
};
