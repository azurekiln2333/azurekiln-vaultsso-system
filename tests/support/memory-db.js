// Test-only SQL adapter. Never imported by the application or its database initializer.
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

function rowKey(row) {
  return row.id ?? row.code ?? row.provider_key ?? row.setting_key ?? row.rate_key
    ?? (row.user_id && row.client_id ? JSON.stringify([row.user_id, row.client_id]) : undefined);
}

function assertUniqueRows(rows, keyOf, message) {
  const keys = rows.map(keyOf).filter(key => key !== null);
  if (new Set(keys).size !== keys.length) {
    throw Object.assign(new Error(message), { code: 'ER_DUP_ENTRY' });
  }
}

function assertUserUniqueness(rows) {
  assertUniqueRows(rows, row => row.username.toLowerCase(), 'Duplicate username');
  assertUniqueRows(rows, row => row.email.toLowerCase(), 'Duplicate email');
  assertUniqueRows(rows, row => row.phone_e164 || null, 'Duplicate phone_e164');
}

function assertIdentityUniqueness(rows) {
  assertUniqueRows(rows, row => JSON.stringify([row.provider, row.provider_user_id]), 'Duplicate identity');
  assertUniqueRows(rows, row => row.provider_secondary_id ? JSON.stringify([row.provider, row.provider_secondary_id]) : null, 'Duplicate secondary identity');
}

class MemoryConnection {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params = []) {
    if (normalizeSql(sql).toLowerCase() === 'select get_lock(?, 10) as acquired') {
      let lock = this.pool.namedLocks.get(params[0]);
      if (!lock) {
        lock = { owner: this, waiters: [] };
        this.pool.namedLocks.set(params[0], lock);
      } else if (lock.owner !== this) {
        await new Promise(resolve => lock.waiters.push({ connection: this, resolve }));
      }
      return [[{ acquired: 1 }], []];
    }
    if (normalizeSql(sql).toLowerCase() === 'select release_lock(?) as released') {
      const lock = this.pool.namedLocks.get(params[0]);
      if (!lock || lock.owner !== this) return [[{ released: 0 }], []];
      const next = lock.waiters.shift();
      if (next) { lock.owner = next.connection; next.resolve(); }
      else this.pool.namedLocks.delete(params[0]);
      return [[{ released: 1 }], []];
    }
    return this.execute(sql, params);
  }

  async execute(sql, params = []) { return (this.transactionPool || this.pool).execute(sql, params); }

  async beginTransaction() {
    this.transactionPool = new MemoryPool();
    this.snapshot = {};
    for (const key of Object.keys(this.pool)) {
      if (!Array.isArray(this.pool[key])) continue;
      this.snapshot[key] = clone(this.pool[key]);
      this.transactionPool[key] = clone(this.pool[key]);
    }
  }

  async commit() {
    if (!this.transactionPool) return;
    const merged = {};
    // Apply only this connection's writes so overlapping transactions keep unrelated commits.
    for (const key of Object.keys(this.snapshot)) {
      const before = new Map(this.snapshot[key].map(row => [rowKey(row), row]));
      const after = new Map(this.transactionPool[key].map(row => [rowKey(row), row]));
      const changed = new Set([...before.keys(), ...after.keys()].filter(id => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))));
      merged[key] = this.pool[key].filter(row => !changed.has(rowKey(row)));
      merged[key].push(...[...changed].filter(id => after.has(id)).map(id => after.get(id)));
    }
    assertUserUniqueness(merged.users);
    assertIdentityUniqueness(merged.userIdentities);
    for (const key of Object.keys(merged)) this.pool[key].splice(0, this.pool[key].length, ...merged[key]);
    this.transactionPool = null;
    this.snapshot = null;
  }

  async rollback() {
    this.transactionPool = null;
    this.snapshot = null;
  }
  destroy() { this.release(); }

  release() {}
}

