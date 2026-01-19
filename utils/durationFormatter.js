// ═══════════════════════════════════════════════════════════════
// DURATION FORMATTER
// Formatea duraciones en segundos a formato legible para notificaciones
// ═══════════════════════════════════════════════════════════════

/**
 * Formatea una duración en segundos a formato legible.
 * @param {number} totalSeconds - Duración en segundos
 * @param {boolean} useColonFormat - Si es true, usa formato HH:mm:ss
 * @returns {string} Duración formateada
 *
 * Ejemplos:
 * - 45 → "45s"
 * - 330 → "5m 30s"
 * - 8130 → "2h 15m 30s" o "02:15:30"
 */
function formatDuration(totalSeconds, useColonFormat = false) {
    if (!totalSeconds || totalSeconds < 0) {
        return '0s';
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    // Para duraciones de 1 hora o más
    if (hours >= 1) {
        if (useColonFormat) {
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    }

    // Para duraciones de 1 minuto a menos de 1 hora
    if (minutes >= 1) {
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    }

    // Menos de un minuto
    return `${seconds}s`;
}

/**
 * Formatea una duración para notificaciones FCM (texto natural en español).
 * @param {number} totalSeconds - Duración en segundos
 * @returns {string} Descripción legible de la duración
 *
 * Ejemplos:
 * - 45 → "45 segundos"
 * - 330 → "5 minutos"
 * - 8130 → "2 horas 15 min"
 */
function formatDurationForNotification(totalSeconds) {
    if (!totalSeconds || totalSeconds < 0) {
        return '0 segundos';
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    // Para duraciones de 1 hora o más
    if (hours >= 1) {
        if (minutes === 0) {
            return hours === 1 ? '1 hora' : `${hours} horas`;
        }
        return hours === 1
            ? `1 hora ${minutes} min`
            : `${hours} horas ${minutes} min`;
    }

    // Para duraciones de minutos
    if (minutes >= 1) {
        // Si son 10+ minutos, no mostrar segundos
        if (minutes >= 10 || seconds === 0) {
            return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
        }
        return `${minutes}m ${seconds}s`;
    }

    // Menos de un minuto
    return `${seconds} segundos`;
}

/**
 * Formatea minutos a formato legible.
 * @param {number} totalMinutes - Duración en minutos
 * @returns {string} Duración formateada
 */
function formatMinutes(totalMinutes) {
    return formatDuration(totalMinutes * 60);
}

/**
 * Extrae y reemplaza duraciones en segundos dentro de un texto.
 * Busca varios patrones de duraciones y los reemplaza con formato legible.
 * @param {string} text - Texto que puede contener duraciones en segundos
 * @returns {string} Texto con duraciones formateadas
 */
function formatDurationsInText(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }

    // Patrón 1: "Duración: 123.4s" o "Duration: 123s"
    let result = text.replace(/([Dd]uraci[oó]n|[Dd]uration):\s*(\d+\.?\d*)\s*s\b/g, (match, label, seconds) => {
        const formatted = formatDuration(parseFloat(seconds));
        return `${label}: ${formatted}`;
    });

    // Patrón 2: "desconexión de 123.4s" o "desconectada 123.4s" o "desconectada hace 123s"
    result = result.replace(/(desconexi[oó]n de|desconectada(?:\s+hace)?)\s*(\d+\.?\d*)\s*s\b/gi, (match, label, seconds) => {
        const formatted = formatDuration(parseFloat(seconds));
        return `${label} ${formatted}`;
    });

    // Patrón 3: "en 123.4s" al final de una oración (para mensajes como "...NO fue registrado en 6489.7s")
    result = result.replace(/\ben\s+(\d+\.?\d*)\s*s\b(?=\.|,|$|\s*[A-ZÁÉÍÓÚ])/g, (match, seconds) => {
        const formatted = formatDuration(parseFloat(seconds));
        return `en ${formatted}`;
    });

    // Patrón 4: "hace 123.4s" o "hace 123s"
    result = result.replace(/\bhace\s+(\d+\.?\d*)\s*s\b/gi, (match, seconds) => {
        const formatted = formatDuration(parseFloat(seconds));
        return `hace ${formatted}`;
    });

    // Patrón 5: Standalone duration at end like "(123.4s)" or "período (123.4s)"
    result = result.replace(/\((\d+\.?\d*)\s*s\)/g, (match, seconds) => {
        const formatted = formatDuration(parseFloat(seconds));
        return `(${formatted})`;
    });

    return result;
}

module.exports = {
    formatDuration,
    formatDurationForNotification,
    formatMinutes,
    formatDurationsInText
};
