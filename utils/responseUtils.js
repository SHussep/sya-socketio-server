// ═══════════════════════════════════════════════════════════════
// UTILIDADES: Respuestas HTTP Estandarizadas
// Garantiza que nunca se expongan stack traces u otra info sensible
// ═══════════════════════════════════════════════════════════════

/**
 * Envia una respuesta de error estandarizada
 * NUNCA incluye stack traces en produccion
 *
 * @param {Response} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Mensaje amigable para el usuario
 * @param {Error} [error] - Error original (solo para logging)
 * @param {string} [code] - Codigo de error para el cliente (opcional)
 */
function errorResponse(res, statusCode, message, error = null, code = null) {
    // Loguear el error internamente (sin exponer al cliente)
    if (error) {
        console.error(`[Error ${statusCode}] ${message}:`, error.message);
    }

    const response = {
        success: false,
        message
    };

    if (code) {
        response.code = code;
    }

    // Solo en desarrollo, incluir mensaje de error (nunca stack trace)
    if (process.env.NODE_ENV === 'development' && error) {
        response.debug = error.message;
    }

    return res.status(statusCode).json(response);
}

/**
 * Respuesta de exito estandarizada
 *
 * @param {Response} res - Express response object
 * @param {*} data - Datos a enviar
 * @param {string} [message] - Mensaje opcional
 * @param {number} [statusCode=200] - HTTP status code
 */
function successResponse(res, data, message = null, statusCode = 200) {
    const response = {
        success: true
    };

    if (message) {
        response.message = message;
    }

    if (data !== undefined && data !== null) {
        response.data = data;
    }

    return res.status(statusCode).json(response);
}

/**
 * Respuesta de error de validacion
 *
 * @param {Response} res - Express response object
 * @param {string} message - Mensaje de error
 * @param {Object} [fields] - Campos con errores
 */
function validationError(res, message, fields = null) {
    const response = {
        success: false,
        message,
        code: 'VALIDATION_ERROR'
    };

    if (fields) {
        response.fields = fields;
    }

    return res.status(400).json(response);
}

/**
 * Respuesta de no autorizado
 */
function unauthorizedError(res, message = 'No autorizado') {
    return res.status(401).json({
        success: false,
        message,
        code: 'UNAUTHORIZED'
    });
}

/**
 * Respuesta de prohibido
 */
function forbiddenError(res, message = 'Acceso denegado') {
    return res.status(403).json({
        success: false,
        message,
        code: 'FORBIDDEN'
    });
}

/**
 * Respuesta de no encontrado
 */
function notFoundError(res, message = 'Recurso no encontrado') {
    return res.status(404).json({
        success: false,
        message,
        code: 'NOT_FOUND'
    });
}

/**
 * Respuesta de error interno
 * NUNCA expone detalles del error
 */
function internalError(res, error = null, message = 'Error interno del servidor') {
    if (error) {
        console.error('[InternalError]', error.message);
    }

    return res.status(500).json({
        success: false,
        message,
        code: 'INTERNAL_ERROR'
    });
}

module.exports = {
    errorResponse,
    successResponse,
    validationError,
    unauthorizedError,
    forbiddenError,
    notFoundError,
    internalError
};