class MemoryPool {
  constructor() {
    this.namedLocks = new Map();
    this.users = [];
    this.clients = [];
    this.authCodes = [];
    this.accessTokens = [];
    this.refreshTokens = [];
    this.emailVerificationCodes = [];
    this.userIdentities = [];
    this.userAppUsage = [];
    this.userAuthenticators = [];
    this.settings = [];
    this.oidcProviders = [];
    this.loginLogs = [];
    this.sessions = [];
    this.rateLimits = [];
    this.captchas = [];
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

    if (lower === 'select * from users where id = ? for update') {
      return [this.users.filter(row => row.id === params[0]).map(clone), []];
    }
    if (lower === 'select * from users where id in (?, ?) order by id for update') {
      return [this.users.filter(row => params.includes(row.id)).slice()
        .sort((a, b) => a.id.localeCompare(b.id)).map(clone), []];
    }
    if (lower === 'select * from user_authenticators where user_id = ? order by created_at, id') {
      return [this.userAuthenticators.filter(row => row.user_id === params[0]).slice()
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id.localeCompare(b.id)).map(clone), []];
    }
    if (lower.startsWith('insert into user_authenticators ')) {
      const [id, userId, name, secret, sessionId, securityState, expiresAt, legacySetup] = params;
      this.userAuthenticators.push({ id, user_id: userId, name, secret, session_id: sessionId,
        security_state: securityState, expires_at: expiresAt, legacy_setup: legacySetup,
        attempts: 0, activated_at: null, last_counter: -1, last_used_at: null, created_at: now() });
      return [{ affectedRows: 1 }, []];
    }
    if (lower === 'update user_authenticators set attempts = attempts + 1 where id = ? and activated_at is null') {
      return [this.updateRows(this.userAuthenticators, row => row.id === params[0] && !row.activated_at, row => { row.attempts++; }), []];
    }
    if (lower === 'update user_authenticators set activated_at = ?, last_counter = ?, last_used_at = ?, session_id = null, security_state = null, expires_at = null where id = ? and activated_at is null') {
      return [this.updateRows(this.userAuthenticators, row => row.id === params[3] && !row.activated_at, row => {
        row.activated_at = params[0]; row.last_counter = params[1]; row.last_used_at = params[2];
        row.session_id = null; row.security_state = null; row.expires_at = null;
      }), []];
    }
    if (lower === 'update user_authenticators set last_counter = ?, last_used_at = ? where id = ? and activated_at is not null and last_counter < ?') {
      return [this.updateRows(this.userAuthenticators, row => row.id === params[2] && row.activated_at && row.last_counter < params[3], row => {
        row.last_counter = params[0]; row.last_used_at = params[1];
      }), []];
    }
    if (lower === 'delete from user_authenticators where user_id = ? and id = ?') {
      return [this.deleteRows(this.userAuthenticators, row => row.user_id === params[0] && row.id === params[1]), []];
    }
    if (lower === 'delete from user_authenticators where user_id = ? and activated_at is null') {
      return [this.deleteRows(this.userAuthenticators, row => row.user_id === params[0] && !row.activated_at), []];
    }
    if (lower === 'delete from user_authenticators where user_id = ?') {
      return [this.deleteRows(this.userAuthenticators, row => row.user_id === params[0]), []];
    }

    if (lower.startsWith('insert into user_app_usage ') && lower.includes(' values (?, ?, ?, ?, ?)')) {
      const [userId, clientId, clientName, firstUsedAt, lastUsedAt] = params;
      if (!this.users.some(row => row.id === userId)) throw Object.assign(new Error('Unknown user'), { code: 'ER_NO_REFERENCED_ROW_2' });
      this.upsertAppUsage({ user_id: userId, client_id: clientId, client_name: clientName, first_used_at: firstUsedAt, last_used_at: lastUsedAt });
      return [{ affectedRows: 1 }, []];
    }
    if (lower.startsWith('insert into user_app_usage ') && lower.includes('select evidence.user_id')) {
      for (const token of [...this.accessTokens, ...this.refreshTokens]) {
        const client = this.clients.find(row => row.id === token.client_id);
        if (!token.user_id || !client || !this.users.some(row => row.id === token.user_id)) continue;
        this.upsertAppUsage({ user_id: token.user_id, client_id: client.id, client_name: client.name,
          first_used_at: token.created_at, last_used_at: token.created_at }, false);
      }
      return [{ affectedRows: 1 }, []];
    }
    if (lower === 'select * from user_app_usage where user_id = ? order by last_used_at desc, client_id asc'
        || lower === 'select * from user_app_usage where user_id = ? order by last_used_at desc, client_id asc for update') {
      return [this.userAppUsage.filter(row => row.user_id === params[0]).slice()
        .sort((a, b) => new Date(b.last_used_at) - new Date(a.last_used_at) || a.client_id.localeCompare(b.client_id)).map(clone), []];
    }
    if (lower === 'select * from user_app_usage order by user_id asc, last_used_at desc, client_id asc') {
      return [this.userAppUsage.slice().sort((a, b) => a.user_id.localeCompare(b.user_id)
        || new Date(b.last_used_at) - new Date(a.last_used_at) || a.client_id.localeCompare(b.client_id)).map(clone), []];
    }

