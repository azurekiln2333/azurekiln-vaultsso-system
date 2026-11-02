const AuthenticatorModel = require('../models/Authenticator');

// Inserts with a user FK must not recreate credentials or identity/profile data after an erase.
// A pool caller owns a lifecycle transaction; a connection caller joins the existing transaction.
async function withActiveAccount(database, userId, work) {
  if (!userId) return work(database);
  const run = async (user, connection) => {
    if (!user || user.status === 'deleted') {
      throw Object.assign(new Error('Account is no longer available'), { code: 'ACCOUNT_DELETED', status: 401 });
    }
    return work(connection);
  };
  if (typeof database.getConnection === 'function') {
    return new AuthenticatorModel(database).withUser(userId, (user, _a, _u, connection) => run(user, connection));
  }
  const [rows] = await database.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
  return run(rows[0], database);
}

module.exports = { withActiveAccount };
