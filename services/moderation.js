// This module owns the gateway's moderation boundary. Keyword matching and the
// upstream HTTP protocol belong to @azurekiln/moderation-client and its service.
class ModerationError extends Error {
  constructor(code = 'moderation_unavailable') {
    const rejected = code === 'content_rejected';
    super(rejected ? '昵称或简介包含不允许的内容，请修改后重试' : '审核服务暂不可用');
    this.name = 'ModerationError';
    this.code = rejected ? 'content_rejected' : 'moderation_unavailable';
    this.status = rejected ? 400 : 503;
  }
}

function readModerationConfig(env = process.env) {
  const baseUrl = String(env.MODERATION_BASE_URL || '').trim();
  const appId = String(env.MODERATION_APP_ID || '').trim();
  const apiKey = String(env.MODERATION_API_KEY || '').trim();
  if (!baseUrl && !appId && !apiKey) return { configured: false, baseUrl: '', appId: '', apiKey: '' };
  if (!baseUrl || !appId || !apiKey) {
    throw new Error('MODERATION_BASE_URL, MODERATION_APP_ID and MODERATION_API_KEY must be configured together');
  }
  let address;
  try { address = new URL(baseUrl); } catch {
    throw new Error('MODERATION_BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment');
  }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw new Error('MODERATION_BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment');
  }
  if (String(env.NODE_ENV || 'production').toLowerCase() === 'production' && address.protocol !== 'https:'
      && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) {
    throw new Error('MODERATION_BASE_URL requires HTTPS in production except for a loopback service');
  }
  if (/[\r\n]/.test(apiKey)) throw new Error('MODERATION_API_KEY must not contain line breaks');
  if (apiKey.length < 32) throw new Error('MODERATION_API_KEY must contain at least 32 characters');
  if (/[\r\n]/.test(appId)) throw new Error('MODERATION_APP_ID must not contain line breaks');
  return { configured: true, baseUrl: address.toString().replace(/\/$/, ''), appId, apiKey };
}

function isModerationSdkAvailable() {
  try { require.resolve('@azurekiln/moderation-client'); return true; } catch { return false; }
}

function createModerationService({ env = process.env, loadSdk = () => require('@azurekiln/moderation-client'), assertText } = {}) {
  async function assertSdkText(text, { field, userId }) {
    const config = readModerationConfig(env);
    if (!config.configured) throw new ModerationError();
    // Load only when required: a missing optional SDK must not break login or
    // unrelated account operations. Distribution uses the official vendored tgz.
    const { ModerationClient } = loadSdk();
    const client = new ModerationClient({
      baseUrl: config.baseUrl, appId: config.appId, apiKey: config.apiKey,
      timeoutMs: 3000, failClosed: true
    });
    const result = await client.checkText({
      scene: `profile_${field}`, text, userId: String(userId),
      targetType: 'user', targetId: String(userId)
    });
    if (result?.unavailable) throw new ModerationError();
    if (result?.decision === 'pass') return;
    if (['block', 'review'].includes(result?.decision)) throw new ModerationError('content_rejected');
    throw new ModerationError();
  }
  const review = assertText || assertSdkText;
  return {
    async assertProfileUpdates(currentUser, updates) {
      for (const field of ['name', 'description']) {
        if (!Object.prototype.hasOwnProperty.call(updates, field)) continue;
        const value = String(updates[field] ?? '');
        if (value === String(currentUser[field] ?? '')) continue;
        try {
          await review(value, { field, userId: currentUser.id });
        } catch (error) {
          if (error instanceof ModerationError) throw error;
          throw new ModerationError();
        }
      }
    }
  };
}

module.exports = { ModerationError, readModerationConfig, isModerationSdkAvailable, createModerationService, ...createModerationService() };
