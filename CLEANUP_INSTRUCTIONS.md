# 🧹 Instrucciones para Limpiar Base de Datos

Este documento explica cómo usar el endpoint `/api/admin/cleanup` para limpiar datos transaccionales y tener una BD limpia para testing.

---

## ✅ ¿Qué se elimina?

### Datos Transaccionales (SE ELIMINAN):
- ✅ **Ventas** y **Ventas Detalle**
- ✅ **Repartidor Assignments**
- ✅ **Gastos** (Expenses)
- ✅ **Depósitos** y **Retiros** (Deposits/Withdrawals)
- ✅ **Cortes de Caja** (Cash Cuts)
- ✅ **Turnos** (Shifts)
- ✅ **Sesiones** y **Dispositivos** (Sessions/Devices)
- ✅ **Backups Metadata**
- ✅ **Guardian Events** (si existen)

### Datos Maestros (SE MANTIENEN):
- ❌ **Subscriptions** (Basic, Pro, Enterprise)
- ❌ **Roles** (Administrador, Encargado, Repartidor, Ayudante)
- ❌ **Tenants** (tu empresa)
- ❌ **Branches** (tus sucursales)
- ❌ **Employees** (tus empleados)
- ❌ **Customers** (tus clientes)
- ❌ **Productos** (tu catálogo)

---

## 📋 Opción 1: Usar PowerShell (Recomendado)

### Paso 1: Hacer Login y Obtener Token

```powershell
# 1. Login para obtener token
$loginResponse = Invoke-RestMethod -Uri "https://sya-socketio-server.onrender.com/api/auth/desktop-login" `
    -Method POST `
    -ContentType "application/json" `
    -Body (@{
        email = "saul.hussep@gmail.com"
        password = "121212"
        branchId = 1
    } | ConvertTo-Json)

# 2. Extraer token
$token = $loginResponse.data.token

# 3. Verificar que obtuviste el token
Write-Host "Token obtenido: $($token.Substring(0,20))..."
```

### Paso 2: Ejecutar Limpieza

```powershell
# Ejecutar cleanup
$cleanupResponse = Invoke-RestMethod -Uri "https://sya-socketio-server.onrender.com/api/admin/cleanup" `
    -Method POST `
    -ContentType "application/json" `
    -Headers @{
        Authorization = "Bearer $token"
    }

# Ver resultado
$cleanupResponse | ConvertTo-Json -Depth 10
```

### Paso 3: Verificar Estado de la BD

```powershell
# Ver estado actual de la BD
$statusResponse = Invoke-RestMethod -Uri "https://sya-socketio-server.onrender.com/api/admin/status" `
    -Method GET `
    -Headers @{
        Authorization = "Bearer $token"
    }

# Mostrar resultado
$statusResponse.data
```

---

## 📋 Opción 2: Usar cURL (Bash/CMD)

### Paso 1: Login

```bash
# Obtener token (guárdalo en una variable)
curl -X POST https://sya-socketio-server.onrender.com/api/auth/desktop-login \
  -H "Content-Type: application/json" \
  -d '{"email":"saul.hussep@gmail.com","password":"121212","branchId":1}' \
  | jq -r '.data.token'
```

### Paso 2: Cleanup (reemplaza YOUR_TOKEN)

```bash
curl -X POST https://sya-socketio-server.onrender.com/api/admin/cleanup \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Paso 3: Verificar Estado

```bash
curl -X GET https://sya-socketio-server.onrender.com/api/admin/status \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  | jq
```

---

## 📋 Opción 3: Script PowerShell Completo

Crea un archivo `cleanup.ps1`:

```powershell
# cleanup.ps1 - Limpieza de BD PostgreSQL
param(
    [string]$Email = "saul.hussep@gmail.com",
    [string]$Password = "121212",
    [int]$BranchId = 1
)

Write-Host "🔐 Autenticando..." -ForegroundColor Cyan

