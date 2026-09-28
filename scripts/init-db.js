require('../config/environment').loadProjectEnvironment();
const { initDatabase, closePool } = require('../db/init');
async function main() {
  try {
    await initDatabase({ initializeSchema: true });
    console.log('Schema initialization complete. No users, clients or identity providers were created or promoted.');
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Database initialization failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
