/**
 * In-memory registry of active device sessions per employee.
 * Key: employeeId (PostgreSQL integer from JWT)
 * Value: { socketId, clientType, branchId, connectedAt }
 *
 * Shared between socket/handlers.js and REST routes.
 * Lost on server restart — rebuilt via identify_client on reconnect.
 */
const activeDeviceSessions = new Map();

module.exports = activeDeviceSessions;
