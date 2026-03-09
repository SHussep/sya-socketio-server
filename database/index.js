// ═══════════════════════════════════════════════════════════════
// DATABASE MODULE - Re-exports pool, schema, migrations
// ═══════════════════════════════════════════════════════════════

const { pool } = require('./pool');
const { initializeDatabase } = require('./schema');
const { runMigrations } = require('./migrations');

module.exports = { pool, initializeDatabase, runMigrations };
