// 手机号挑战的持久化适配器。
//
// 明确复用既有的 email_verification_codes 表（与 MFA 验证码、登录邮箱门共享），
// 不新增表、不做 schema 迁移：
// - purpose 使用 phone_* 命名空间：phone_sms_login / phone_sms_verify / phone_h5_login；
// - 旧 email 列存“命名空间键”（key(phone, purpose) 的摘要），不是真实邮箱；
// - pending_context 存服务端自有的上下文（规范化号码、用户、用途、OAuth 参数、时长）；
// - code_hash 存一次性的随机挑战绑定摘要，绝不落库明文验证码或上游令牌。
//
// 复用既有 SQL 语义：attempts 条件自增、consume 一次性、expires_at 过期与
// invalidate 按命名空间批量失效，保证与邮箱验证码一致的生命周期。
//
// 调用契约（给 p5 路由/MFA 层）：
//   SMS 登录      create({ phone, purpose: 'phone_sms_login', context, expiresAt })
//   本人号码校验  create({ phone, purpose: 'phone_sms_verify', userId, context, expiresAt })
//   H5 令牌阶段    create({ ref, purpose: 'phone_h5_login', context, expiresAt })
//                 —— 此时号码未知，用不透明 ref（由调用方生成，≤128 位 [A-Za-z0-9_-]）
//   H5 完成阶段    create({ phone, purpose: 'phone_h5_login', context, expiresAt })
//                 —— spToken 换回号码后才建立可登录的挑战
//   create() 返回的 `binding` 是明文，仅用于调用方在下发/比对时使用；库中只有摘要。
//   按号码失效用 invalidate(phone, purpose)，按不透明槽位失效用 invalidateRef(ref, purpose)。

'use strict';

const crypto = require('node:crypto');
const { withActiveAccount } = require('../services/account-write');
const phoneNumbers = require('../services/phone');

const PURPOSES = Object.freeze({
  SMS_LOGIN: 'phone_sms_login',
  SMS_VERIFY: 'phone_sms_verify',
  H5_LOGIN: 'phone_h5_login'
});

const SUPPORTED_PURPOSES = Object.freeze(Object.values(PURPOSES));

// 命名空间键必须可安全写入 VARCHAR(255) 的 email 列，且不能与真实邮箱形态混淆。
const KEY_PREFIX = 'phone-challenge:';

function canonicalPhone(phone) {
  if (typeof phone === 'string' && phone.trim()) {
    const normalized = phoneNumbers.normalizePhone(phone);
    if (normalized) return normalized.e164;
  }
  return '';
}

// purpose 只允许本适配器声明的三态，避免与邮箱/MFA 用途串号。
function normalizePurpose(purpose) {
  const text = String(purpose || '').trim();
  return SUPPORTED_PURPOSES.includes(text) ? text : '';
}