    if (lower === 'insert into captcha_challenges (id, answer_hash, expires_at) values (?, ?, ?)') {
      this.captchas.push({ id: params[0], answer_hash: params[1], expires_at: params[2] });
      return [{ affectedRows: 1 }, []];
    }
    if (lower === 'select * from captcha_challenges where id = ?') {
      return [this.captchas.filter(row => row.id === params[0]).map(clone), []];
    }
    if (lower === 'delete from captcha_challenges where id = ? and expires_at > ?') {
      return [this.deleteRows(this.captchas, row => row.id === params[0] && new Date(row.expires_at) > new Date(params[1])), []];
    }
    if (lower === 'delete from captcha_challenges where expires_at < ?') {
      return [this.deleteRows(this.captchas, row => new Date(row.expires_at) < new Date(params[0])), []];
    }

    if (lower.startsWith('insert into rate_limits ')) {
      const [key, expiry, currentTime] = params;
      let row = this.rateLimits.find(item => item.rate_key === key);
      if (!row) {
        row = { rate_key: key, hits: 1, expires_at: expiry };
        this.rateLimits.push(row);
      } else if (new Date(row.expires_at) <= new Date(currentTime)) {
        row.hits = 1;
        row.expires_at = expiry;
      } else row.hits += 1;
      return [{ affectedRows: 1 }, []];
    }
    if (lower === 'select hits, expires_at from rate_limits where rate_key = ?') {
      return [this.rateLimits.filter(row => row.rate_key === params[0]).map(clone), []];
    }
    if (lower === 'delete from rate_limits where rate_key = ?') {
      return [this.deleteRows(this.rateLimits, row => row.rate_key === params[0]), []];
    }
    if (lower === 'delete from rate_limits where expires_at < ?') {
      return [this.deleteRows(this.rateLimits, row => new Date(row.expires_at) < new Date(params[0])), []];
    }
    if (lower === 'update users set totp_last_counter = ? where id = ? and totp_last_counter < ?') {
      return [this.updateRows(this.users, row => row.id === params[1] && row.totp_last_counter < params[2], row => { row.totp_last_counter = params[0]; }), []];
    }
    if (lower === 'update users set totp_secret = ?, totp_last_counter = -1 where id = ? and totp_enabled = false') {
      return [this.updateRows(this.users, row => row.id === params[1] && !row.totp_enabled, row => { row.totp_secret = params[0]; row.totp_last_counter = -1; }), []];
    }
    if (lower === 'update users set totp_enabled = true, recovery_codes = ? where id = ? and totp_secret = ? and totp_enabled = false') {
      return [this.updateRows(this.users, row => row.id === params[1] && row.totp_secret === params[2] && !row.totp_enabled, row => { row.totp_enabled = true; row.recovery_codes = params[0]; }), []];
    }
    if (lower === 'update users set recovery_codes = ? where id = ? and recovery_codes = ?') {
      return [this.updateRows(this.users, row => row.id === params[1] && row.recovery_codes === params[2], row => { row.recovery_codes = params[0]; }), []];
    }
    if (lower === 'update sessions set expires_at = ? where id = ? and revoked_at is null and expires_at > ?') {
      return [this.updateRows(this.sessions, row => row.id === params[1] && !row.revoked_at && new Date(row.expires_at) > new Date(params[2]), row => { row.expires_at = params[0]; }), []];
    }
    const tokenDeletion = lower.match(/^delete from (access_tokens|refresh_tokens|auth_codes) where (id|code|user_id|client_id) = \?( and expires_at > \?)?$/);
    if (tokenDeletion) {
      const tables = { access_tokens: this.accessTokens, refresh_tokens: this.refreshTokens, auth_codes: this.authCodes };
      return [this.deleteRows(tables[tokenDeletion[1]], row => row[tokenDeletion[2]] === params[0]
        && (!tokenDeletion[3] || new Date(row.expires_at) > new Date(params[1]))), []];
    }

