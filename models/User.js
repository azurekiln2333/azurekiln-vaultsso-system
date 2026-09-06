const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const USER_ROLE_ADMIN = 'admin';
const USER_ROLE_USER = 'user';

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
    if (requestedRole !== undefined && requestedRole !== null && String(requestedRole).trim()) {
      return this.normalizeRole(requestedRole);
    }

    const normalizedRole = this.normalizeRole(requestedRole);
    if (normalizedRole === USER_ROLE_ADMIN) {
      return USER_ROLE_ADMIN;
    }

    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) AS total FROM users WHERE role = ?',
      [USER_ROLE_ADMIN]
    );

    return Number(rows[0]?.total || 0) === 0 ? USER_ROLE_ADMIN : USER_ROLE_USER;
  }

  async create(userData) {
    const id = crypto.randomUUID();
    // Empty password means "not set yet": the user must verify email and set one before signing in.
    const hashedPassword = userData.password ? await bcrypt.hash(userData.password, 10) : '';
    const role = await this.pickDefaultRole(userData.role);

    const createdAt = userData.createdAt && !Number.isNaN(new Date(userData.createdAt).getTime())
      ? new Date(userData.createdAt)
      : new Date();
    const updatedAt = userData.updatedAt && !Number.isNaN(new Date(userData.updatedAt).getTime())
      ? new Date(userData.updatedAt)
      : createdAt;

    const [result] = await this.pool.execute(
      `INSERT INTO users (id, username, email, password, name, avatar, description, email_verified, banned, credits, last_login_ip, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return rows[0] || null;
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
      'SELECT id, username, email, name, avatar, description, email_verified, banned, credits, last_login_ip, role, created_at, updated_at FROM users'
    );
    return rows;
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
    if (userData.role !== undefined) {
      fields.push('role = ?');
      values.push(this.normalizeRole(userData.role));
    }
    
    if (fields.length === 0) return this.findById(id);
    
    values.push(id);
    await this.pool.execute(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    
    return this.findById(id);
  }

  async updatePassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.pool.execute(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, id]
    );
    return true;
  }

  async verifyPassword(user, password) {
    return bcrypt.compare(password, user.password);
  }

  async delete(id) {
    await this.pool.execute('DELETE FROM users WHERE id = ?', [id]);
    return true;
  }
}

module.exports = UserModel;
