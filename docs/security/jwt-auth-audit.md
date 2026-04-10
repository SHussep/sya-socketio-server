# Auditoría de Seguridad: Sistema JWT / Autenticación

**Fecha**: 2026-04-09
**Proyecto**: SYA Tortillerias - sya-socketio-server
**Estado**: Fixes #1, #3, #4, #5 aplicados (2026-04-09) — Fix #2 (refresh token revocation) y #6 (Redis) pendientes

---

## Resumen

Se auditó el sistema completo de autenticación JWT. El sistema tiene buenas bases (bcrypt, rate limiting, CORS, Helmet) pero tiene **inconsistencias críticas** en expiración de tokens y carece de mecanismo de revocación.

---

## 1. ~~CRÍTICO: Expiración de JWT inconsistente~~ ✅ CORREGIDO

**Problema**: Los access tokens tienen duraciones radicalmente diferentes según el endpoint de autenticación. Algunos duran 7 días, lo cual es excesivo para un access token.

### Estado actual

| Endpoint | Archivo | Línea | Expiración | Debería ser |
|----------|---------|:-----:|:----------:|:-----------:|
| `POST /api/auth/desktop-login` | `controllers/auth/loginMethods.js` | 216 | 15m | 15m ✅ |
| `POST /api/auth/mobile-login` | `controllers/auth/loginMethods.js` | 444 | 15m | 15m ✅ |
| `POST /api/auth/google-signup` | `controllers/auth/signupMethods.js` | 386 | 15m | 15m ✅ |
| `POST /api/auth/google-login` | `controllers/auth/signupMethods.js` | (dentro de googleLogin) | 15m | 15m ✅ |
| `POST /api/auth/apple-login` | `controllers/auth/appleMethods.js` | 179 | 15m | 15m ✅ |
| `POST /api/auth/apple-signup` | `controllers/auth/appleMethods.js` | 411 | 15m | 15m ✅ |
| `POST /api/auth/master-login` (mobile) | `routes/masterAuth.js` | 224 | 15m | 15m ✅ |
| `POST /api/auth/master-login` (desktop) | `routes/masterAuth.js` | 312 | 15m | 15m ✅ |
| `POST /api/auth/refresh-token` | `controllers/auth/signupMethods.js` | 88 | 15m | 15m ✅ |

### Fix requerido

Cambiar todas las instancias de `expiresIn: '7d'` y `expiresIn: '24h'` a `expiresIn: '15m'`.

**Archivos a modificar**:
- `controllers/auth/signupMethods.js` — línea 386: `'7d'` → `'15m'`
- `controllers/auth/signupMethods.js` — buscar `googleLogin`, misma corrección
- `controllers/auth/appleMethods.js` — línea 179: `'7d'` → `'15m'`
- `controllers/auth/appleMethods.js` — línea 411: `'7d'` → `'15m'`
- `routes/masterAuth.js` — línea 312: `'24h'` → `'15m'`

**Por qué es seguro**: El refresh token (30 días) se encarga de mantener la sesión activa. El access token solo necesita durar lo suficiente para una operación normal. Flutter y Desktop ya tienen auto-refresh implementado via `GetValidJwtTokenAsync` y el interceptor de Flutter.

---

## 2. CRÍTICO: Sin revocación de refresh tokens

**Problema**: Los refresh tokens son JWT stateless. No hay tabla en la base de datos para rastrearlos. Si un token es robado, no hay forma de invalidarlo — sigue siendo válido hasta que expire (30 días).

### Estado actual
- Refresh tokens: `expiresIn: '30d'` (rolling — cada refresh emite uno nuevo)
- Sin claim `jti` (JWT ID) — no se pueden identificar tokens individuales
- Sin tabla de blacklist — no se puede revocar en logout
- Sin tracking de "familia" de tokens — no se detecta reuso

### Fix requerido (en orden)