    if (lower.startsWith('create table') || lower.startsWith('alter table')) {
      return [{ affectedRows: 0 }, []];
    }

    if (lower === 'insert into user_identities (id, user_id, provider, provider_user_id, provider_secondary_id, provider_username, display_name, avatar, email, profile) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') {
      const [id, userId, provider, providerUserId, providerSecondaryId, providerUsername, displayName, avatar, email, profile] = params;
      if (this.userIdentities.some(row => row.provider === provider && row.provider_user_id === providerUserId)) {
        throw Object.assign(new Error('Duplicate identity'), { code: 'ER_DUP_ENTRY' });
      }
      if (providerSecondaryId && this.userIdentities.some(row => row.provider === provider && row.provider_secondary_id === providerSecondaryId)) {
        throw Object.assign(new Error('Duplicate secondary identity'), { code: 'ER_DUP_ENTRY' });
      }
      const createdAt = now();
      this.userIdentities.push({
        id,
        user_id: userId,
        provider,
        provider_user_id: providerUserId,
        provider_secondary_id: providerSecondaryId || null,
        provider_username: providerUsername,
        display_name: displayName,
        avatar,
        email,
        profile,
        created_at: createdAt,
        updated_at: createdAt
      });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from user_identities where id = ?') {
      return [this.userIdentities.filter(identity => identity.id === params[0]).map(identity => clone(identity)), []];
    }

    if (lower === 'select * from user_identities order by user_id asc, created_at asc') {
      return [this.userIdentities.slice().sort((a, b) => a.user_id.localeCompare(b.user_id) || new Date(a.created_at) - new Date(b.created_at)).map(clone), []];
    }

    if (lower.startsWith('select * from user_identities where provider in (')) {
      return [this.userIdentities.filter(row => params.includes(row.provider)).map(clone), []];
    }

    if (lower === 'select * from user_identities where provider = ? and provider_user_id = ?') {
      return [this.userIdentities.filter(identity => identity.provider === params[0] && identity.provider_user_id === params[1]).map(identity => clone(identity)), []];
    }

    if (lower === 'select * from user_identities where provider = ? and provider_secondary_id = ?') {
      return [this.userIdentities.filter(identity => identity.provider === params[0] && identity.provider_secondary_id === params[1]).map(identity => clone(identity)), []];
    }

    if (lower === 'select * from user_identities where user_id = ? order by created_at asc'
        || lower === 'select * from user_identities where user_id = ? order by created_at asc for update') {
      return [this.userIdentities.filter(identity => identity.user_id === params[0]).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(identity => clone(identity)), []];
    }
    if (lower === 'update user_identities set user_id = ? where id = ?') {
      return [this.updateRows(this.userIdentities, row => row.id === params[1], row => { row.user_id = params[0]; }), []];
    }

    if (lower.startsWith('update user_identities set ') && lower.endsWith(' where id = ?')) {
      return [this.updateDynamic(this.userIdentities, normalized, params, 'id'), []];
    }

