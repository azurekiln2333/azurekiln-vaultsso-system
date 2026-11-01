// 登录/注册日志必须记录「谁、从哪里、以什么方式」登录，因此源地址由这里统一解析。
//
// 信任边界：只有 socket 对端属于已配置的可信反代（TRUST_PROXY）时，才读取反代写入的
// X-Real-IP / X-Real-Port。客户端自己带的这些头一律不可信：
// - X-Forwarded-For 由 Express 的 trust proxy 逐跳回溯，最左一段可被伪造，所以绝不用它；
// - socket 对端不可信时，端口取 socket 上真实的 remotePort。

const net = require('node:net');

function toBuffer(address) {
  if (net.isIPv4(address)) {
    return Buffer.from(address.split('.').map(part => Number(part)));
  }
  if (!net.isIPv6(address)) {
    return null;
  }
  // 把 ::ffff:1.2.3.4 之类的内嵌 IPv4 与常见缩写统一展开成 16 字节。
  const [head, tail] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  if (!address.includes('::') && headParts.length !== 8) {
    return null;
  }
  const fill = address.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const groups = [...headParts, ...Array(Math.max(fill, 0)).fill('0'), ...tailParts];
  if (groups.length !== 8) {
    return null;
  }
  const buffer = Buffer.alloc(16);
  groups.forEach((group, index) => {
    let parts = group;
    let offset = index * 2;
    if (index === 6 && group.includes('.')) {
      const [a, b, c, d] = group.split('.').map(Number);
      parts = ((a << 8) | b).toString(16);
      buffer[12] = c;
      buffer[13] = d;
      offset = 12;
    }
    buffer.writeUInt16BE(parseInt(parts, 16) || 0, offset);
  });
  return buffer;
}

// 把一条 TRUST_PROXY 条目（IP 或 CIDR）编译成可比较的判定函数。
function compileProxyEntry(entry) {
  const [address, prefixText] = String(entry || '').trim().split('/');
  const version = net.isIP(address);
  const bytes = version ? toBuffer(address) : null;
  if (!bytes) {
    return null;
  }
  const maxBits = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxBits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > maxBits) {
    return null;
  }
  const expected = Buffer.from(bytes.subarray(0, version === 4 ? 4 : 16));
  return candidate => {
    const value = normalizeIp(candidate);
    if (net.isIP(value) !== version) {
      return false;
    }
    const raw = version === 4 ? Buffer.from(value.split('.').map(Number)) : toBuffer(value);
    if (!raw || raw.length !== expected.length) {
      return false;
    }
    let remaining = prefix;
    for (let index = 0; index < raw.length && remaining > 0; index++) {
      const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
      if ((raw[index] & mask) !== (expected[index] & mask)) {
        return false;
      }
      remaining -= 8;
    }
    return true;
  };
}

function normalizeIp(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  return mapped ? mapped[1] : text;
}

function normalizePort(value) {
  const text = String(value || '').trim();
  if (!/^\d{1,5}$/.test(text)) {
    return null;
  }
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function isTrustedProxy(address, trustedProxies = []) {
  const value = normalizeIp(address);
  if (!value) {
    return false;
  }
  return trustedProxies.some(entry => {
    const matches = compileProxyEntry(entry);
    return matches ? matches(value) : false;
  });
}

// 返回 { ip, port, proxy }：ip 用 Express 依据 trust proxy 解析的结果（而非 XFF 首段），
// port 只在可信反代直连时取 X-Real-Port，否则用 socket 的真实对端端口。
function readRequestSource(req, trustedProxies = []) {
  if (!req) {
    return { ip: '', port: null, proxy: false };
  }
  const socketAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const proxy = isTrustedProxy(socketAddress, trustedProxies);
  const ip = normalizeIp(req.ip || socketAddress);
  const port = proxy
    ? normalizePort(req.headers?.['x-real-port']) ?? normalizePort(req.socket?.remotePort)
    : normalizePort(req.socket?.remotePort);
  return { ip, port, proxy };
}

module.exports = { readRequestSource, isTrustedProxy, normalizePort, normalizeIp, compileProxyEntry };