**Paso 1**: Agregar `jti` claim a todos los tokens:
```javascript
const crypto = require('crypto');

// Al generar cualquier token:
const jti = crypto.randomUUID();
const refreshToken = jwt.sign(
    { employeeId: employee.id, tenantId: tenant.id, jti },
    JWT_SECRET,
    { expiresIn: '30d' }
);
```

**Paso 2**: Crear tabla de refresh tokens:
```sql
CREATE TABLE refresh_tokens (
    id SERIAL PRIMARY KEY,
    jti UUID NOT NULL UNIQUE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    replaced_by_jti UUID,  -- Para tracking de rotación
    device_info TEXT,
    ip_address TEXT
);
CREATE INDEX idx_refresh_tokens_jti ON refresh_tokens(jti);
CREATE INDEX idx_refresh_tokens_employee ON refresh_tokens(employee_id);
```

**Paso 3**: Al hacer refresh, verificar en la tabla:
```javascript
// En refreshToken handler:
const decoded = jwt.verify(refreshToken, JWT_SECRET);

// Verificar que no esté revocado
const tokenRecord = await pool.query(
    'SELECT * FROM refresh_tokens WHERE jti = $1 AND revoked_at IS NULL',
    [decoded.jti]
);
if (tokenRecord.rows.length === 0) {
    return res.status(401).json({ message: 'Token revocado' });
}

// Revocar el anterior y emitir nuevo
await pool.query('UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by_jti = $1 WHERE jti = $2',
    [newJti, decoded.jti]);
```

**Paso 4**: Endpoint de logout:
```javascript
router.post('/logout', authenticateToken, async (req, res) => {
    const { refreshToken } = req.body;
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE jti = $1', [decoded.jti]);
    res.json({ success: true });
});
```

---

## 3. ~~MEDIO: bcrypt rounds inconsistentes~~ ✅ CORREGIDO

**Problema**: Algunos endpoints usan 10 rounds, otros usan 12. OWASP recomienda mínimo 12.

### Archivos corregidos (todos usan `BCRYPT_ROUNDS` de `config/security.js`):

| Archivo | Estado |
|---------|--------|
| `controllers/auth/signupMethods.js` | ✅ `BCRYPT_ROUNDS` (12) |
| `controllers/auth/appleMethods.js` | ✅ `BCRYPT_ROUNDS` (12) |
| `controllers/auth/tenantMethods.js` | ✅ `BCRYPT_ROUNDS` (12) |
| `routes/employees.js` | ✅ `BCRYPT_ROUNDS` (12) |
| `routes/tenants.js` | ✅ `BCRYPT_ROUNDS` (12) |

**Ya están bien (12 rounds):**
- `routes/pin.js` líneas 47 y 136
- `routes/superadmin.js` línea 2238

### Fix recomendado

Crear una constante centralizada:
```javascript
// En un archivo como config/security.js:
const BCRYPT_ROUNDS = 12;
module.exports = { BCRYPT_ROUNDS };

// Uso:
const { BCRYPT_ROUNDS } = require('../config/security');
const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
```

**Nota**: Los hashes existentes con 10 rounds siguen funcionando con `bcrypt.compare()` — no es necesario migrar passwords existentes.

---

## 4. ~~MEDIO: PIN de superadmin en header HTTP~~ ✅ CORREGIDO (backwards compatible)

**Archivo**: `middleware/auth.js`, líneas 100-116

**Problema**: El PIN se envía en el header `x-admin-pin`. Los headers HTTP pueden quedar registrados en:
- Logs del servidor / reverse proxy (Nginx, Cloudflare)
- Herramientas de monitoreo
- Browser history (si aplica)

### Fix requerido

Cambiar de header a body:
```javascript
// ANTES (inseguro):
const pin = req.headers['x-admin-pin'];

// DESPUÉS:
const pin = req.body?.adminPin || req.headers['x-admin-pin']; // Backwards compatible
```

Y actualizar el cliente (Flutter/Desktop) para enviar el PIN en el body en vez del header.

