const { eraseAccount, AccountErasureError } = require('./account-erasure');
const moderation = require('./moderation');

// QFLIStudio+ 客户端标识：client_id 以 qfli 开头，大小写不敏感。
// 只接受字符串形式的 client_id 或带 id 的客户端记录，其余一律返回 false，
// 保证“无客户端”场景与其它客户端的行为不受任何影响。
// 判定前不裁剪空白：带前导/尾随空白的 id 不是已登记客户端，
// 不能因为宽松匹配把无关应用当成 QFLI 客户端去拦截注册或放行注销。
// 注册限制（任务2）与账号注销（任务4）共用这一个判定。
const QFLI_CLIENT_PREFIX = 'qfli';

function isQfliClient(candidate) {
  const id = typeof candidate === 'string' ? candidate : candidate?.id;
  return typeof id === 'string' && id.toLowerCase().startsWith(QFLI_CLIENT_PREFIX);
}

module.exports = function installQfliIntegration({
  app, asyncHandler, authenticateClient, validateToken, getModels,
  isClientActive, isUserBanned, scopedUserClaims,
  getPool, getClientIp, secret,
}) {
  app.post('/oauth2/account/erase', asyncHandler(async (req, res) => {
    req.body ||= {};
    const client = await authenticateClient(req, res);
    if (!client) return;
    if (!isQfliClient(client)) {
      return res.status(403).json({ error: 'access_denied', error_description: 'Only QFLI clients may erase accounts' });
    }
    if (!client.scopes.includes('qfli_account_erase')) {
      return res.status(403).json({ error: 'insufficient_scope', error_description: 'The qfli_account_erase scope is required' });
    }
    const { RateLimit } = getModels();
    const rate = await RateLimit.consume(`account-erase:client:${client.id}`, 30, 60 * 1000);
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ error: 'rate_limited', error_description: 'Too many account erasure requests' });
    }
    const { user_id: userId, reason, request_id: requestId } = req.body;
    if (typeof userId !== 'string' || userId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
        || (reason !== undefined && (typeof reason !== 'string' || reason.length > 255))
        || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 64))) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'A valid user_id and bounded string reason/request_id are required' });
    }
    try {
      res.json(await eraseAccount({ pool: getPool(), secret, userId: userId.toLowerCase(), clientId: client.id,
        requestId: requestId || '', ip: getClientIp(req) }));
    } catch (error) {
      if (error instanceof AccountErasureError) {
        return res.status(error.status).json({ error: error.code, error_description: error.message });
      }
      throw error;
    }
  }));

  async function accessUser(req, res) {
    const { Token, Client, User } = getModels();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const decoded = validateToken(token, 'access');
    const row = decoded && await Token.findAccessTokenById(decoded.jti);
    const client = row && await Client.findById(row.client_id);
    if (!decoded || !Token.matchesToken(row, token) || !isClientActive(client) ||
        row.client_id !== decoded.aud || row.user_id !== decoded.sub ||
        new Date(row.expires_at).getTime() <= Date.now()) {
      res.status(401).json({ error: 'invalid_token', error_description: '登录令牌已失效' });
      return null;
    }
    if (!row.scopes.includes('openid') || !row.scopes.includes('profile')) {
      res.status(403).json({ error: 'insufficient_scope', error_description: '需要 openid 和 profile 权限' });
      return null;
    }
    const user = await User.findById(decoded.sub);
    if (!user || isUserBanned(user)) {
      res.status(403).json({ error: 'access_denied', error_description: '账号不存在或已停用' });
      return null;
    }
    return { user, scopes: row.scopes };
  }

  app.put('/oauth2/profile', asyncHandler(async (req, res) => {
    const { User } = getModels();
    const authenticated = await accessUser(req, res);
    if (!authenticated) return;
    const input = req.body || {};
    if (Object.keys(input).some((key) => !['name', 'description'].includes(key))) {
      return res.status(400).json({ error: 'invalid_request', error_description: '此接口仅支持昵称和简介' });
    }
    const updates = {};
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64) {
        return res.status(400).json({ error: 'invalid_request', error_description: '昵称需为 1-64 字' });
      }
      updates.name = input.name.trim();
    }
    if (input.description !== undefined) {
      if (typeof input.description !== 'string' || input.description.length > 200) {
        return res.status(400).json({ error: 'invalid_request', error_description: '简介不能超过 200 字' });
      }
      updates.description = input.description;
    }
    await moderation.assertProfileUpdates(authenticated.user, updates);
    await User.update(authenticated.user.id, updates);
    const user = await User.findById(authenticated.user.id);
    res.json({ ...scopedUserClaims(user, authenticated.scopes), description: user.description || '' });
  }));

  app.get('/oauth2/public-profile/:id', asyncHandler(async (req, res) => {
    const { User } = getModels();
    req.body ||= {};
    const client = await authenticateClient(req, res);
    if (!client) return;
    if (!client.scopes.includes('qfli_public_profile')) {
      return res.status(403).json({ error: 'insufficient_scope', error_description: '此客户端未获准读取社区作者资料' });
    }
    const user = await User.findById(req.params.id);
    if (!user || isUserBanned(user)) return res.status(404).json({ error: 'user_not_found' });
    res.set('Cache-Control', 'no-store');
    res.json({ ...scopedUserClaims(user, ['profile']), description: user.description || '' });
  }));
};

module.exports.isQfliClient = isQfliClient;
module.exports.QFLI_CLIENT_PREFIX = QFLI_CLIENT_PREFIX;
