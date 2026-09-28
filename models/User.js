const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { normalizePhone, normalizeParts, toE164, DEFAULT_COUNTRY_CODE } = require('../services/phone');

const USER_ROLE_ADMIN = 'admin';
const USER_ROLE_USER = 'user';

// 手机号只有经过归一化才允许落库，否则 phone_e164 唯一键形同虚设。
// 返回 undefined 表示本次不修改手机号，返回 null 表示解绑。
function resolvePhone(userData) {
  const hasInput = userData.phone !== undefined
    || userData.phoneCountryCode !== undefined
    || userData.phoneNumber !== undefined;
  if (!hasInput) return undefined;

  const countryCode = String(userData.phoneCountryCode ?? '').trim();
  const input = String(userData.phone ?? userData.phoneNumber ?? '').trim();
  if (!input) return null;

  const fullNumber = userData.phone !== undefined || /^\+|^00/.test(input);
  const normalized = fullNumber
    ? normalizePhone(input, countryCode || DEFAULT_COUNTRY_CODE)
    : normalizeParts(countryCode || DEFAULT_COUNTRY_CODE, input);
  if (!normalized) throw new Error('Invalid phone number');
  return normalized;
}

class UserModel {
  constructor(pool) {
    this.pool = pool;
  }

  normalizeRole(role) {
    return String(role || '').trim().toLowerCase() === USER_ROLE_ADMIN
      ? USER_ROLE_ADMIN
      : USER_ROLE_USER;
  }

  async pickDefaultRole(requestedRole) {
    return this.normalizeRole(requestedRole);
  }