// 随机挑战绑定：库中只保存摘要，明文只回传给具有服务端上下文的调用方。
function hashBinding(binding) {
  return crypto.createHash('sha256').update(`phone-challenge-binding:${binding}`).digest('hex');
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 不透明挑战标识：只接受非空字符串，限长以避免被当成大对象塞入库。
function normalizeRef(ref) {
  if (typeof ref !== 'string') return '';
  const text = ref.trim();
  if (!text || text.length > 128 || !/^[A-Za-z0-9_-]+$/.test(text)) return '';
  return text;
}

class PhoneChallengeModel {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 命名空间键：同一号码 + 同一用途共享槽位，用于按号码失效旧挑战。
   * 号码先规范化，避免同一号码的不同写法互相绕过。
   *
   * H5 一键登录在发令牌阶段还没有号码（号码要等 spToken 换回才知道），
   * 此时由调用方传入一个不透明的 `ref`，见 opaqueKey()。
   */
  static key(phone, purpose) {
    const e164 = canonicalPhone(phone);
    const namespace = normalizePurpose(purpose) || 'phone_unknown';
    const digest = crypto
      .createHash('sha256')
      .update(`${namespace}:${e164}`)
      .digest('hex');
    return `${KEY_PREFIX}${namespace}:${digest}`;
  }

  /**
   * 不透明槽位键：用于尚未知道号码的阶段（phone_h5_login 的令牌签发）。
   * `ref` 只存摘要，库中不落原始挑战标识。
   */
  static opaqueKey(ref, purpose) {
    const namespace = normalizePurpose(purpose) || 'phone_unknown';
    const seed = normalizeRef(ref);
    const digest = crypto
      .createHash('sha256')
      .update(`${namespace}:ref:${seed}`)
      .digest('hex');
    return `${KEY_PREFIX}${namespace}:${digest}`;
  }

  static purposes() {
    return SUPPORTED_PURPOSES;
  }

  /**
   * 创建挑战。
   * code 缺失时生成一个随机绑定，返回值额外带 `binding` 供调用方在下发时比对。
   *
   * 号码要求按用途区分：
   * - phone_sms_login / phone_sms_verify 必须有规范化号码；
   * - phone_h5_login 在令牌阶段号码未知，改为接受不透明的 `ref`，绝不伪造号码。
   */
  async create({ phone, purpose, userId = null, context = null, expiresAt, code = null, ref = null } = {}) {
    const namespace = normalizePurpose(purpose);
    if (!namespace) throw new Error('Unsupported phone challenge purpose');
    const expiry = asDate(expiresAt);
    if (!expiry) throw new Error('Invalid phone challenge expiry');

    const e164 = canonicalPhone(phone);
    const isH5 = namespace === PURPOSES.H5_LOGIN;
    let email;
    if (isH5) {
      // H5：号码此刻不存在，只能用不透明 ref 定位槽位。
      const seed = normalizeRef(ref);
      if (!seed) throw new Error('Invalid phone challenge reference');
      email = PhoneChallengeModel.opaqueKey(seed, namespace);
    } else {
      if (!e164) throw new Error('Invalid phone challenge target');
      email = PhoneChallengeModel.key(e164, namespace);
    }

    const binding = code ? String(code) : crypto.randomBytes(16).toString('base64url');
    const codeHash = hashBinding(binding);
    // phone 只在真实已知时写入，H5 令牌阶段不得把占位值当成号码存库。
    const payload = {
      ...(context && typeof context === 'object' && !Array.isArray(context) ? context : {}),
      ...(e164 ? { phone: e164 } : {}),
      purpose: namespace
    };

    return withActiveAccount(this.pool, userId, async database => {
      const id = crypto.randomUUID();
      await database.execute(
        `INSERT INTO email_verification_codes (id, email, user_id, purpose, code_hash, expires_at, pending_context)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, email, userId || null, namespace, codeHash, expiry, JSON.stringify(payload)]
      );
      const row = await new PhoneChallengeModel(database).findById(id);
      return row ? { ...row, binding } : { ...payload, id, binding, code_hash: codeHash, expires_at: expiry };
    });
  }

  // 读回统一成既有蛇形字段 + 解析后的 context。
  // MySQL 的 JSON 列与 memory-db 可能直接把对象交回来，只有字符串才需要 parse。
  decorate(row) {
    if (!row) return null;
    let context = {};
    const raw = row.pending_context;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      context = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) context = parsed;
      } catch {
        context = {};
      }
    }
    return { ...row, context };
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM email_verification_codes WHERE id = ? AND purpose LIKE ?',
      [String(id || ''), 'phone_%']
    );
    return this.decorate(rows[0] || null);
  }

  // 与邮箱验证码同语义：仅未消费且未过期时命中最新一条。
  async findLatestActive(phone, purpose, now = new Date()) {
    const namespace = normalizePurpose(purpose);
    if (!namespace) return null;
    const [rows] = await this.pool.execute(
      `SELECT * FROM email_verification_codes
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [PhoneChallengeModel.key(phone, namespace), namespace, now]
    );
    return this.decorate(rows[0] || null);
  }

  async incrementAttempts(id, maxAttempts) {
    const [result] = await this.pool.execute(
      'UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ? AND purpose LIKE ? AND consumed_at IS NULL AND attempts < ? AND expires_at > ?',
      [String(id || ''), 'phone_%', maxAttempts, new Date()]
    );
    return result.affectedRows === 1;
  }

  // 一次性消费：条件更新，只有第一名成功者得到 true。
  async consume(id) {
    const [result] = await this.pool.execute(
      'UPDATE email_verification_codes SET consumed_at = ? WHERE id = ? AND purpose LIKE ? AND consumed_at IS NULL AND expires_at > ?',
      [new Date(), String(id || ''), 'phone_%', new Date()]
    );
    return result.affectedRows === 1;
  }

  async invalidate(phone, purpose) {
    const namespace = normalizePurpose(purpose);
    if (!namespace) return 0;
    const [result] = await this.pool.execute(
      'UPDATE email_verification_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL',
      [new Date(), PhoneChallengeModel.key(phone, namespace), namespace]
    );
    return result.affectedRows || 0;
  }

  // H5 令牌阶段没有号码，按不透明槽位失效。
  async invalidateRef(ref, purpose) {
    const namespace = normalizePurpose(purpose);
    const seed = normalizeRef(ref);
    if (!namespace || !seed) return 0;
    const [result] = await this.pool.execute(
      'UPDATE email_verification_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL',
      [new Date(), PhoneChallengeModel.opaqueKey(seed, namespace), namespace]
    );
    return result.affectedRows || 0;
  }

  async invalidateAllForPhone(phone) {
    let total = 0;
    for (const namespace of SUPPORTED_PURPOSES) {
      total += await this.invalidate(phone, namespace);
    }
    return total;
  }

  async deleteExpired(now = new Date()) {
    await this.pool.execute(
      'DELETE FROM email_verification_codes WHERE purpose LIKE ? AND (expires_at < ? OR consumed_at IS NOT NULL)',
      ['phone_%', now]
    );
  }
}

module.exports = PhoneChallengeModel;
module.exports.PURPOSES = PURPOSES;
module.exports.SUPPORTED_PURPOSES = SUPPORTED_PURPOSES;
module.exports.PHONE_CHALLENGE_KEY_PREFIX = KEY_PREFIX;
module.exports.hashPhoneChallengeBinding = hashBinding;
module.exports.normalizePhoneChallengeRef = normalizeRef;
