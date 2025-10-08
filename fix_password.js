const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixPassword() {
    try {
        const email = 'saul.hussep@gmail.com'; // Usuario real del Desktop
        const newPassword = '1234'; // Contraseña consistente para Desktop y Mobile

        // Hash de la nueva contraseña
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Actualizar en la base de datos
        const result = await pool.query(
            'UPDATE employees SET password = $1 WHERE LOWER(email) = LOWER($2) RETURNING id, username, email',
            [hashedPassword, email]
        );

        if (result.rows.length > 0) {
            console.log('✅ Contraseña actualizada para:', result.rows[0]);
            console.log(`📧 Email: ${email}`);
            console.log(`🔑 Nueva contraseña: ${newPassword}`);
        } else {
            console.log('❌ Usuario no encontrado con email:', email);
        }

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

fixPassword();