    if (lower === 'delete from user_identities where id = ?') {
      return [this.deleteRows(this.userIdentities, row => row.id === params[0]), []];
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

    if (lower === 'insert into users (id, username, email, password, name, avatar, description, email_verified, banned, credits, last_login_ip, phone_country_code, phone_number, phone_verified, phone_verified_at, role, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') {
      const [id, username, email, password, name, avatar, description, emailVerified, banned, credits, lastLoginIp, phoneCountryCode, phoneNumber, phoneVerified, phoneVerifiedAt, role, createdAtParam, updatedAtParam] = params;
      const phoneE164 = phoneCountryCode && phoneNumber ? `+${phoneCountryCode}${phoneNumber}` : null;
      if (this.users.some(row => likeValue(row.username, username) || likeValue(row.email, email) || (phoneE164 && row.phone_e164 === phoneE164))) {
        throw Object.assign(new Error('Duplicate user'), { code: 'ER_DUP_ENTRY' });
      }
      const createdAt = createdAtParam ? new Date(createdAtParam).toISOString() : now();
      const updatedAt = updatedAtParam ? new Date(updatedAtParam).toISOString() : createdAt;
      this.users.push({
        id,
        username,
        email,
        password,
        name,
        avatar,
        description,
        email_verified: Boolean(emailVerified),
        banned: Boolean(banned),
        totp_secret: null,
        totp_enabled: false,
        totp_last_counter: -1,
        totp_revision: 0,
        captcha_required: false,
        recovery_codes: null,
        credits: Number(credits) || 0,
        last_login_ip: lastLoginIp,
        phone_country_code: phoneCountryCode || null,
        phone_number: phoneNumber || null,
        phone_e164: phoneCountryCode && phoneNumber ? `+${phoneCountryCode}${phoneNumber}` : null,
        phone_verified: Boolean(phoneVerified),
        phone_verified_at: phoneVerifiedAt || null,
        role,
        created_at: createdAt,
        updated_at: updatedAt
      });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from users where id = ?') {
      return [this.users.filter(user => user.id === params[0]).map(user => clone(user)), []];
    }

    if (lower === 'select * from users where username = ? or email = ?') {
      return [this.users.filter(user => likeValue(user.username, params[0]) || likeValue(user.email, params[1])).map(user => clone(user)), []];
    }

    if (lower === 'select id, username, email from users where username in (?, ?) or email in (?, ?)') {
      return [this.users.filter(user => params.some(value => likeValue(user.username, value) || likeValue(user.email, value))).map(clone), []];
    }

    if (lower === 'select * from users where email = ?') {
      return [this.users.filter(user => user.email === params[0]).map(user => clone(user)), []];
    }

    if (lower === 'select id, username, email, name, avatar, description, email_verified, banned, credits, last_login_ip, phone_country_code, phone_number, phone_e164, phone_verified, role, created_at, updated_at from users') {
      return [this.users.map(user => clone(user)), []];
    }

    if (lower === 'select * from users where phone_e164 = ?') {
      return [this.users.filter(user => user.phone_e164 === params[0]).map(user => clone(user)), []];
    }

    if (lower === 'update users set phone_country_code = ?, phone_number = ?, phone_verified = ?, phone_verified_at = ? where id = ? and phone_e164 is null') {
      const candidates = clone(this.users);
      const result = this.updateRows(candidates, row => row.id === params[4] && row.phone_e164 === null, row => {
        [row.phone_country_code, row.phone_number, row.phone_verified, row.phone_verified_at] = params;
        row.phone_verified = Boolean(row.phone_verified);
        row.phone_e164 = `+${row.phone_country_code}${row.phone_number}`;
        row.updated_at = now();
      });
      assertUserUniqueness(candidates);
      this.users.splice(0, this.users.length, ...candidates);
      return [result, []];
    }

    if (lower === 'update users set phone_verified = true, phone_verified_at = ? where id = ? and phone_e164 = ? and phone_verified = false') {
      return [this.updateRows(this.users, row => row.id === params[1] && row.phone_e164 === params[2] && !row.phone_verified, row => {
        row.phone_verified = true;
        row.phone_verified_at = params[0];
        row.updated_at = now();
      }), []];
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
      const candidates = clone(this.users);
      const result = this.updateDynamic(candidates, normalized, params, 'id');
      // phone_e164 在 MySQL 中是生成列，内存适配器需要同步维护。
      candidates.forEach(user => {
        user.phone_e164 = user.phone_country_code && user.phone_number
          ? `+${user.phone_country_code}${user.phone_number}`
          : null;
      });
      assertUserUniqueness(candidates);
      this.users.splice(0, this.users.length, ...candidates);
      return [result, []];
    }

    if (lower === 'delete from users where id = ?') {
      const userId = params[0];
      const result = this.deleteRows(this.users, row => row.id === userId);
      this.emailVerificationCodes = this.emailVerificationCodes.filter(row => row.user_id !== userId);
      this.authCodes = this.authCodes.filter(row => row.user_id !== userId);
      this.accessTokens = this.accessTokens.filter(row => row.user_id !== userId);
      this.refreshTokens = this.refreshTokens.filter(row => row.user_id !== userId);
      this.userIdentities = this.userIdentities.filter(row => row.user_id !== userId);
      this.userAppUsage = this.userAppUsage.filter(row => row.user_id !== userId);
      this.userAuthenticators = this.userAuthenticators.filter(row => row.user_id !== userId);
      this.sessions = this.sessions.filter(row => row.user_id !== userId);
      return [result, []];
    }

    if (lower === 'insert into email_verification_codes (id, email, user_id, purpose, code_hash, expires_at, pending_context) values (?, ?, ?, ?, ?, ?, ?)') {
      const [id, email, userId, purpose, codeHash, expiresAt, pendingContext] = params;
      this.emailVerificationCodes.push({
        id,
        email,
        user_id: userId,
        purpose,
        code_hash: codeHash,
        pending_context: pendingContext === null ? null : JSON.parse(pendingContext),
        attempts: 0,
        consumed_at: null,
        expires_at: expiresAt,
        created_at: now()
      });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from email_verification_codes where id = ?') {
      return [this.emailVerificationCodes.filter(row => row.id === params[0]).map(row => clone(row)), []];
    }

    if (lower === 'insert into sessions (id, user_id, token, ip_address, user_agent, expires_at) values (?, ?, ?, ?, ?, ?)') {
      const [id, userId, token, ip, userAgent, expiresAt] = params;
      this.sessions.push({ id, user_id: userId, token, ip_address: ip, user_agent: userAgent, revoked_at: null, expires_at: new Date(expiresAt).toISOString(), created_at: now() });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from sessions where token = ? and revoked_at is null and expires_at > ?') {
      return [this.sessions.filter(row => row.token === params[0] && !row.revoked_at && new Date(row.expires_at) > new Date()).map(clone), []];
    }

    if (lower.startsWith('select id, user_id, token, ip_address, user_agent, created_at, expires_at from sessions where user_id = ? and revoked_at is null and expires_at > ? order by created_at desc')) {
      const rows = this.sessions
        .filter(row => row.user_id === params[0] && !row.revoked_at && new Date(row.expires_at) > new Date())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(clone);
      return [rows, []];
    }

    if (lower === 'select * from sessions where id = ?' || lower === 'select * from sessions where id = ? for update') {
      return [this.sessions.filter(row => row.id === params[0]).map(clone), []];
    }
    if (lower === 'select * from sessions where id = ? and user_id = ? for update') {
      return [this.sessions.filter(row => row.id === params[0] && row.user_id === params[1]).map(clone), []];
    }

    if (lower === 'select * from users where id in (?, ?) order by id for update') {
      return [this.users.filter(row => params.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id)).map(clone), []];
    }

