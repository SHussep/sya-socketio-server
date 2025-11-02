# Monitor Deployment Status - PowerShell Script
# Usage: .\monitor_deployment.ps1

$deploymentUrl = "https://sya-socketio-server.onrender.com/api/employees"
$maxAttempts = 60  # 10 minutes (60 * 10 seconds)
$attempt = 0

Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              DEPLOYMENT MONITOR - Employees Endpoint       ║" -ForegroundColor Cyan
Write-Host "║  Esperando que Render complete el despliegue...           ║" -ForegroundColor Cyan
Write-Host "║  Máximo tiempo de espera: 10 minutos                      ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$testPayload = @{
    tenantId = 1
    branchId = 1
    fullName = "Test"
    username = "test"
    email = "test@example.com"
    roleId = 1
} | ConvertTo-Json

while ($attempt -lt $maxAttempts) {
    $attempt++
    $timestamp = Get-Date -Format "HH:mm:ss"

    try {
        $response = Invoke-WebRequest -Uri $deploymentUrl `
            -Method POST `
            -Headers @{"Content-Type" = "application/json"} `
            -Body $testPayload `
            -TimeoutSec 5 `
            -ErrorAction Stop

        if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 400 -or $response.StatusCode -eq 500) {
            Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Green
            Write-Host "║  ✅ ÉXITO! El endpoint /api/employees está ACTIVO         ║" -ForegroundColor Green
            Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Green
            Write-Host ""
            Write-Host "Status Code: $($response.StatusCode)" -ForegroundColor Green
            Write-Host "Timestamp: $timestamp" -ForegroundColor Green
            Write-Host ""
            Write-Host "Próximos pasos:" -ForegroundColor Yellow
            Write-Host "1. Regresa a WinUI y añade un nuevo empleado"
            Write-Host "2. Verifica Visual Studio Output para logs de sincronización"
            Write-Host "3. El empleado debería aparecer en PostgreSQL"
            Write-Host ""
            exit 0
        }
    }
    catch [System.Net.Http.HttpRequestException] {
        if ($_.Exception.Response.StatusCode -eq 404) {
            $waitTime = 60 - ($attempt * 10)
            if ($waitTime -lt 0) { $waitTime = 0 }
            Write-Host "[$timestamp] ⏳ Intento $attempt/$maxAttempts - Aún no disponible (tiempo restante: ~$waitTime segundos)"
        }
        else {
            Write-Host "[$timestamp] ⚠️  Error inesperado: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    catch {
        $waitTime = 60 - ($attempt * 10)
        if ($waitTime -lt 0) { $waitTime = 0 }
        Write-Host "[$timestamp] ⏳ Intento $attempt/$maxAttempts - Esperando... (~$waitTime segundos restantes)"
    }

    if ($attempt -lt $maxAttempts) {
        Start-Sleep -Seconds 10
    }
}

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Red
Write-Host "║  ❌ TIMEOUT - El endpoint no se activó después de 10 min  ║" -ForegroundColor Red
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Red
Write-Host ""
Write-Host "Posibles causas:" -ForegroundColor Yellow
Write-Host "1. Render tiene un error en el build"
Write-Host "2. El archivo employees.js no se sincronizó correctamente"
Write-Host "3. Hay un error de sintaxis en server.js"
Write-Host ""
Write-Host "Soluciones:" -ForegroundColor Cyan
Write-Host "1. Verifica los logs en: https://dashboard.render.com"
Write-Host "2. Busca errores en la sección 'Build & Deploy Logs'"
Write-Host "3. Si hay error, copia la salida completa y pídeme ayuda"
Write-Host ""

exit 1
