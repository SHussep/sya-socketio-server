/**
 * In-memory registry of active device sessions per employee.
 * Key: `${employeeId}_${deviceType}` (composite, e.g. "42_desktop")
 * Value: { socketId, clientType, branchId, connectedAt, lastHeartbeat }
 *
 * Shared between socket/handlers.js and REST routes.
 * Lost on server restart — rebuilt via identify_client on reconnect.
 * lastHeartbeat is updated by shift_heartbeat events (informational only —
 * the DB shifts.last_heartbeat column is the authoritative source).
 */
const activeDeviceSessions = new Map();

module.exports = activeDeviceSessions;
