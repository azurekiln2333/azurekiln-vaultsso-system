const nodemailer = require('nodemailer');

let transporter = null;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSmtpConfigured() {
  return Boolean(
    normalizeText(process.env.SMTP_HOST) &&
    normalizeText(process.env.SMTP_USER) &&
    String(process.env.SMTP_PASS || '')
  );
}

function getTransporter() {
  if (transporter) {
    return transporter;
  }

  if (!isSmtpConfigured()) {
    return null;
  }

  const user = normalizeText(process.env.SMTP_USER);
  const pass = String(process.env.SMTP_PASS || '');
  const auth = user ? { user, pass } : undefined;
  const port = Number(process.env.SMTP_PORT || 587);
  const secureEnv = normalizeText(process.env.SMTP_SECURE).toLowerCase();
  // Ports 443 and 465 speak implicit TLS (e.g. SMTP2GO); other ports use STARTTLS.
  const secure = secureEnv === 'true' ? true : secureEnv === 'false' ? false : port === 443 || port === 465;

  transporter = nodemailer.createTransport({
    host: normalizeText(process.env.SMTP_HOST),
    port,
    secure,
    requireTLS: !secure,
    auth,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });

  return transporter;
}

function buildSubject(purpose) {
  if (purpose === 'password_reset') {
    return 'VaultSSO password reset code';
  }

  return 'VaultSSO registration verification code';
}

function buildText({ code, purpose, expiresInMinutes }) {
  const action = purpose === 'password_reset'
    ? 'reset your VaultSSO password'
    : 'finish creating your VaultSSO account';

  return [
    `Your verification code is: ${code}`,
    '',
    `Use this code to ${action}.`,
    `It expires in ${expiresInMinutes} minutes.`,
    '',
    'If you did not request this code, you can ignore this email.'
  ].join('\n');
}

async function sendVerificationEmail({ to, code, purpose, expiresInMinutes }) {
  const from = normalizeText(process.env.MAIL_FROM) || 'VaultSSO <no-reply@localhost>';
  const subject = buildSubject(purpose);
  const text = buildText({ code, purpose, expiresInMinutes });
  const smtp = getTransporter();

  if (!smtp) {
    console.log(`[email:dev] to=${to} purpose=${purpose} code=${code}`);
    return { delivered: false, mode: 'console' };
  }

  try {
    await smtp.sendMail({ from, to, subject, text });
  } catch (error) {
    console.error(`[email:smtp] send failed: ${error.message}`);
    throw error;
  }
  return { delivered: true, mode: 'smtp' };
}

function getSmtpSettings() {
  return {
    host: normalizeText(process.env.SMTP_HOST),
    port: Number(process.env.SMTP_PORT || 587),
    user: normalizeText(process.env.SMTP_USER),
    from: normalizeText(process.env.MAIL_FROM),
    // The password is never returned; only whether one is stored.
    hasPassword: String(process.env.SMTP_PASS || '') !== ''
  };
}

function applySmtpSettings({ host, port, user, password, from }) {
  if (host !== undefined) process.env.SMTP_HOST = normalizeText(host);
  if (port !== undefined && Number(port) > 0) process.env.SMTP_PORT = String(Number(port));
  if (user !== undefined) process.env.SMTP_USER = normalizeText(user);
  if (password !== undefined) process.env.SMTP_PASS = String(password || '');
  if (from !== undefined) process.env.MAIL_FROM = normalizeText(from);
  // Drop the cached transporter so the next send picks up the new settings.
  transporter = null;
}

async function sendTestEmail(to) {
  const from = normalizeText(process.env.MAIL_FROM) || 'VaultSSO <no-reply@localhost>';
  const smtp = getTransporter();
  if (!smtp) {
    throw new Error('SMTP 未配置：请先填写主机、用户名和密码');
  }
  await smtp.sendMail({
    from,
    to,
    subject: 'VaultSSO SMTP test',
    text: 'This is a test email from your VaultSSO SMTP settings. If you can read this, sending works.'
  });
}

module.exports = {
  sendVerificationEmail,
  getSmtpSettings,
  applySmtpSettings,
  sendTestEmail
};
