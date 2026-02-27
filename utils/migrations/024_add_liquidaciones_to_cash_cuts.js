exports.up = async function(pool) {
    console.log('[Migration 024] Adding liquidaciones columns to cash_cuts...');
    await pool.query(`
        ALTER TABLE cash_cuts
        ADD COLUMN IF NOT EXISTS total_liquidaciones_efectivo DECIMAL(12, 2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_liquidaciones_tarjeta DECIMAL(12, 2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_liquidaciones_credito DECIMAL(12, 2) DEFAULT 0
    `);
    console.log('[Migration 024] ✅ Liquidaciones columns added to cash_cuts');
};

exports.down = async function(pool) {
    await pool.query(`
        ALTER TABLE cash_cuts
        DROP COLUMN IF EXISTS total_liquidaciones_efectivo,
        DROP COLUMN IF EXISTS total_liquidaciones_tarjeta,
        DROP COLUMN IF EXISTS total_liquidaciones_credito
    `);
};