    if (lower === 'select * from user_identities where user_id = ? order by created_at asc for update') {
      return [this.userIdentities.filter(row => row.user_id === params[0])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(clone), []];
    }

    if (lower === 'select * from user_app_usage where user_id = ? order by last_used_at desc, client_id asc for update') {
      return [this.userAppUsage.filter(row => row.user_id === params[0])
        .sort((a, b) => new Date(b.last_used_at) - new Date(a.last_used_at)).map(clone), []];
    }

    if (lower === 'update sessions set revoked_at = ? where id = ?') {
      return [this.updateRows(this.sessions, row => row.id === params[1], row => { row.revoked_at = new Date(params[0]).toISOString(); }), []];
    }

    if (lower === 'update sessions set revoked_at = ? where user_id = ? and revoked_at is null and id <> ?') {
      return [this.updateRows(this.sessions, row => row.user_id === params[1] && !row.revoked_at && row.id !== params[2], row => { row.revoked_at = new Date(params[0]).toISOString(); }), []];
    }

    if (lower === 'update sessions set revoked_at = ? where user_id = ? and revoked_at is null') {
      return [this.updateRows(this.sessions, row => row.user_id === params[1] && !row.revoked_at, row => { row.revoked_at = new Date(params[0]).toISOString(); }), []];
    }

