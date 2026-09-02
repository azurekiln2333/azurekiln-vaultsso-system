const nodemailer = require('nodemailer');

let transporter = null;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSmtpConfigured() {
  return Boolean(normalizeText(process.env.SMTP_HOST));
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

  transporter = nodemailer.createTransport({
    host: normalizeText(process.env.SMTP_HOST),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth
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

  await smtp.sendMail({ from, to, subject, text });
  return { delivered: true, mode: 'smtp' };
}

module.exports = {
  sendVerificationEmail
};
