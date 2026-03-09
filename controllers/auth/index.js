// ═══════════════════════════════════════════════════════════════
// AUTH CONTROLLER - Assembled from modular method files
// ═══════════════════════════════════════════════════════════════

const gmailMethods = require('./gmailMethods');
const loginMethods = require('./loginMethods');
const signupMethods = require('./signupMethods');
const tenantMethods = require('./tenantMethods');

class AuthController {
    constructor(pool) {
        this.pool = pool;
    }
}

// Attach all methods to the prototype
Object.assign(
    AuthController.prototype,
    gmailMethods,
    loginMethods,
    signupMethods,
    tenantMethods
);

module.exports = AuthController;