try {
    # Login
    $loginResponse = Invoke-RestMethod -Uri "https://sya-socketio-server.onrender.com/api/auth/desktop-login" `
        -Method POST `
        -ContentType "application/json" `
        -Body (@{
            email = $Email
            password = $Password
            branchId = $BranchId
        } | ConvertTo-Json)

    $token = $loginResponse.data.token
    Write-Host "✅ Token obtenido" -ForegroundColor Green

    # Estado ANTES
    Write-Host "`n📊 Estado de BD ANTES de limpieza:" -ForegroundColor Yellow
    $statusBefore = Invoke-RestMethod -Uri "https://sya-socketio-server.onrender.com/api/admin/status" `
        -Method GET `
        -Headers @{ Authorization = "Bearer $token" }

    $statusBefore.data | Format-Table

    # Confirmar
    Write-Host "`n⚠️  ¿Deseas limpiar todos los datos transaccionales? (s/n): " -ForegroundColor Red -NoNewline
    $confirm = Read-Host

    if ($confirm -ne "s") {
        Write-Host "❌ Operación cancelada" -ForegroundColor Red
        exit
    }

    # Cleanup
    Write-Host "`n🧹 Ejecutando limpieza..." -ForegroundColor Cyan
    $cleanupResponse = Invoke-RestMethod -Uri "https://sya-socketio-server.onrender.com/api/admin/cleanup" `
        -Method POST `
        -ContentType "application/json" `
        -Headers @{ Authorization = "Bearer $token" }

    Write-Host "✅ Limpieza completada" -ForegroundColor Green
    Write-Host "`n📝 Registros eliminados:" -ForegroundColor Yellow
    $cleanupResponse.deleted | Format-Table

    # Estado DESPUÉS
    Write-Host "`n📊 Estado de BD DESPUÉS de limpieza:" -ForegroundColor Yellow
    $statusAfter = Invoke-RestMethod -Uri "https://sya-socketio-server.onrender.com/api/admin/status" `
        -Method GET `
        -Headers @{ Authorization = "Bearer $token" }

    $statusAfter.data | Format-Table

    Write-Host "`n✅ Datos maestros preservados:" -ForegroundColor Green
    $cleanupResponse.masters | Format-Table

} catch {
    Write-Host "❌ Error: $_" -ForegroundColor Red
}
```

### Ejecutar:

```powershell
.\cleanup.ps1
```

---

## 🔧 Troubleshooting

### Error: "Token inválido o expirado"
- Los tokens expiran después de 1 hora
- Vuelve a hacer login para obtener un token nuevo

### Error: "Token no proporcionado"
- Verifica que estás enviando el header `Authorization: Bearer YOUR_TOKEN`
- El formato debe ser exacto con el espacio después de "Bearer"

### Error: "relation does not exist"
- Algunas tablas (como Guardian) no existen aún
- El script maneja estos errores automáticamente con try/catch

---

## 📌 Notas Importantes

1. **No resetear la BD en cada deploy**: La BD solo se limpia cuando TÚ ejecutas el endpoint manualmente
2. **Seguridad**: El endpoint requiere autenticación JWT válida
3. **Rollback**: Si hay error, toda la transacción se revierte (ROLLBACK)
4. **Logs**: El servidor muestra logs detallados de cada tabla limpiada

---

## 🎯 Cuándo usar cleanup

- ✅ Antes de hacer pruebas de flujos completos
- ✅ Después de detectar datos inconsistentes
- ✅ Al iniciar ciclo de testing
- ❌ NO en producción con datos reales

---

## ✅ Resultado Esperado

Después de ejecutar cleanup exitosamente:

```json
{
  "success": true,
  "message": "Limpieza de datos transaccionales completada - Maestros intactos",
  "deleted": {
    "ventas_detalle": 5,
    "ventas": 2,
    "expenses": 0,
    "shifts": 1,
    "devices": 0,
    ...
  },
  "remaining": {
    "ventas": 0,
    "ventas_detalle": 0,
    "expenses": 0,
    "shifts": 0
  },
  "masters": [
    { "tabla": "Subscriptions", "count": 3 },
    { "tabla": "Roles", "count": 4 },
    { "tabla": "Tenants", "count": 1 },
    { "tabla": "Branches", "count": 1 },
    { "tabla": "Employees", "count": 1 }
  ]
}
```

🎉 **¡BD limpia y lista para testing!**
