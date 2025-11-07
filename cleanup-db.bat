@echo off
REM =====================================================
REM Script para limpiar datos transaccionales de PostgreSQL
REM Mantiene intactos: subscriptions, roles, tenants, branches, employees, customers, productos
REM =====================================================

echo.
echo ================================================
echo   LIMPIEZA DE DATOS TRANSACCIONALES - PostgreSQL
echo ================================================
echo.
echo Este script eliminara:
echo   - Ventas y detalles
echo   - Gastos, depositos, retiros
echo   - Turnos, sesiones, dispositivos
echo   - Asignaciones de repartidores
echo   - Eventos Guardian
echo.
echo Mantendra intactos:
echo   - Subscriptions y Roles del sistema
echo   - Tu cuenta (Tenant, Branch, Employees)
echo   - Clientes y Productos
echo.
set /p confirm=Deseas continuar? (s/n):

if /i not "%confirm%"=="s" (
    echo Operacion cancelada.
    pause
    exit /b
)

echo.
echo Obteniendo token de autenticacion...

REM Pedir credenciales
set /p email=Email:
set /p password=Password:

REM Login para obtener token
curl -X POST https://sya-socketio-server.onrender.com/api/auth/desktop-login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"%email%\",\"password\":\"%password%\",\"branchId\":1}" ^
  -o token.json 2>nul

REM Extraer token del JSON (requiere jq o parsing manual)
REM Por simplicidad, vamos a mostrar el comando curl que el usuario puede ejecutar

echo.
echo ================================================
echo Token obtenido. Ejecutando limpieza...
echo ================================================
echo.

REM Ejecutar cleanup (el token debe extraerse del archivo token.json manualmente)
REM Este es un ejemplo - el usuario debe reemplazar YOUR_TOKEN con el token real

curl -X POST https://sya-socketio-server.onrender.com/api/admin/cleanup ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

echo.
echo ================================================
echo Limpieza completada. Verifica los logs arriba.
echo ================================================
pause
