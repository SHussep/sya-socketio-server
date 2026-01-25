// ═══════════════════════════════════════════════════════════════
// AUTH CONTROLLERS - Indice de controladores de autenticacion
// ═══════════════════════════════════════════════════════════════
//
// Este modulo re-exporta el AuthController original para mantener
// compatibilidad mientras se migra gradualmente a controladores modulares.
//
// Estructura de controladores disponibles:
// - LoginController: desktopLogin, mobileLogin
// - TokenController: refreshToken, authenticateToken (pendiente)
// - GoogleAuthController: googleSignup, googleLogin (pendiente)
// - GmailOAuthController: startGmailOAuth, callbacks (pendiente)
// - DeviceController: registerDevice (pendiente)
// - BranchController: getBranches, createBranch, etc. (pendiente)
// - TenantController: overwriteTenant (pendiente)
// - EmployeeController: getMainEmployee, verifyAdminPassword (pendiente)
// ═══════════════════════════════════════════════════════════════

// Re-exportar el controlador original para compatibilidad
const AuthController = require('../authController');

// Exportar controladores modulares (para uso futuro)
const LoginController = require('./loginController');

module.exports = AuthController;

// Exportar tambien los controladores individuales para uso directo
module.exports.LoginController = LoginController;