    if (lower === 'delete from sessions where expires_at < ?') {
      const result = this.deleteRows(this.sessions, row => new Date(row.expires_at) < new Date());
      return [result, []];
    }

    if (lower === 'select setting_value from settings where setting_key = ?') {
      return [this.settings.filter(row => row.setting_key === params[0]).map(row => ({ setting_value: row.setting_value })), []];
    }

    if (lower === 'select * from oidc_providers order by provider_key asc') {
      return [this.oidcProviders.slice().sort((a, b) => a.provider_key.localeCompare(b.provider_key)).map(clone), []];
    }

    if (lower === 'select * from oidc_providers where provider_key = ?') {
      return [this.oidcProviders.filter(row => row.provider_key === params[0]).map(clone), []];
    }

    if (lower.startsWith('insert into oidc_providers')) {
      const [providerKey, providerName, providerType, enabled, clientId, clientSecret, issuerUrl, discoveryUrl, authorizeUrl, tokenUrl, userinfoUrl, jwksUrl, scopes, tokenAuthMethod, clockTolerance, allowedAlgorithms, pkceEnabled, validateIdToken, requireEmailVerified, userinfoEmailPath, emailVerifiedPath, userinfoIdPath, userinfoSecondaryIdPath, userinfoUsernamePath, userinfoMethod, userinfoTokenIn, frontendCallbackPath, huaweiUnionScope] = params;
      const existing = this.oidcProviders.find(row => row.provider_key === providerKey);
      const values = { provider_key: providerKey, provider_name: providerName, provider_type: providerType, enabled: Boolean(enabled), client_id: clientId, client_secret: clientSecret, issuer_url: issuerUrl, discovery_url: discoveryUrl, authorize_url: authorizeUrl, token_url: tokenUrl, userinfo_url: userinfoUrl, jwks_url: jwksUrl, scopes, token_auth_method: tokenAuthMethod, clock_tolerance: clockTolerance, allowed_algorithms: allowedAlgorithms, pkce_enabled: Boolean(pkceEnabled), validate_id_token: Boolean(validateIdToken), require_email_verified: Boolean(requireEmailVerified), userinfo_email_path: userinfoEmailPath, email_verified_path: emailVerifiedPath, userinfo_id_path: userinfoIdPath, userinfo_secondary_id_path: userinfoSecondaryIdPath, userinfo_username_path: userinfoUsernamePath, userinfo_method: userinfoMethod, userinfo_token_in: userinfoTokenIn, frontend_callback_path: frontendCallbackPath, created_at: existing?.created_at || now(), updated_at: now() };
      values.huawei_union_scope = huaweiUnionScope || '';
      if (existing) Object.assign(existing, values); else this.oidcProviders.push(values);
      return [{ affectedRows: 1, insertId: providerKey }, []];
    }

    if (lower === 'delete from oidc_providers where provider_key = ?') {
      return [this.deleteRows(this.oidcProviders, row => row.provider_key === params[0]), []];
    }

    if (lower.startsWith('insert into settings (setting_key, setting_value) values ')) {
      for (let index = 0; index < params.length; index += 2) {
        const [key, value] = params.slice(index, index + 2);
        const existing = this.settings.find(row => row.setting_key === key);
        if (existing) {
          existing.setting_value = value;
          existing.updated_at = now();
        } else {
          this.settings.push({ setting_key: key, setting_value: value, updated_at: now() });
        }
      }
      return [{ affectedRows: 1, insertId: 0 }, []];
    }

    if (lower === 'insert into login_logs (id, username, user_id, ip, user_agent, result, detail) values (?, ?, ?, ?, ?, ?, ?)') {
      const [id, username, userId, ip, userAgent, result, detail] = params;
      this.loginLogs.push({ id, username, user_id: userId, ip, user_agent: userAgent, result, detail, created_at: now() });
      return [{ affectedRows: 1, insertId: id }, []];
    }

    if (lower === 'select * from login_logs where id = ?') {
      return [this.loginLogs.filter(row => row.id === params[0]).map(clone), []];
    }