---

## 5. BAJO: Rate limiting en memoria

**Archivo**: `middleware/rateLimiter.js`

**Problema**: Los contadores de rate limiting se almacenan en memoria del proceso Node.js. Se pierden al reiniciar el servidor.

**Configuración actual** (funciona bien, pero no persiste):
- Login: 5 intentos / 15 min → lockout 30 min
- Superadmin: 3 intentos / 15 min → lockout 1 hora
- Sync: 100 req / min → lockout 5 min

### Fix futuro (cuando escale)

Migrar a Redis cuando haya múltiples instancias del servidor. Por ahora con una sola instancia en Render, el rate limiting en memoria es aceptable.

---

## 6. ~~BAJO: Sin validación de algoritmo JWT~~ ✅ CORREGIDO

**Archivo**: `middleware/auth.js`

**Problema**: `jwt.verify()` no especifica el algoritmo esperado, lo que en teoría permite ataques de confusión de algoritmo.

### Fix:
```javascript
jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => { ... });
```

Aplicar en:
- `middleware/auth.js` — línea 18 (authenticateToken simple)
- `middleware/auth.js` — línea 48 (factory middleware)
- `socket/auth.js` — verificación de socket
- `controllers/auth/signupMethods.js` — línea 27 (refresh token verify)

---

## Prioridad de implementación

| # | Tarea | Severidad | Esfuerzo | Archivos |
|:-:|-------|:---------:|:--------:|:--------:|
| 1 | ~~Estandarizar JWT a 15m~~ | ✅ | — | Aplicado 2026-04-09 |
| 2 | Agregar `jti` + tabla refresh_tokens | CRÍTICA | 4-6 hrs | migración SQL + 4 controllers |
| 3 | ~~bcrypt 12 rounds + constante~~ | ✅ | — | Aplicado 2026-04-09 |
| 4 | ~~PIN de body en vez de header~~ | ✅ | — | Aplicado 2026-04-09 (backwards compatible) |
| 5 | ~~Algoritmo explícito en jwt.verify~~ | ✅ | — | Aplicado 2026-04-09 |
| 6 | Redis rate limiting | BAJA | Futuro | cuando escale |

---

## Testing después de cambios

1. **Después de fix #1 (expiración)**:
   - Registrarse desde Flutter con Google → verificar que el token expira en 15 min
   - Verificar que auto-refresh sigue funcionando (Flutter interceptor + Desktop UserConfigService)
   - Login desde master → verificar expiración

2. **Después de fix #2 (revocación)**:
   - Hacer login → obtener refresh token → hacer logout → intentar refresh → debe fallar
   - Verificar que refresh token rotation funciona (el viejo se invalida)

3. **Después de fix #3 (bcrypt)**:
   - Crear empleado nuevo → verificar que login funciona
   - Verificar que usuarios existentes (hash con 10 rounds) siguen pudiendo hacer login

---

## Referencia: Archivos del sistema de auth

```
sya-socketio-server/
├── middleware/
│   ├── auth.js                    # authenticateToken, superadmin PIN
│   ├── rateLimiter.js             # Rate limiting en memoria
│   ├── deviceAuth.js              # Validación de dispositivos
│   └── adminAuth.js               # Auth de admin
├── controllers/auth/
│   ├── index.js                   # Router principal de auth
│   ├── loginMethods.js            # desktop-login, mobile-login
│   ├── signupMethods.js           # google-signup, google-login, refresh-token
│   ├── appleMethods.js            # apple-login, apple-signup
│   └── tenantMethods.js           # registro de tenant
├── routes/
│   ├── auth.js                    # Monta controllers/auth
│   ├── masterAuth.js              # Master login (soporte técnico)
│   ├── pin.js                     # PIN de kiosk
│   ├── employees.js               # CRUD empleados (incluye hash password)
│   └── superadmin.js              # Panel superadmin
└── socket/
    └── auth.js                    # Autenticación de Socket.IO
```