  async create(userData) {
    const id = crypto.randomUUID();
    // Empty password means "not set yet": the user must verify email and set one before signing in.
    const hashedPassword = userData.password ? await bcrypt.hash(userData.password, 12) : '';
    const role = await this.pickDefaultRole(userData.role);

    const createdAt = userData.createdAt && !Number.isNaN(new Date(userData.createdAt).getTime())
      ? new Date(userData.createdAt)
      : new Date();
    const updatedAt = userData.updatedAt && !Number.isNaN(new Date(userData.updatedAt).getTime())
      ? new Date(userData.updatedAt)
      : createdAt;

    const phone = resolvePhone(userData) || null;
    const phoneVerified = Boolean(userData.phoneVerified) && Boolean(phone);

    await this.pool.execute(
      `INSERT INTO users (id, username, email, password, name, avatar, description, email_verified, banned, credits, last_login_ip, phone_country_code, phone_number, phone_verified, phone_verified_at, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userData.username,
        userData.email,
        hashedPassword,
        userData.name || null,
        userData.avatar || null,
        userData.description || null,
        userData.emailVerified || false,
        userData.banned || false,
        Number.isFinite(Number(userData.credits)) ? Number(userData.credits) : 0,
        userData.lastLoginIp || null,
        phone ? phone.countryCode : null,
        phone ? phone.nationalNumber : null,
        phoneVerified,
        phoneVerified ? (userData.phoneVerifiedAt || new Date()) : null,
        role,
        createdAt,
        updatedAt
      ]
    );

    return this.findById(id);
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM users WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  }

  async findByUsername(username) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, username]
    );
    return rows.length === 1 ? rows[0] : null;
  }

  async findPotentialConflicts(username, email) {
    const [rows] = await this.pool.execute(
      'SELECT id, username, email FROM users WHERE username IN (?, ?) OR email IN (?, ?)',
      [username, email, username, email]
    );
    return rows;
  }

  async findByEmail(email) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );
    return rows[0] || null;
  }

  async findAll() {
    const [rows] = await this.pool.execute(
      'SELECT id, username, email, name, avatar, description, email_verified, banned, credits, last_login_ip, phone_country_code, phone_number, phone_e164, phone_verified, role, created_at, updated_at FROM users'
    );
    return rows;
  }

  // 唯一键建立在 E.164 上，因此查找前必须先归一化。
  async findByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    const [rows] = await this.pool.execute(
      'SELECT * FROM users WHERE phone_e164 = ?',
      [normalized.e164]
    );
    return rows[0] || null;
  }

  async update(id, userData) {
    const fields = [];
    const values = [];
    
    if (userData.name !== undefined) {
      fields.push('name = ?');
      values.push(userData.name);
    }
    if (userData.username !== undefined) {
      fields.push('username = ?');
      values.push(userData.username);
    }
    if (userData.email !== undefined) {
      fields.push('email = ?');
      values.push(userData.email);
    }
    if (userData.avatar !== undefined) {
      fields.push('avatar = ?');
      values.push(userData.avatar);
    }
    if (userData.emailVerified !== undefined) {
      fields.push('email_verified = ?');
      values.push(userData.emailVerified);
    }
    if (userData.banned !== undefined) {
      fields.push('banned = ?');
      values.push(userData.banned);
    }
    if (userData.description !== undefined) {
      fields.push('description = ?');
      values.push(userData.description);
    }
    if (userData.credits !== undefined) {
      fields.push('credits = ?');
      values.push(userData.credits);
    }
    if (userData.lastLoginIp !== undefined) {
      fields.push('last_login_ip = ?');
      values.push(userData.lastLoginIp);
    }
    if (userData.totpSecret !== undefined) {
      fields.push('totp_secret = ?');
      values.push(userData.totpSecret);
    }
    if (userData.totpEnabled !== undefined) {
      fields.push('totp_enabled = ?');
      values.push(userData.totpEnabled);
    }
    if (userData.totpRevision !== undefined) {
      fields.push('totp_revision = ?');
      values.push(userData.totpRevision);
    }
    if (userData.recoveryCodes !== undefined) {
      fields.push('recovery_codes = ?');
      values.push(userData.recoveryCodes);
    }
    if (userData.captchaRequired !== undefined) {
      fields.push('captcha_required = ?');
      values.push(userData.captchaRequired);
    }
    if (userData.role !== undefined) {
      fields.push('role = ?');
      values.push(this.normalizeRole(userData.role));
    }

    const phone = resolvePhone(userData);
    if (phone !== undefined) {
      const current = await this.findById(id);
      const unchanged = Boolean(phone && current && phone.e164 === toE164(current.phone_country_code, current.phone_number));
      const verified = Boolean(phone && (userData.phoneVerified !== undefined ? userData.phoneVerified : unchanged && current.phone_verified));
      const verifiedAt = verified
        ? (userData.phoneVerifiedAt || (unchanged && current.phone_verified_at) || new Date())
        : null;
      fields.push('phone_country_code = ?', 'phone_number = ?', 'phone_verified = ?', 'phone_verified_at = ?');
      // 换号或解绑都会让此前的验证状态失效，必须一并重置。
      values.push(
        phone ? phone.countryCode : null,
        phone ? phone.nationalNumber : null,
        verified,
        verifiedAt
      );
    } else if (userData.phoneVerified !== undefined) {
      const verified = Boolean(userData.phoneVerified);
      fields.push('phone_verified = ?');
      values.push(verified);
      fields.push('phone_verified_at = ?');
      values.push(verified ? (userData.phoneVerifiedAt || new Date()) : null);
    }

    if (fields.length === 0) return this.findById(id);
    
    values.push(id);
    await this.pool.execute(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    
    const updated = await this.findById(id);
    if (phone !== undefined && (
      !updated
      || (updated.phone_country_code || '') !== (phone?.countryCode || '')
      || (updated.phone_number || '') !== (phone?.nationalNumber || '')
      || (updated.phone_e164 || '') !== (phone?.e164 || '')
    )) {
      throw Object.assign(new Error('Phone update did not persist'), { code: 'PHONE_UPDATE_NOT_PERSISTED' });
    }
    return updated;
  }

  async updatePassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.pool.execute(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, id]
    );
    return true;
  }

  async bindPhoneIfEmpty(id, phone, verified) {
    const normalized = normalizeParts(phone.countryCode, phone.nationalNumber);
    if (!normalized) throw new Error('Invalid phone number');
    const [result] = await this.pool.execute(
      `UPDATE users SET phone_country_code = ?, phone_number = ?, phone_verified = ?, phone_verified_at = ?
       WHERE id = ? AND phone_e164 IS NULL`,
      [normalized.countryCode, normalized.nationalNumber, Boolean(verified), verified ? new Date() : null, id]
    );
    return result.affectedRows === 1;
  }

  async verifyPhoneIfUnchanged(id, phoneE164) {
    const [result] = await this.pool.execute(
      'UPDATE users SET phone_verified = TRUE, phone_verified_at = ? WHERE id = ? AND phone_e164 = ? AND phone_verified = FALSE',
      [new Date(), id, phoneE164]
    );
    return result.affectedRows === 1;
  }

  async verifyPassword(user, password) {
    return bcrypt.compare(password, user.password);
  }

  async consumeTotpCounter(id, counter) {
    const [result] = await this.pool.execute(
      'UPDATE users SET totp_last_counter = ? WHERE id = ? AND totp_last_counter < ?',
      [counter, id, counter]
    );
    return result.affectedRows === 1;
  }

  async stageTotpSecret(id, secret) {
    const [result] = await this.pool.execute(
      'UPDATE users SET totp_secret = ?, totp_last_counter = -1 WHERE id = ? AND totp_enabled = FALSE', [secret, id]
    );
    return result.affectedRows === 1;
  }

  async enableTotp(id, secret, recoveryCodes) {
    const [result] = await this.pool.execute(
      'UPDATE users SET totp_enabled = TRUE, recovery_codes = ? WHERE id = ? AND totp_secret = ? AND totp_enabled = FALSE',
      [recoveryCodes, id, secret]
    );
    return result.affectedRows === 1;
  }

  async consumeRecoveryCode(id, previous, next) {
    const [result] = await this.pool.execute(
      'UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?',
      [next, id, previous]
    );
    return result.affectedRows === 1;
  }

  async delete(id) {
    await this.pool.execute('DELETE FROM users WHERE id = ?', [id]);
    return true;
  }
}

module.exports = UserModel;
