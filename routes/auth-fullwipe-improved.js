// MEJORÍA PARA FullWipeBranchAsync
// Este es el código mejorado que debe reemplazar las líneas 1150-1185 en routes/auth.js

            console.log(`[Branch Full Wipe] Limpieza completa de branch ${branch.name} (ID: ${branchId})`);

            // 3. ELIMINAR TODOS LOS DATOS relacionados al branch (FULL WIPE COMPLETO)

            // 3.1. Eliminar dispositivos
            const devicesResult = await client.query(
                'DELETE FROM devices WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${devicesResult.rowCount} dispositivos eliminados`);

            // 3.2. Eliminar sesiones asociadas a empleados de esta sucursal
            const sessionsResult = await client.query(
                `DELETE FROM sessions WHERE employee_id IN (
                    SELECT id FROM employees WHERE id IN (
                        SELECT employee_id FROM employee_branches WHERE branch_id = $1
                    )
                )`,
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${sessionsResult.rowCount} sesiones eliminadas`);

            // 3.3. Eliminar ventas de esta sucursal
            const salesResult = await client.query(
                'DELETE FROM sales WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${salesResult.rowCount} ventas eliminadas`);

            // 3.4. Eliminar gastos de esta sucursal
            const expensesResult = await client.query(
                'DELETE FROM expenses WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${expensesResult.rowCount} gastos eliminados`);

            // 3.5. Eliminar shifts (turnos) de esta sucursal
            const shiftsResult = await client.query(
                'DELETE FROM shifts WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${shiftsResult.rowCount} shifts eliminados`);

            // 3.6. Eliminar eventos de guardián/alertas de báscula
            const eventsResult = await client.query(
                'DELETE FROM guardian_events WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${eventsResult.rowCount} eventos eliminados`);

            // 3.7. Eliminar relaciones employee_branches (permisos de empleados)
            const employeeBranchesResult = await client.query(
                'DELETE FROM employee_branches WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${employeeBranchesResult.rowCount} relaciones empleado-sucursal eliminadas`);

            // 3.8. Actualizar empleados que tengan este branch como main_branch
            const employeesMainBranchResult = await client.query(
                'UPDATE employees SET main_branch_id = NULL WHERE main_branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${employeesMainBranchResult.rowCount} empleados actualizados (main_branch removido)`);

            // 3.9. Eliminar metadata de backups
            const backupsResult = await client.query(
                'DELETE FROM backup_metadata WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] ✅ ${backupsResult.rowCount} registros de backup eliminados`);

            // 3.10. Actualizar nombre de la sucursal a "Reestablecida"
            await client.query(
                `UPDATE branches SET name = $1, branch_code = $2 WHERE id = $3`,
                [`Sucursal Reestablecida ${new Date().getTime()}`, `RESET_${branchId}_${Date.now()}`, branchId]
            );
            console.log(`[Branch Full Wipe] ✅ Datos de sucursal reestablecidos`);

            // NOTA: NO eliminamos el branch ni el tenant, solo limpiamos todos los datos
            // El branch quedará vacío y listo para ser reutilizado con nueva BD local

            await client.query('COMMIT');

            console.log(`[Branch Full Wipe] ✅ Sucursal "${branch.name}" COMPLETAMENTE limpiada`);

            // Retornar resumen detallado
            res.json({
                success: true,
                message: `La sucursal "${branch.name}" ha sido COMPLETAMENTE limpiada. Puedes iniciar desde cero.`,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code
                },
                deletedItems: {
                    devices: devicesResult.rowCount,
                    sessions: sessionsResult.rowCount,
                    sales: salesResult.rowCount,
                    expenses: expensesResult.rowCount,
                    shifts: shiftsResult.rowCount,
                    events: eventsResult.rowCount,
                    employeeBranches: employeeBranchesResult.rowCount,
                    employeesUpdated: employeesMainBranchResult.rowCount,
                    backups: backupsResult.rowCount
                }
            });