    if (lower.startsWith("select id, username, user_id, ip, user_agent, result, detail, created_at from login_logs where user_id = ? and created_at > ? order by created_at desc")) {
      const since = new Date(params[1]).getTime();
      const rows = this.loginLogs
        .filter(row => row.user_id === params[0] && new Date(row.created_at).getTime() > since)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(clone);
      return [rows, []];
    }

    if (lower.startsWith('select id, username, user_id, ip, user_agent, result, detail, created_at from login_logs order by created_at desc limit')) {
      const limit = Math.max(1, Number(params[0]) || 50);
      const rows = this.loginLogs.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit).map(clone);
      return [rows, []];
    }

    if (lower === 'select * from email_verification_codes where email = ? and purpose = ? and consumed_at is null and expires_at > ? order by created_at desc limit 1') {
      const [email, purpose, currentTime] = params;
      return [
        this.emailVerificationCodes
          .filter(row => row.email === email && row.purpose === purpose && !row.consumed_at && new Date(row.expires_at) > new Date(currentTime))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 1)
          .map(row => clone(row)),
        []
      ];
    }

    if (lower === 'update email_verification_codes set attempts = attempts + 1 where id = ? and consumed_at is null and attempts < ? and expires_at > ?') {
      return [this.updateRows(this.emailVerificationCodes, row => row.id === params[0] && !row.consumed_at && row.attempts < params[1] && new Date(row.expires_at) > new Date(params[2]), row => {
        row.attempts = Number(row.attempts || 0) + 1;
      }), []];
    }

    if (lower === 'update email_verification_codes set consumed_at = ? where id = ? and consumed_at is null and expires_at > ?') {
      return [this.updateRows(this.emailVerificationCodes, row => row.id === params[1] && !row.consumed_at && new Date(row.expires_at) > new Date(params[2]), row => {
        row.consumed_at = params[0];
      }), []];
    }

    if (lower === 'update email_verification_codes set consumed_at = ? where email = ? and purpose = ? and consumed_at is null') {
      return [this.updateRows(this.emailVerificationCodes, row => row.email === params[1] && row.purpose === params[2] && !row.consumed_at, row => { row.consumed_at = params[0]; }), []];
    }

    if (lower === 'delete from email_verification_codes where expires_at < ? or consumed_at is not null') {
      const currentTime = params[0];
      return [this.deleteRows(this.emailVerificationCodes, row => new Date(row.expires_at) < new Date(currentTime) || Boolean(row.consumed_at)), []];
    }
    if (lower === 'delete from email_verification_codes where user_id = ?') {
      return [this.deleteRows(this.emailVerificationCodes, row => row.user_id === params[0]), []];
    }

    if (lower === 'insert into clients (id, name, secret, redirect_uris, scopes, logo_url, is_active, require_pkce) values (?, ?, ?, ?, ?, ?, ?, ?)') {
      const [id, name, secret, redirectUris, scopes, logoUrl, isActive, requirePkce] = params;
      const createdAt = now();
      this.clients.push({
        id,
        name,
        secret,
        redirect_uris: redirectUris,
        scopes,
        logo_url: logoUrl,
        is_active: Boolean(isActive),
        require_pkce: Boolean(requirePkce),
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

    if (lower === 'insert into auth_codes (code, user_id, client_id, redirect_uri, scopes, code_challenge, code_challenge_method, nonce, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)') {
      const [code, userId, clientId, redirectUri, scopes, codeChallenge, codeChallengeMethod, nonce, expiresAt] = params;
      this.authCodes.push({
        code,
        user_id: userId,
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        nonce,
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

  upsertAppUsage(data, updateName = true) {
    const existing = this.userAppUsage.find(row => row.user_id === data.user_id && row.client_id === data.client_id);
    if (!existing) this.userAppUsage.push(clone(data));
    else {
      if (updateName) existing.client_name = data.client_name;
      if (new Date(data.first_used_at) < new Date(existing.first_used_at)) existing.first_used_at = clone(data.first_used_at);
      if (new Date(data.last_used_at) > new Date(existing.last_used_at)) existing.last_used_at = clone(data.last_used_at);
    }
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
