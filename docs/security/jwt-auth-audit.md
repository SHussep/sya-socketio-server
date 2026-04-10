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

## 2. CRÍTICO: Sin revocación de refresh tokens — PENDIENTE

**Problema**: Los refresh tokens son JWT stateless. No hay tabla en la base de datos para rastrearlos. Si un token es robado, no hay forma de invalidarlo — sigue siendo válido hasta que expire (30 días).

### Estado actual
- Refresh tokens: `expiresIn: '30d'` (rolling — cada refresh emite uno nuevo)
- Sin claim `jti` (JWT ID) — no se pueden identificar tokens individuales
- Sin tabla de blacklist — no se puede revocar en logout
- Sin tracking de "familia" de tokens — no se detecta reuso

### ⚠️ Riesgo de breaking change

Los refresh tokens existentes en producción NO tienen `jti`. Si se implementa la verificación contra la tabla `refresh_tokens` sin un periodo de transición, **todos los usuarios activos serían forzados a re-login** dentro de los primeros 15 minutos (cuando su access token expire y el refresh falle).

- **Flutter**: El interceptor recibiría 401 en refresh → redirige a login → re-auth con Google/Apple (semi-transparente)
- **Desktop**: `GetValidJwtTokenAsync` fallaría → el usuario debe volver a escribir usuario y contraseña manualmente (disruptivo)

### Estrategia de migración segura (3 fases)

#### Fase 1: Migración SQL + deploy con fallback legacy (día 0)

**1a.** Crear tabla:
```sql
CREATE TABLE refresh_tokens (
    id SERIAL PRIMARY KEY,
    jti UUID NOT NULL UNIQUE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    replaced_by_jti UUID,
    device_info TEXT,
    ip_address TEXT
);
CREATE INDEX idx_refresh_tokens_jti ON refresh_tokens(jti);
CREATE INDEX idx_refresh_tokens_employee ON refresh_tokens(employee_id);
```

**1b.** Agregar `jti` a TODOS los endpoints que emiten tokens (login, signup, refresh):
```javascript
const crypto = require('crypto');

const jti = crypto.randomUUID();
const refreshToken = jwt.sign(
    { employeeId: employee.id, tenantId: tenant.id, jti },
    JWT_SECRET,
    { expiresIn: '30d' }
);

// Guardar en tabla
await pool.query(
    `INSERT INTO refresh_tokens (jti, employee_id, tenant_id, expires_at, device_info, ip_address)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5)`,
    [jti, employee.id, tenant.id, req.headers['user-agent'], req.ip]
);
```

**1c.** En el handler de refresh, usar fallback legacy:
```javascript
const decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ['HS256'] });

if (decoded.jti) {
    // Token NUEVO (con jti): verificar en tabla
    const tokenRecord = await pool.query(
        'SELECT * FROM refresh_tokens WHERE jti = $1 AND revoked_at IS NULL',
        [decoded.jti]
    );
    if (tokenRecord.rows.length === 0) {
        return res.status(401).json({ message: 'Token revocado' });
    }
    // Revocar el anterior
    await pool.query(
        'UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by_jti = $1 WHERE jti = $2',
        [newJti, decoded.jti]
    );
} else {
    // Token VIEJO (sin jti): aceptar como legacy
    // El nuevo token que se emita ya tendrá jti → migración transparente
    console.log(`[Auth] Legacy refresh token sin jti para employee ${decoded.employeeId} — migrando a jti`);
}

// Emitir nuevos tokens CON jti (ambos casos)
const newJti = crypto.randomUUID();
// ... generar y guardar nuevo token con jti
```

**Resultado**: Ningún usuario nota el cambio. Tokens legacy se aceptan y se reemplazan por tokens con `jti` automáticamente.

#### Fase 2: Endpoint de logout (día 0, junto con fase 1)

```javascript
router.post('/logout', authenticateToken, async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.json({ success: true }); // Logout sin token = solo limpiar cliente
    }
    try {
        const decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ['HS256'] });
        if (decoded.jti) {
            await pool.query(
                'UPDATE refresh_tokens SET revoked_at = NOW() WHERE jti = $1',
                [decoded.jti]
            );
        }
    } catch (e) {
        // Token ya expirado o inválido — logout de todas formas
    }
    res.json({ success: true });
});
```

#### Fase 3: Remover fallback legacy (día 30+)

Después de 30 días, todos los refresh tokens sin `jti` habrán expirado naturalmente. Se puede:
1. Eliminar el bloque `else` (legacy) del handler de refresh
2. Hacer `jti` obligatorio: rechazar tokens sin `jti` con 401

### Endpoints que emiten tokens (todos deben agregar jti)

| Endpoint | Archivo | Emite refresh token |
|----------|---------|:-------------------:|
| `POST /api/auth/desktop-login` | `controllers/auth/loginMethods.js:226` | ✅ |
| `POST /api/auth/mobile-login` | `controllers/auth/loginMethods.js:454` | ✅ |
| `POST /api/auth/google-signup` | `controllers/auth/signupMethods.js:396` | ✅ |
| `POST /api/auth/google-login` | `controllers/auth/signupMethods.js:616` | ✅ |
| `POST /api/auth/apple-login` | `controllers/auth/appleMethods.js:184` | ✅ |
| `POST /api/auth/apple-signup` | `controllers/auth/appleMethods.js:415` | ✅ |
| `POST /api/auth/refresh-token` | `controllers/auth/signupMethods.js:99` | ✅ (rolling) |
| `POST /api/auth/master-login` (mobile) | `routes/masterAuth.js:234` | ✅ |
| `POST /api/auth/master-login` (desktop) | `routes/masterAuth.js:308` | ✅ (condicional) |

### Limpieza periódica

Agregar cron job o cleanup en el server para eliminar tokens expirados:
```javascript
// Ejecutar diariamente
await pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
```

### Testing después de implementar

1. **Login nuevo** → verificar que el refresh token tiene `jti` y aparece en la tabla
2. **Refresh con token legacy** (sin jti) → debe aceptarse y emitir token nuevo con `jti`
3. **Refresh con token nuevo** (con jti) → debe verificar en tabla y rotar
4. **Logout** → refresh token se marca `revoked_at` → siguiente refresh falla con 401
5. **Reuso de token revocado** → debe devolver 401
6. **Después de 30 días** → remover fallback legacy y verificar que tokens sin `jti` se rechazan

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
