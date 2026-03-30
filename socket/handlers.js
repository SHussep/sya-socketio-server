// ═══════════════════════════════════════════════════════════════
// SOCKET.IO EVENT HANDLERS
// Todos los handlers de eventos del socket (connection, disconnect, etc.)
// ═══════════════════════════════════════════════════════════════

const activeDeviceSessions = require('./activeDeviceSessions');

module.exports = function setupSocketHandlers(io, { pool, stats, notificationHelper, scaleStatusByBranch, guardianStatusByBranch }) {

    // Debounce FCM: prevent duplicate notifications for same branch+event within window
    const lastScaleFcm = new Map(); // key: "branchId:eventType" → timestamp
    const SCALE_FCM_DEBOUNCE_MS = 15000;
    const lastPrepModeFcm = new Map(); // key: "branchId:eventType" → timestamp
    const PREPMODE_FCM_DEBOUNCE_MS = 30000; // 30s — prep mode events are less frequent
    const lastShiftFcm = new Map(); // key: "branchId:shift_started" → timestamp
    const SHIFT_FCM_DEBOUNCE_MS = 30000; // 30s — evita doble FCM si se re-inicia turno

    function shouldSendScaleFcm(branchId, eventType) {
        const key = `${branchId}:${eventType}`;
        const now = Date.now();
        const last = lastScaleFcm.get(key);
        if (last && (now - last) < SCALE_FCM_DEBOUNCE_MS) {
            console.log(`[SCALE] ⏭️ FCM debounce: ${eventType} para branch ${branchId} (${Math.round((now - last) / 1000)}s desde último)`);
            return false;
        }
        lastScaleFcm.set(key, now);
        return true;
    }

    function shouldSendShiftFcm(branchId, eventType) {
        const key = `${branchId}:${eventType}`;
        const now = Date.now();
        const last = lastShiftFcm.get(key);
        if (last && (now - last) < SHIFT_FCM_DEBOUNCE_MS) {
            console.log(`[SHIFT] ⏭️ FCM debounce: ${eventType} para branch ${branchId} (${Math.round((now - last) / 1000)}s desde último)`);
            return false;
        }
        lastShiftFcm.set(key, now);
        return true;
    }

    function shouldSendPrepModeFcm(branchId, eventType) {
        const key = `${branchId}:${eventType}`;
        const now = Date.now();
        const last = lastPrepModeFcm.get(key);
        if (last && (now - last) < PREPMODE_FCM_DEBOUNCE_MS) {
            console.log(`[PREPMODE] ⏭️ FCM debounce: ${eventType} para branch ${branchId} (${Math.round((now - last) / 1000)}s desde último)`);
            return false;
        }
        lastPrepModeFcm.set(key, now);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // CLEANUP: Limpiar entradas viejas de debounce Maps cada 30 minutos
    // Evita memory leaks en procesos de larga duración
    // ═══════════════════════════════════════════════════════════════
    const DEBOUNCE_CLEANUP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hora
    setInterval(() => {
        const now = Date.now();
        let cleaned = 0;

        // Limpiar FCM debounce maps (almacenan timestamps de Date.now())
        for (const [key, ts] of lastScaleFcm) {
            if (now - ts > DEBOUNCE_CLEANUP_MAX_AGE_MS) { lastScaleFcm.delete(key); cleaned++; }
        }
        for (const [key, ts] of lastPrepModeFcm) {
            if (now - ts > DEBOUNCE_CLEANUP_MAX_AGE_MS) { lastPrepModeFcm.delete(key); cleaned++; }
        }
        for (const [key, ts] of lastShiftFcm) {
            if (now - ts > DEBOUNCE_CLEANUP_MAX_AGE_MS) { lastShiftFcm.delete(key); cleaned++; }
        }

        // Limpiar scaleStatusByBranch (almacena objetos con updatedAt ISO string)
        for (const [key, val] of scaleStatusByBranch) {
            if (val.updatedAt && (now - new Date(val.updatedAt).getTime()) > DEBOUNCE_CLEANUP_MAX_AGE_MS) {
                scaleStatusByBranch.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[CLEANUP] 🧹 ${cleaned} entradas viejas eliminadas de debounce Maps`);
        }
    }, 30 * 60 * 1000);

    io.on('connection', (socket) => {
        console.log(`[${new Date().toISOString()}] Cliente conectado: ${socket.id} (auth: ${socket.authenticated ? 'yes' : 'no'})`);

        socket.on('join_branch', (branchId) => {
            if (!socket.authenticated) {
                console.warn(`[Socket.IO] ⚠️ Unauthenticated client ${socket.id} tried to join branch_${branchId}`);
                socket.emit('auth_error', { message: 'Token requerido para unirse a una sucursal' });
                return;
            }

            const parsedBranchId = parseInt(branchId);

            // Dejar todos los rooms de branch anteriores antes de unirse al nuevo
            socket.rooms.forEach(room => {
                if (room.startsWith('branch_') && room !== `branch_${parsedBranchId}`) {
                    socket.leave(room);
                    console.log(`[LEAVE] Cliente ${socket.id} dejó ${room}`);
                }
            });

            const roomName = `branch_${parsedBranchId}`;
            socket.join(roomName);
            socket.branchId = parsedBranchId;
            socket.clientType = 'unknown';
            console.log(`[JOIN] Cliente ${socket.id} (tenant:${socket.user?.tenantId}) → ${roomName}`);
            socket.emit('joined_branch', { branchId: parsedBranchId, message: `Conectado a sucursal ${parsedBranchId}` });
        });

        // Join tenant room (for cross-branch events like producto_branch sync)
        socket.on('join_tenant', (tenantId) => {
            if (!socket.authenticated) {
                console.warn(`[Socket.IO] Unauthenticated client ${socket.id} tried to join tenant_${tenantId}`);
                return;
            }
            const parsedTenantId = parseInt(tenantId);
            const roomName = `tenant_${parsedTenantId}`;
            socket.join(roomName);
            console.log(`[Socket.IO] Cliente ${socket.id} joined ${roomName}`);
        });

        // Admin: join ALL branch rooms to receive events from every branch
        socket.on('join_all_branches', (branchIds) => {
            if (!socket.authenticated) {
                socket.emit('auth_error', { message: 'Token requerido para unirse a sucursales' });
                return;
            }
            if (!Array.isArray(branchIds)) return;

            for (const id of branchIds) {
                const parsed = parseInt(id);
                if (!isNaN(parsed)) {
                    socket.join(`branch_${parsed}`);
                }
            }
            console.log(`[JOIN_ALL] Cliente ${socket.id} (tenant:${socket.user?.tenantId}) → ${branchIds.map(id => `branch_${id}`).join(', ')}`);
            socket.emit('joined_branch', { branchIds, message: `Conectado a ${branchIds.length} sucursales` });
        });

        socket.on('identify_client', async (data) => {
            socket.clientType = data.type;
            socket.deviceInfo = data.deviceInfo || {};
            if (data.type === 'desktop') stats.desktopClients++;
            else if (data.type === 'mobile') stats.mobileClients++;

            // Fallback: resolve employeeGlobalId if auth middleware didn't (e.g., reconnection)
            if (data.employeeGlobalId && socket.user?.tenantId) {
                try {
                    const empResult = await pool.query(
                        'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                        [data.employeeGlobalId, socket.user.tenantId]
                    );
                    if (empResult.rows.length > 0) {
                        const resolvedId = empResult.rows[0].id;
                        if (resolvedId !== socket.user.employeeId) {
                            console.log(`[IDENTIFY] ⚠️ Correcting employeeId: JWT=${socket.user.employeeId} → resolved=${resolvedId} (globalId=${data.employeeGlobalId})`);
                            socket.user.employeeId = resolvedId;
                        }
                    }
                } catch (err) {
                    console.warn(`[IDENTIFY] ⚠️ Could not resolve employeeGlobalId: ${err.message}`);
                }
            }

            console.log(`[IDENTIFY] ${socket.id} → ${data.type} (Sucursal: ${socket.branchId}, Employee: ${socket.user?.employeeId})`);

            // ═══════════════════════════════════════════════════════════════
            // MUTUAL EXCLUSION: Session revocation check + Map registration
            // Replaces old mobile-to-mobile kick code.
            // ═══════════════════════════════════════════════════════════════
            const employeeId = socket.user?.employeeId;
            if (employeeId) {
                try {
                    // Check if this device was revoked while offline
                    // Matches specific device type OR 'all' (set by force_takeover)
                    const revocationCheck = await pool.query(
                        `UPDATE employees
                         SET session_revoked_at = NULL, session_revoked_for_device = NULL
                         WHERE id = $1
                           AND session_revoked_at IS NOT NULL
                           AND (session_revoked_for_device = $2 OR session_revoked_for_device = 'all')
                         RETURNING session_revoked_at`,
                        [employeeId, data.type]
                    );

                    if (revocationCheck.rows.length > 0) {
                        console.log(`[Socket] 🚫 Employee ${employeeId} (${data.type}) was revoked while offline — requesting flush`);

                        // Re-set revocation (the UPDATE above cleared it) — wait for flush_complete
                        await pool.query(
                            `UPDATE employees SET session_revoked_at = NOW(), session_revoked_for_device = $2
                             WHERE id = $1`,
                            [employeeId, data.type]
                        );

                        // Send flush request instead of immediate force_logout
                        socket.emit('session_revoked_pending_flush', {
                            reason: 'session_taken',
                            message: 'Tu sesión fue revocada — sincronizando datos pendientes'
                        });

                        // Register temporarily so flush_complete handler can find this socket
                        const sessionKey = `${employeeId}_${data.type}`;
                        activeDeviceSessions.set(sessionKey, {
                            socketId: socket.id,
                            clientType: data.type,
                            branchId: socket.branchId || null,
                            connectedAt: Date.now(),
                            lastHeartbeat: Date.now(),
                            pendingFlush: true
                        });
                        return;
                    }

                    // Register this device in the session registry (composite key: employeeId_deviceType)
                    const sessionKey = `${employeeId}_${data.type}`;
                    activeDeviceSessions.set(sessionKey, {
                        socketId: socket.id,
                        clientType: data.type,
                        branchId: socket.branchId || null,
                        connectedAt: Date.now()
                    });
                    console.log(`[Socket] 📱 Employee ${employeeId} registered as ${data.type} (socket: ${socket.id}, key: ${sessionKey})`);
                } catch (err) {
                    console.error(`[Socket] Error in session registry for employee ${employeeId}:`, err.message);
                }
            }

            // Broadcast desktop online status to the branch room
            if (data.type === 'desktop' && socket.branchId) {
                io.to(`branch_${socket.branchId}`).emit('desktop_status_changed', {
                    branchId: parseInt(socket.branchId),
                    online: true,
                    socketId: socket.id,
                    timestamp: new Date().toISOString()
                });
                console.log(`[IDENTIFY] 📡 desktop_status_changed → branch_${socket.branchId} online=true`);
            }

            // When a new mobile client joins, send current desktop status immediately
            // so it doesn't have to wait for the next desktop heartbeat
            if (data.type === 'mobile' && socket.branchId) {
                let desktopOnline = false;
                let desktopSocketId = null;
                for (const [socketId, otherSocket] of io.sockets.sockets) {
                    if (otherSocket.clientType === 'desktop'
                        && otherSocket.branchId === socket.branchId) {
                        desktopOnline = true;
                        desktopSocketId = socketId;
                        break;
                    }
                }
                socket.emit('desktop_status_changed', {
                    branchId: parseInt(socket.branchId),
                    online: desktopOnline,
                    socketId: desktopSocketId,
                    timestamp: new Date().toISOString()
                });
                console.log(`[IDENTIFY] 📡 Sent desktop status to new mobile: online=${desktopOnline}`);
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // SHIFT HEARTBEAT: Device liveness for force-takeover decisions
        // Clients emit every 30s while a shift is open.
        // Updates both in-memory Map (for socket lookup) and DB (authoritative).
        // ═══════════════════════════════════════════════════════════════
        socket.on('shift_heartbeat', async ({ employeeId, shiftId, terminalId }, ackFn) => {
            if (!employeeId || !shiftId) return;
            try {
                const key = `${employeeId}_${socket.clientType || 'unknown'}`;
                const existing = activeDeviceSessions.get(key);
                activeDeviceSessions.set(key, {
                    socketId: socket.id,
                    clientType: socket.clientType || existing?.clientType || 'unknown',
                    branchId: socket.branchId || existing?.branchId || null,
                    connectedAt: existing?.connectedAt || Date.now(),
                    lastHeartbeat: Date.now()
                });

                // Check if shift was taken over by another device
                const shiftCheck = await pool.query(
                    `SELECT terminal_id, is_cash_cut_open FROM shifts WHERE id = $1`,
                    [shiftId]
                );
                const shift = shiftCheck.rows[0];

                if (!shift || !shift.is_cash_cut_open) {
                    // Shift closed — tell client to stop
                    console.log(`[Socket] ⚠️ shift_heartbeat: shift ${shiftId} is closed — notifying ${socket.clientType}`);
                    socket.emit('force_logout', {
                        reason: 'shift_closed',
                        message: 'Tu turno fue cerrado desde otro dispositivo'
                    });
                    return;
                }

                if (terminalId && shift.terminal_id && shift.terminal_id !== terminalId) {
                    // Shift was taken by another device — revoke this session
                    console.log(`[Socket] ⚠️ shift_heartbeat: shift ${shiftId} terminal mismatch (DB=${shift.terminal_id}, caller=${terminalId}) — revoking ${socket.clientType}`);
                    socket.emit('force_logout', {
                        reason: 'session_taken',
                        takenByDevice: shift.terminal_id.startsWith('mobile-') ? 'mobile' : 'desktop',
                        message: 'Tu sesión fue tomada por otro dispositivo'
                    });
                    return;
                }

                // All good — update heartbeat
                await pool.query(
                    'UPDATE shifts SET last_heartbeat = NOW() WHERE id = $1 AND is_cash_cut_open = true',
                    [shiftId]
                );
            } catch (err) {
                // Silent — heartbeat failures should not disrupt the client
                console.error(`[Socket] ❌ shift_heartbeat error for employee ${employeeId}:`, err.message);
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // FLUSH COMPLETE: Client signals it has finished syncing pending
        // data after receiving session_revoked_pending_flush.
        // Now safe to send force_logout.
        // ═══════════════════════════════════════════════════════════════
        socket.on('flush_complete', async ({ employeeId }) => {
            const empId = employeeId || socket.user?.employeeId;
            if (!empId) return;

            try {
                await pool.query(
                    `UPDATE employees SET session_revoked_at = NULL, session_revoked_for_device = NULL
                     WHERE id = $1`,
                    [empId]
                );

                console.log(`[Socket] ✅ flush_complete from employee ${empId} — sending force_logout`);

                socket.emit('force_logout', {
                    reason: 'session_revoked',
                    message: 'Datos sincronizados. Tu sesión fue tomada por otro dispositivo.'
                });

                // Remove from session registry
                const key = `${empId}_${socket.clientType || 'unknown'}`;
                activeDeviceSessions.delete(key);
            } catch (err) {
                console.error(`[Socket] Error in flush_complete:`, err.message);
                socket.emit('force_logout', {
                    reason: 'session_revoked',
                    message: 'Tu sesión fue tomada por otro dispositivo.'
                });
            }
        });

        socket.on('scale_alert', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;

            console.log(`[ALERT] 🔍 Datos recibidos:`, {
                branchId: data.branchId,
                eventType: data.eventType,
                severity: data.severity,
                employeeName: data.employeeName
            });

            console.log(`[ALERT] Sucursal ${data.branchId}: ${data.eventType} (${data.severity})`);
            console.log(`[ALERT] Emitiendo a room: ${roomName}`);

            const roomSockets = io.sockets.adapter.rooms.get(roomName);
            const clientCount = roomSockets ? roomSockets.size : 0;
            console.log(`[ALERT] 📊 Clientes en room '${roomName}': ${clientCount}`);
            if (roomSockets) {
                roomSockets.forEach(socketId => {
                    const clientSocket = io.sockets.sockets.get(socketId);
                    console.log(`[ALERT]   → ${socketId} (tipo: ${clientSocket?.clientType || 'unknown'})`);
                });
            }

            // ⚠️ IMPORTANTE: NO guardar en BD aquí ni enviar FCM
            // Desktop ya envía los eventos via REST API (/api/guardian-events)
        });

        socket.on('scale_disconnected', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[SCALE] Sucursal ${data.branchId}: Báscula desconectada (raw data keys: ${Object.keys(data).join(', ')}, branchId type: ${typeof data.branchId})`);
            scaleStatusByBranch.set(Number(data.branchId), {
                status: 'disconnected',
                disconnectedAt: data.disconnectedAt || new Date().toISOString(),
                message: data.message || '',
                updatedAt: new Date().toISOString(),
            });
            // Persist to DB so status survives server restarts
            pool.query(
                `UPDATE branches SET scale_status = 'disconnected', scale_status_updated_at = NOW() WHERE id = $1`,
                [Number(data.branchId)]
            ).catch(e => console.error(`[SCALE] Error persisting disconnected status: ${e.message}`));
            io.to(roomName).emit('scale_disconnected', { ...data, receivedAt: new Date().toISOString() });
            if (shouldSendScaleFcm(data.branchId, 'disconnected')) {
                try {
                    await notificationHelper.notifyScaleDisconnection(data.branchId, { message: data.message });
                } catch (e) {
                    console.error(`[SCALE] Error enviando FCM desconexión: ${e.message}`);
                }
            }
        });

        socket.on('scale_connected', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[SCALE] Sucursal ${data.branchId}: Báscula conectada (raw data keys: ${Object.keys(data).join(', ')}, branchId type: ${typeof data.branchId})`);

            // Verificar si la báscula YA estaba conectada antes de actualizar
            // Si ya estaba conectada, es un re-login/sesión reanudada → no enviar FCM
            let wasAlreadyConnected = false;
            const previousStatus = scaleStatusByBranch.get(Number(data.branchId));
            if (previousStatus) {
                wasAlreadyConnected = previousStatus.status === 'connected';
            } else {
                // Fallback a DB (sobrevive reinicios de Render)
                try {
                    const dbCheck = await pool.query(
                        `SELECT scale_status FROM branches WHERE id = $1`,
                        [Number(data.branchId)]
                    );
                    wasAlreadyConnected = dbCheck.rows[0]?.scale_status === 'connected';
                    if (wasAlreadyConnected) {
                        console.log(`[SCALE] 🔍 Estado previo recuperado de DB: connected (branch ${data.branchId})`);
                    }
                } catch (e) {
                    console.error(`[SCALE] Error consultando estado previo: ${e.message}`);
                }
            }

            scaleStatusByBranch.set(Number(data.branchId), {
                status: 'connected',
                connectedAt: data.connectedAt || new Date().toISOString(),
                message: data.message || '',
                updatedAt: new Date().toISOString(),
            });
            // Persist to DB so status survives server restarts
            pool.query(
                `UPDATE branches SET scale_status = 'connected', scale_status_updated_at = NOW() WHERE id = $1`,
                [Number(data.branchId)]
            ).catch(e => console.error(`[SCALE] Error persisting connected status: ${e.message}`));
            io.to(roomName).emit('scale_connected', { ...data, receivedAt: new Date().toISOString() });

            // Cerrar logs de desconexión huérfanos para esta sucursal
            try {
                const closedLogs = await pool.query(
                    `UPDATE scale_disconnection_logs
                     SET reconnected_at = NOW(),
                         disconnection_status = 'Reconnected',
                         duration_minutes = EXTRACT(EPOCH FROM (NOW() - disconnected_at)) / 60
                     WHERE branch_id = $1 AND reconnected_at IS NULL
                     RETURNING id`,
                    [data.branchId]
                );
                if (closedLogs.rows.length > 0) {
                    console.log(`[SCALE] Cerrados ${closedLogs.rows.length} log(s) huérfanos para branch ${data.branchId}`);
                }
            } catch (e) {
                console.error(`[SCALE] Error cerrando logs huérfanos: ${e.message}`);
            }

            if (wasAlreadyConnected) {
                console.log(`[SCALE] ⏭️ Báscula ya estaba conectada en branch ${data.branchId} - NO se envía FCM (re-login/sesión reanudada)`);
            } else if (shouldSendScaleFcm(data.branchId, 'connected')) {
                try {
                    await notificationHelper.notifyScaleConnection(data.branchId, { message: data.message });
                } catch (e) {
                    console.error(`[SCALE] Error enviando FCM conexión: ${e.message}`);
                }
            }
        });

        // EVENT: Guardian status changed (Desktop → Mobile)
        socket.on('guardian_status_changed', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[GUARDIAN] 🛡️ Estado cambiado: isEnabled=${data.isEnabled}, changedBy=${data.changedBy}`);

            guardianStatusByBranch.set(Number(data.branchId), {
                isEnabled: data.isEnabled,
                changedBy: data.changedBy || 'Sistema',
                changedAt: data.changedAt || new Date().toISOString(),
            });

            io.to(roomName).emit('guardian_status_changed', {
                ...data,
                source: 'desktop',
                receivedAt: new Date().toISOString()
            });
            console.log(`[GUARDIAN] 📡 Evento retransmitido a ${roomName}`);

            try {
                await notificationHelper.notifyGuardianStatusChanged(data.branchId, {
                    isEnabled: data.isEnabled,
                    changedBy: data.changedBy || 'Sistema'
                });
            } catch (e) {
                console.error(`[GUARDIAN] Error enviando FCM: ${e.message}`);
            }
        });

        socket.on('sale_completed', (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[SALE] Sucursal ${data.branchId}: Ticket #${data.ticketNumber} - $${data.total} (source: ${data.source || 'desktop'})`);
            io.to(roomName).emit('sale_completed', { ...data, receivedAt: new Date().toISOString() });
        });

        socket.on('deposit_created', (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[DEPOSIT] Sucursal ${data.branchId}: $${data.amount} (source: ${data.source || 'desktop'})`);
            io.to(roomName).emit('deposit_created', { ...data, receivedAt: new Date().toISOString() });
        });

        socket.on('withdrawal_created', (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[WITHDRAWAL] Sucursal ${data.branchId}: $${data.amount} (source: ${data.source || 'desktop'})`);
            io.to(roomName).emit('withdrawal_created', { ...data, receivedAt: new Date().toISOString() });
        });

        socket.on('weight_update', (data) => {
            const roomName = `branch_${data.branchId}`;
            io.to(roomName).emit('weight_update', { ...data, receivedAt: new Date().toISOString() });
        });

        socket.on('user-login', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[USER-LOGIN] Sucursal ${data.branchId}: ${data.employeeName} (${data.employeeRole}) inició sesión`);

            // No reenviar scaleStatus en el broadcast — la app móvil consulta el estado por separado
            const { scaleStatus, ...broadcastData } = data;
            io.to(roomName).emit('user-login', { ...broadcastData, receivedAt: new Date().toISOString() });

            try {
                await notificationHelper.notifyUserLogin(data.branchId, {
                    employeeId: data.employeeId,
                    employeeName: data.employeeName,
                    branchName: data.branchName,
                    scaleStatus: scaleStatus || 'unknown',
                    isReviewMode: data.isReviewMode || false
                });
                console.log(`[FCM] 📨 Notificación de login enviada a sucursal ${data.branchId}${data.isReviewMode ? ' (modo consulta)' : ''}`);
            } catch (error) {
                console.error(`[USER-LOGIN] ⚠️ Error enviando notificación FCM:`, error.message);
            }
        });

        socket.on('shift_started', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[SHIFT] Sucursal ${data.branchId}: ${data.employeeName} inició turno - $${data.initialAmount}`);

            io.to(roomName).emit('shift_started', { ...data, receivedAt: new Date().toISOString() });

            try {
                // Verificar si el turno YA estaba abierto antes de actualizar
                // Si ya estaba abierto, es una sesión reanudada → no enviar FCM
                const checkQuery = `
                    SELECT is_cash_cut_open FROM shifts
                    WHERE id = $1 AND tenant_id = $2;
                `;
                const checkResult = await pool.query(checkQuery, [data.shiftId, data.tenantId]);
                const wasAlreadyOpen = checkResult.rows[0]?.is_cash_cut_open === true;

                const updateShiftQuery = `
                    UPDATE shifts
                    SET is_cash_cut_open = true,
                        start_time = $1,
                        updated_at = NOW()
                    WHERE id = $2 AND tenant_id = $3
                    RETURNING id;
                `;

                const shiftResult = await pool.query(updateShiftQuery, [
                    data.startTime || new Date().toISOString(),
                    data.shiftId,
                    data.tenantId
                ]);

                if (shiftResult.rows.length > 0) {
                    console.log(`[SHIFT] ✅ Turno #${data.shiftId} actualizado en PostgreSQL`);

                    if (wasAlreadyOpen) {
                        console.log(`[SHIFT] ⏭️ Turno #${data.shiftId} ya estaba abierto - NO se envía FCM (sesión reanudada)`);
                    } else if (shouldSendShiftFcm(data.branchId, 'shift_started')) {
                        await notificationHelper.notifyShiftStarted(data.branchId, {
                            employeeName: data.employeeName,
                            branchName: data.branchName,
                            initialAmount: data.initialAmount,
                            startTime: data.startTime
                        });
                        console.log(`[FCM] 📨 Notificación de inicio de turno enviada a sucursal ${data.branchId}`);
                    }
                } else {
                    console.log(`[SHIFT] ⚠️ No se encontró turno #${data.shiftId} en PostgreSQL`);
                }
            } catch (error) {
                console.error(`[SHIFT] ❌ Error sincronizando turno con PostgreSQL:`, error.message);
            }
        });

        socket.on('shift_ended', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[SHIFT] Sucursal ${data.branchId}: ${data.employeeName} cerró turno - Diferencia: $${data.difference}`);
            console.log(`[SHIFT] DEBUG - Datos recibidos: shiftId=${data.shiftId}, tenantId=${data.tenantId}, branchId=${data.branchId}, endTime=${data.endTime}`);
            console.log(`[SHIFT] DEBUG - Desglose: cash=$${data.totalCashSales}, card=$${data.totalCardSales}, credit=$${data.totalCreditSales}`);

            const clientsInRoom = io.sockets.adapter.rooms.get(roomName);
            const clientCount = clientsInRoom ? clientsInRoom.size : 0;
            console.log(`[SHIFT] 📡 Room '${roomName}' tiene ${clientCount} clientes conectados (socket.id=${socket.id}, clientType=${socket.clientType})`);

            console.log(`[SHIFT] 📤 Retransmitiendo shift_ended a ${roomName}...`);
            io.to(roomName).emit('shift_ended', { ...data, receivedAt: new Date().toISOString() });
            console.log(`[SHIFT] ✅ shift_ended retransmitido a ${roomName}`);

            console.log(`[SHIFT] ℹ️ Shift closure broadcast completado. Sync y notificaciones se manejan vía /api/shifts/sync`);
        });

        // ═══════════════════════════════════════════════════════════════
        // BUSINESS ALERTS - Alertas de negocio (ventas a crédito, abonos, cancelaciones)
        // ═══════════════════════════════════════════════════════════════

        socket.on('credit_sale_created', async (data) => {
            stats.totalEvents++;
            const creditAmount = data.creditAmount || data.total || 0;
            console.log(`[CREDIT_SALE] 💳 Venta a crédito en sucursal ${data.branchId}: Ticket #${data.ticketNumber}, Cliente: ${data.clientName}, Crédito: $${creditAmount}`);

            try {
                await notificationHelper.notifyCreditSaleCreated(data.tenantId, data.branchId, {
                    ticketNumber: data.ticketNumber,
                    total: data.total || creditAmount,
                    creditAmount: creditAmount,
                    clientName: data.clientName,
                    branchName: data.branchName,
                    employeeName: data.employeeName
                });
                console.log(`[CREDIT_SALE] ✅ Notificación FCM enviada para venta a crédito Ticket #${data.ticketNumber}`);
            } catch (error) {
                console.error(`[CREDIT_SALE] ❌ Error enviando notificación FCM:`, error.message);
            }
        });

        socket.on('client_payment_received', async (data) => {
            stats.totalEvents++;
            const paymentAmount = data.paymentAmount || data.amount || 0;
            const remainingBalance = data.remainingBalance || data.newBalance || 0;
            console.log(`[CLIENT_PAYMENT] 💵 Abono recibido en sucursal ${data.branchId}: Cliente: ${data.clientName}, Monto: $${paymentAmount}`);

            try {
                await notificationHelper.notifyClientPaymentReceived(data.tenantId, data.branchId, {
                    paymentAmount: paymentAmount,
                    clientName: data.clientName,
                    branchName: data.branchName,
                    employeeName: data.employeeName,
                    remainingBalance: remainingBalance,
                    paymentMethod: data.paymentMethod || 'Efectivo'
                });
                console.log(`[CLIENT_PAYMENT] ✅ Notificación FCM enviada para abono de ${data.clientName}`);
            } catch (error) {
                console.error(`[CLIENT_PAYMENT] ❌ Error enviando notificación FCM:`, error.message);
            }
        });

        socket.on('sale_cancelled', async (data) => {
            stats.totalEvents++;
            const reason = data.reason || data.cancellationReason || '';
            const employeeName = data.employeeName || data.cancelledByEmployeeName || 'Empleado';
            const authorizedBy = data.authorizedBy || '';
            console.log(`[SALE_CANCELLED] ❌ Venta cancelada en sucursal ${data.branchId}: Ticket #${data.ticketNumber}, Total: $${data.total}`);

            try {
                await notificationHelper.notifySaleCancelled(data.tenantId, data.branchId, {
                    ticketNumber: data.ticketNumber,
                    total: data.total,
                    reason: reason,
                    branchName: data.branchName,
                    employeeName: employeeName,
                    authorizedBy: authorizedBy
                });
                console.log(`[SALE_CANCELLED] ✅ Notificación FCM enviada para cancelación de Ticket #${data.ticketNumber}`);
            } catch (error) {
                console.error(`[SALE_CANCELLED] ❌ Error enviando notificación FCM:`, error.message);
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // PREPARATION MODE - Notificación en tiempo real a administradores
        // ═══════════════════════════════════════════════════════════════
        socket.on('preparation_mode_activated', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;

            console.log(`[PREPMODE] ⚠️ Modo Preparación ACTIVADO en sucursal ${data.branchId} (tenant ${data.tenantId})`);
            console.log(`[PREPMODE]   Sucursal: ${data.branchName}`);
            console.log(`[PREPMODE]   Operador: ${data.operatorName} (ID: ${data.operatorEmployeeId})`);
            console.log(`[PREPMODE]   Autorizado por: ${data.authorizerName} (ID: ${data.authorizedByEmployeeId})`);
            console.log(`[PREPMODE]   Razón: ${data.reason || 'No especificada'}`);

            // Cerrar sesiones huérfanas de esta sucursal (activas > 2h sin desactivar)
            try {
                const orphaned = await pool.query(`
                    UPDATE preparation_mode_logs
                    SET status = 'force_closed',
                        deactivated_at = NOW(),
                        duration_seconds = EXTRACT(EPOCH FROM (NOW() - activated_at)),
                        notes = COALESCE(notes, '') || ' [Auto-cerrado: nueva activación detectada]'
                    WHERE branch_id = $1 AND status = 'active'
                      AND activated_at < NOW() - INTERVAL '2 hours'
                    RETURNING id, activated_at
                `, [data.branchId]);
                if (orphaned.rows.length > 0) {
                    console.log(`[PREPMODE] Cerrados ${orphaned.rows.length} registro(s) huérfano(s) para branch ${data.branchId}`);
                }
            } catch (e) {
                console.error(`[PREPMODE] Error cerrando huérfanos: ${e.message}`);
            }

            socket.to(roomName).emit('preparation_mode_activated', {
                ...data,
                receivedAt: new Date().toISOString()
            });

            // Enviar FCM: siempre si es fuera de ventana, o según debounce normal
            const isSuspicious = data.fueraDeVentana === true;
            if (isSuspicious || shouldSendPrepModeFcm(data.branchId, 'activated')) {
                try {
                    const title = isSuspicious
                        ? 'Guardian — Alistamiento fuera de horario'
                        : 'Guardian — Alistamiento activado';
                    const body = isSuspicious
                        ? `${data.operatorName} activó alistamiento fuera de horario. Razón: ${data.razonActivacion || 'Sin razón'}`
                        : `${data.operatorName} activó alistamiento. Autorizado por: ${data.authorizerName}`;

                    await notificationHelper.notifyPreparationModeActivated(data.tenantId, data.branchId, {
                        operatorName: data.operatorName,
                        authorizerName: data.authorizerName,
                        branchName: data.branchName,
                        reason: data.razonActivacion || data.reason,
                        activatedAt: data.activatedAt,
                        title,
                        body
                    });
                    console.log(`[PREPMODE] 📨 Notificación FCM enviada${isSuspicious ? ' (FUERA DE HORARIO)' : ''} al tenant ${data.tenantId}`);
                } catch (error) {
                    console.error(`[PREPMODE] ⚠️ Error enviando notificación FCM:`, error.message);
                }
            }
        });

        socket.on('preparation_mode_deactivated', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;

            console.log(`[PREPMODE] ✅ Modo Preparación DESACTIVADO en sucursal ${data.branchId} (tenant ${data.tenantId})`);
            console.log(`[PREPMODE]   Sucursal: ${data.branchName}`);
            console.log(`[PREPMODE]   Operador: ${data.operatorName}`);
            console.log(`[PREPMODE]   Duración: ${data.durationFormatted} (${data.severity})`);
            console.log(`[PREPMODE]   razonCierre: '${data.razonCierre || 'NULL'}' | reason: '${data.reason || 'NULL'}'`);

            socket.to(roomName).emit('preparation_mode_deactivated', {
                ...data,
                receivedAt: new Date().toISOString()
            });

            // Enviar FCM: siempre si sesión < 3 min (sospechosa), o según debounce normal
            const durationSecs = parseFloat(data.durationSeconds) || 0;
            const isShortSession = durationSecs < 180; // < 3 minutos
            if (isShortSession || shouldSendPrepModeFcm(data.branchId, 'deactivated')) {
                try {
                    const title = isShortSession
                        ? `Guardian — Sesión muy corta (${data.severity})`
                        : 'Guardian — Alistamiento desactivado';
                    const body = isShortSession
                        ? `${data.operatorName}: alistamiento de ${data.durationFormatted}. Razón: ${data.razonCierre || data.reason || 'Sin razón'}`
                        : `${data.operatorName}: alistamiento de ${data.durationFormatted} (${data.severity})`;

                    await notificationHelper.notifyPreparationModeDeactivated(data.tenantId, data.branchId, {
                        operatorName: data.operatorName,
                        branchName: data.branchName,
                        durationFormatted: data.durationFormatted,
                        severity: data.severity,
                        deactivatedAt: data.deactivatedAt,
                        reason: data.razonCierre || data.reason,
                        weighingCycleCount: data.weighingCycleCount || 0,
                        totalWeightKg: data.totalWeightKg || 0,
                        title,
                        body
                    });
                    console.log(`[PREPMODE] 📨 FCM desactivación enviada${isShortSession ? ' (SESIÓN CORTA)' : ''} al tenant ${data.tenantId}`);
                } catch (error) {
                    console.error(`[PREPMODE] ⚠️ Error enviando notificación FCM de desactivación:`, error.message);
                }
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // MANUAL WEIGHT OVERRIDE
        // ═══════════════════════════════════════════════════════════════
        socket.on('manual_weight_override_changed', async (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            const action = data.isActivated ? 'ACTIVADO' : 'DESACTIVADO';

            console.log(`[WEIGHT-OVERRIDE] Peso Manual ${action} en sucursal ${data.branchId} (tenant ${data.tenantId})`);
            console.log(`[WEIGHT-OVERRIDE]   Sucursal: ${data.branchName}`);
            console.log(`[WEIGHT-OVERRIDE]   Empleado: ${data.employeeName} (ID: ${data.employeeId})`);
            if (data.reason) console.log(`[WEIGHT-OVERRIDE]   Razón: ${data.reason}`);
            if (data.durationFormatted) console.log(`[WEIGHT-OVERRIDE]   Duración: ${data.durationFormatted}`);

            socket.to(roomName).emit('manual_weight_override_changed', {
                ...data,
                receivedAt: new Date().toISOString()
            });

            if (shouldSendPrepModeFcm(data.branchId, `weight_override_${action}`)) {
                try {
                    await notificationHelper.notifyManualWeightOverrideChanged(data.tenantId, data.branchId, {
                        employeeName: data.employeeName,
                        branchName: data.branchName,
                        isActivated: data.isActivated,
                        timestamp: data.timestamp,
                        reason: data.reason,
                        durationFormatted: data.durationFormatted
                    });
                    console.log(`[WEIGHT-OVERRIDE] Notificación FCM enviada a administradores del tenant ${data.tenantId}`);
                } catch (error) {
                    console.error(`[WEIGHT-OVERRIDE] Error enviando notificación FCM:`, error.message);
                }
            }
        });

        socket.on('get_stats', () => {
            socket.emit('stats', {
                ...stats,
                connectedClients: io.sockets.sockets.size,
                uptime: Math.floor((Date.now() - stats.startTime) / 1000),
            });
        });

        // ═══════════════════════════════════════════════════════════════
        // ASSIGNMENT REAL-TIME UPDATES (Edit, Cancel, Liquidate)
        // ═══════════════════════════════════════════════════════════════

        socket.on('assignment_edited', (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[ASSIGNMENT] ✏️ Asignación editada en sucursal ${data.branchId}: ${data.productName} (${data.oldQuantity} → ${data.newQuantity})`);
            io.to(roomName).emit('assignment_edited', { ...data, receivedAt: new Date().toISOString() });
        });

        socket.on('assignment_cancelled', (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[ASSIGNMENT] ❌ Asignación cancelada en sucursal ${data.branchId}: ${data.productName} - Razón: ${data.reason}`);
            io.to(roomName).emit('assignment_cancelled', { ...data, receivedAt: new Date().toISOString() });
        });

        socket.on('assignment_liquidated', (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[ASSIGNMENT] ✅ Liquidación en sucursal ${data.branchId}: ${data.itemCount} items por ${data.employeeName}`);
            io.to(roomName).emit('assignment_liquidated', { ...data, receivedAt: new Date().toISOString() });
        });

        socket.on('assignment_created', (data) => {
            stats.totalEvents++;
            const roomName = `branch_${data.branchId}`;
            console.log(`[ASSIGNMENT] 📦 Nueva asignación en sucursal ${data.branchId}: ${data.assignment?.productName || '?'} (${data.assignment?.assignedQuantity || 0}${data.assignment?.unitAbbreviation || 'kg'}) para empleado ${data.assignment?.employeeId}`);
            io.to(roomName).emit('assignment_created', { ...data, receivedAt: new Date().toISOString() });
        });

        // ═══════════════════════════════════════════════════════════════
        // DESKTOP → MOBILE BROADCASTING
        // ═══════════════════════════════════════════════════════════════

        socket.on('repartidor:assignment-created', (data) => {
            console.log(`[ASSIGNMENT] 📦 Desktop creó asignación para repartidor ${data.assignment?.employeeId}: ${data.assignment?.quantity || 0}kg`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('repartidor:assignment-created', {
                ...data,
                source: 'desktop',
                receivedAt: new Date().toISOString()
            });

            console.log(`[ASSIGNMENT] 📤 Notificación enviada a ${branchRoom}`);
        });

        socket.on('repartidor:return-created', (data) => {
            console.log(`[RETURN] 📦 Desktop registró devolución de repartidor: ${data.return?.quantity || 0}kg (${data.return?.reason || 'sin motivo'})`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('repartidor:return-created', {
                ...data,
                repartidorId: data.return?.employeeId || data.repartidorId || 0,
                quantity: data.return?.quantity || data.quantity || 0,
                source: 'desktop',
                receivedAt: new Date().toISOString()
            });

            console.log(`[RETURN] 📤 Notificación enviada a ${branchRoom}`);
        });

        // ═══════════════════════════════════════════════════════════════
        // MOBILE REPARTIDOR LISTENERS
        // ═══════════════════════════════════════════════════════════════

        socket.on('cashier:drawer-opened-by-repartidor', (data) => {
            const repartidorId = socket.handshake.auth?.repartidorId;

            if (repartidorId && repartidorId !== data.repartidorId) {
                console.log(`[CASHIER] ❌ Security violation: Socket repartidorId=${repartidorId} tried to open drawer for repartidorId=${data.repartidorId}`);
                return;
            }

            console.log(`[CASHIER] 💰 Repartidor ${data.repartidorId} abrió caja desde Mobile con $${data.initialAmount}`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('cashier:drawer-opened-by-repartidor', {
                ...data,
                source: 'mobile',
                receivedAt: new Date().toISOString()
            });

            socket.emit('cashier:drawer-acknowledged', { success: true });
        });

        socket.on('repartidor:expense-created', (data) => {
            const repartidorId = socket.handshake.auth?.repartidorId;

            if (repartidorId && repartidorId !== data.repartidorId) {
                console.log(`[EXPENSE] ❌ Security violation: Socket repartidorId=${repartidorId} tried to create expense for ${data.repartidorId}`);
                return;
            }

            console.log(`[EXPENSE] 💸 Repartidor ${data.repartidorId} registró gasto: $${data.amount} (${data.category})`);
            console.log(`[EXPENSE] 📝 Descripción: ${data.description}`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('repartidor:expense-created', {
                ...data,
                source: 'mobile',
                receivedAt: new Date().toISOString()
            });

            socket.emit('expense:received', {
                success: true,
                expenseId: data.expenseId,
                message: 'Gasto recibido por servidor, Desktop sincronizará a Backend'
            });
        });

        socket.on('repartidor:assignment-completed', (data) => {
            const repartidorId = socket.handshake.auth?.repartidorId;

            if (repartidorId && repartidorId !== data.repartidorId) {
                console.log(`[ASSIGNMENT] ❌ Security violation: Socket repartidorId=${repartidorId} tried to complete assignment for ${data.repartidorId}`);
                return;
            }

            console.log(`[ASSIGNMENT] ✅ Repartidor ${data.repartidorId} completó asignación: ${data.kilosVendidos}kg vendidos (${data.kilosDevueltos}kg devueltos)`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('repartidor:assignment-completed', {
                ...data,
                source: 'mobile',
                receivedAt: new Date().toISOString()
            });

            socket.emit('assignment:completion-received', {
                success: true,
                assignmentId: data.assignmentId,
                message: 'Asignación completada, Desktop creará venta'
            });
        });

        socket.on('request:my-assignments', (data) => {
            const repartidorId = socket.handshake.auth?.repartidorId;

            if (repartidorId && repartidorId !== data.repartidorId) {
                console.log(`[REQUEST] ❌ Security violation: Socket repartidorId=${repartidorId} tried to request assignments for ${data.repartidorId}`);
                return;
            }

            console.log(`[REQUEST] 📋 Repartidor ${data.repartidorId} solicitó sus asignaciones actuales`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('request:my-assignments', {
                repartidorId: data.repartidorId,
                tenantId: data.tenantId,
                branchId: data.branchId,
                lastSyncAt: data.lastSyncAt,
                mobileSocketId: socket.id,
                source: 'mobile-recovery',
                requestedAt: new Date().toISOString()
            });
        });

        socket.on('cashier:drawer-closed', (data) => {
            const repartidorId = socket.handshake.auth?.repartidorId;

            if (repartidorId && repartidorId !== data.repartidorId) {
                console.log(`[CASHIER] ❌ Security violation: Socket repartidorId=${repartidorId} tried to close drawer for ${data.repartidorId}`);
                return;
            }

            console.log(`[CASHIER] 🔒 Repartidor ${data.repartidorId} cerró caja con $${data.finalAmount}`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('cashier:drawer-closed', {
                ...data,
                source: 'mobile',
                receivedAt: new Date().toISOString()
            });

            socket.emit('cashier:closure-acknowledged', {
                success: true,
                drawerId: data.drawerId,
                message: 'Cierre de caja registrado'
            });
        });

        // EVENT: Mobile requests backup from Desktop POS
        socket.on('backup:request', (data) => {
            console.log(`[BACKUP] 📱 Mobile solicitó respaldo - Branch: ${data.branchId}, Tenant: ${data.tenantId}`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('backup:request', {
                tenantId: data.tenantId,
                branchId: data.branchId,
                mobileSocketId: socket.id,
                requestedAt: new Date().toISOString()
            });
        });

        // EVENT: Desktop sends backup result back to Mobile
        socket.on('backup:result', (data) => {
            console.log(`[BACKUP] 💻 Desktop respondió respaldo - Success: ${data.success}, Target: ${data.mobileSocketId}`);

            if (data.mobileSocketId) {
                io.to(data.mobileSocketId).emit('backup:result', {
                    success: data.success,
                    message: data.message,
                    completedAt: new Date().toISOString()
                });
            }
        });

        // EVENT: Mobile sends announcement to Desktop POS
        socket.on('branch:announcement', (data) => {
            console.log(`[ANNOUNCEMENT] 📢 Mobile envió anuncio - Branch: ${data.branchId}, From: ${data.senderName}`);

            const branchRoom = `branch_${data.branchId}`;
            io.to(branchRoom).emit('branch:announcement', {
                message: data.message,
                senderName: data.senderName,
                branchId: data.branchId,
                sentAt: new Date().toISOString()
            });
        });

        // EVENT: Desktop syncs Google profile photo on startup
        socket.on('employee:update-photo', async (data) => {
            try {
                const { employeeId, profilePhotoUrl } = data;
                if (!employeeId || !profilePhotoUrl) return;

                await pool.query(
                    'UPDATE employees SET profile_photo_url = $1 WHERE id = $2',
                    [profilePhotoUrl, employeeId]
                );
                console.log(`[PHOTO] 📸 Profile photo updated for employee ${employeeId}`);
            } catch (error) {
                console.error(`[PHOTO] ❌ Error updating profile photo:`, error.message);
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // DISCONNECT
        // ═══════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════
        // MUTUAL EXCLUSION: Force takeover — new device kicks old device
        // Uses event-based response (force_takeover_result) for cross-library compatibility.
        // ═══════════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════════
        // FORCE TAKEOVER: New device kicks old device for same employee.
        // Uses DB last_heartbeat (authoritative) for online/offline status.
        // Wrapped in transaction with FOR UPDATE to prevent race conditions.
        // Sets session_revoked_at for offline devices (flush-before-logout).
        // ═══════════════════════════════════════════════════════════════
        socket.on('force_takeover', async (data) => {
            const forceEmployeeId = data?.employeeId || socket.user?.employeeId;
            if (!forceEmployeeId) {
                socket.emit('force_takeover_result', { success: false, error: 'No employeeId' });
                return;
            }

            const callerType = socket.clientType || 'unknown';
            const newTerminalId = data?.terminalId;
            const forceEmployeeIdInt = parseInt(forceEmployeeId, 10);
            console.log(`[Socket] 🔄 Force takeover by ${callerType} (socket: ${socket.id}) for employee ${forceEmployeeIdInt} (raw: ${forceEmployeeId}, type: ${typeof forceEmployeeId})`);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Lock the active shift row to prevent concurrent takeovers
                const shiftResult = await client.query(
                    `SELECT id, terminal_id, last_heartbeat, branch_id
                     FROM shifts
                     WHERE employee_id = $1 AND is_cash_cut_open = true
                     FOR UPDATE`,
                    [forceEmployeeIdInt]
                );

                const activeShift = shiftResult.rows[0];
                const OFFLINE_THRESHOLD_MS = 90 * 1000;
                const isOnline = activeShift?.last_heartbeat &&
                    (Date.now() - new Date(activeShift.last_heartbeat).getTime()) < OFFLINE_THRESHOLD_MS;

                // Debug: log all connected sockets to diagnose matching issues
                console.log(`[Socket] 🔍 Force takeover scan — looking for employeeId=${forceEmployeeIdInt} among ${io.sockets.sockets.size} sockets:`);
                for (const [sid, s] of io.sockets.sockets) {
                    const sEmpId = s.user?.employeeId;
                    console.log(`[Socket]   → ${sid} type=${s.clientType || '?'} empId=${sEmpId} (type: ${typeof sEmpId}) match=${parseInt(sEmpId, 10) === forceEmployeeIdInt && sid !== socket.id}`);
                }

                // Kick all connected sockets for this employee (real-time)
                // Use parseInt for type-safe comparison (JWT may store as string vs int)
                let kickedCount = 0;
                const forceLogoutPayload = {
                    reason: 'session_taken',
                    takenByDevice: callerType,
                    message: 'Tu sesión fue tomada por otro dispositivo'
                };
                for (const [sid, s] of io.sockets.sockets) {
                    if (parseInt(s.user?.employeeId, 10) === forceEmployeeIdInt && sid !== socket.id) {
                        s.emit('force_logout', forceLogoutPayload);
                        console.log(`[Socket] 📤 force_logout → ${s.clientType || 'unknown'} (socket: ${sid})`);
                        kickedCount++;
                    }
                }

                // Always broadcast to branch room as safety net
                // Catches: dead sockets not in io.sockets.sockets, reconnected clients,
                // and cases where direct socket kick missed (e.g., stale employeeId)
                if (activeShift?.branch_id) {
                    const branchRoom = `branch_${activeShift.branch_id}`;
                    console.log(`[Socket] 📡 Broadcasting force_logout to room ${branchRoom} (targetEmployeeId=${forceEmployeeIdInt}, directKicks=${kickedCount})`);
                    socket.to(branchRoom).emit('force_logout', {
                        ...forceLogoutPayload,
                        targetEmployeeId: forceEmployeeIdInt
                    });
                }

                // Always set session_revoked_at — the device may have a dead socket
                // and won't receive the force_logout emit. The heartbeat check will catch it.
                const revokedDeviceType = activeShift?.terminal_id?.startsWith('mobile-') ? 'mobile' : 'desktop';
                await client.query(
                    `UPDATE employees SET session_revoked_at = NOW(), session_revoked_for_device = $2
                     WHERE id = $1`,
                    [forceEmployeeIdInt, revokedDeviceType]
                );
                console.log(`[Socket] 🚫 Employee ${forceEmployeeIdInt} marked as revoked (${revokedDeviceType}, isOnline=${isOnline}, directKicks=${kickedCount})`);

                // Transfer shift ownership to the new device
                if (newTerminalId && activeShift) {
                    await client.query(
                        'UPDATE shifts SET terminal_id = $2, last_heartbeat = NOW() WHERE id = $1',
                        [activeShift.id, newTerminalId]
                    );
                    console.log(`[Socket] 📝 Shift ${activeShift.id} terminal_id → ${newTerminalId}`);
                }

                await client.query('COMMIT');
                socket.emit('force_takeover_result', { success: true, wasOnline: kickedCount > 0 });
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                console.error(`[Socket] Error in force_takeover:`, err.message);
                socket.emit('force_takeover_result', { success: false, error: err.message });
            } finally {
                client.release();
            }
        });

        socket.on('disconnect', () => {
            // Clean up session registry (composite key: employeeId_deviceType)
            const empId = socket.user?.employeeId;
            const deviceType = socket.clientType;
            if (empId && deviceType) {
                const sessionKey = `${empId}_${deviceType}`;
                if (activeDeviceSessions.has(sessionKey)) {
                    const session = activeDeviceSessions.get(sessionKey);
                    if (session.socketId === socket.id) {
                        activeDeviceSessions.delete(sessionKey);
                        console.log(`[Socket] 🔌 Employee ${empId} (${deviceType}) removed from session registry (disconnect)`);
                    }
                }
            }

            // Broadcast desktop offline status BEFORE decrementing stats
            if (socket.clientType === 'desktop' && socket.branchId) {
                io.to(`branch_${socket.branchId}`).emit('desktop_status_changed', {
                    branchId: parseInt(socket.branchId),
                    online: false,
                    socketId: socket.id,
                    timestamp: new Date().toISOString()
                });
                console.log(`[DISCONNECT] 📡 desktop_status_changed → branch_${socket.branchId} online=false`);
            }

            if (socket.clientType === 'desktop') stats.desktopClients = Math.max(0, stats.desktopClients - 1);
            else if (socket.clientType === 'mobile') stats.mobileClients = Math.max(0, stats.mobileClients - 1);
            console.log(`[DISCONNECT] ${socket.id} (${socket.clientType})`);
        });
    });
};
