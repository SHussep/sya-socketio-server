require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function seedSubscriptions() {
    console.log('\n🌱 POBLANDO TABLA SUBSCRIPTIONS...\n');

    try {
        // Insertar planes de subscripción
        const plans = [
            { name: 'Basic', price_monthly: 499.00, max_branches: 1, max_devices: 3, max_employees: 5, query_days_limit: 30 },
            { name: 'Pro', price_monthly: 999.00, max_branches: 3, max_devices: 10, max_employees: 15, query_days_limit: 90 },
            { name: 'Enterprise', price_monthly: 1999.00, max_branches: 10, max_devices: 50, max_employees: 50, query_days_limit: 365 }
        ];

        for (const plan of plans) {
            const result = await pool.query(`
                INSERT INTO subscriptions (name, price_monthly, max_branches, max_devices, max_employees, query_days_limit, features, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, '{}', NOW())
                RETURNING id, name, price_monthly
            `, [plan.name, plan.price_monthly, plan.max_branches, plan.max_devices, plan.max_employees, plan.query_days_limit]);

            console.log(`✅ ${plan.name}: ID ${result.rows[0].id} - $${result.rows[0].price_monthly}/mes`);
        }

        console.log('\n✅ SUBSCRIPTIONS POBLADAS\n');

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
    }
}

seedSubscriptions();
