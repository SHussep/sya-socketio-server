// ═══════════════════════════════════════════════════════════════
// SANITIZE UTILITIES - Input validation for SQL-safe values
// ═══════════════════════════════════════════════════════════════

// Whitelist of valid IANA timezone names used by our clients.
// PostgreSQL AT TIME ZONE only accepts IANA names or POSIX offsets.
// We whitelist rather than blacklist to prevent SQL injection.
const VALID_TIMEZONES = new Set([
    // Mexico (our primary users)
    'America/Mexico_City',
    'America/Tijuana',
    'America/Hermosillo',
    'America/Chihuahua',
    'America/Mazatlan',
    'America/Cancun',
    'America/Merida',
    'America/Monterrey',
    'America/Matamoros',
    'America/Ojinaga',
    'America/Bahia_Banderas',
    // US (potential future users)
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'America/Anchorage',
    'Pacific/Honolulu',
    // Central/South America
    'America/Guatemala',
    'America/Bogota',
    'America/Lima',
    'America/Sao_Paulo',
    'America/Argentina/Buenos_Aires',
    'America/Santiago',
    // Common fallbacks
    'UTC',
    'Etc/UTC',
    'GMT',
]);

const DEFAULT_TIMEZONE = 'America/Mexico_City';

/**
 * Validates a timezone string against the whitelist.
 * Returns a safe timezone name, never user input directly.
 * @param {string} tz - User-supplied timezone
 * @returns {string} A valid IANA timezone name
 */
function safeTimezone(tz) {
    if (!tz || typeof tz !== 'string') return DEFAULT_TIMEZONE;
    const trimmed = tz.trim();
    if (VALID_TIMEZONES.has(trimmed)) return trimmed;
    // Log the rejected timezone so we can add it to the whitelist if legit
    console.warn(`[Security] Rejected timezone: "${trimmed}" — using default ${DEFAULT_TIMEZONE}`);
    return DEFAULT_TIMEZONE;
}

/**
 * Validates a date string is in YYYY-MM-DD format.
 * Returns null if invalid to prevent SQL injection via date interpolation.
 * @param {string} dateStr - User-supplied date string
 * @returns {string|null} A safe date string or null
 */
function safeDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    // Extract date part (in case it comes as ISO with T)
    const dateOnly = dateStr.split('T')[0];
    // Strict format: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
    console.warn(`[Security] Rejected date string: "${dateStr}"`);
    return null;
}

module.exports = {
    safeTimezone,
    safeDateString,
    VALID_TIMEZONES,
    DEFAULT_TIMEZONE,
};
