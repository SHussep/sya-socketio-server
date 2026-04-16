# Super-Admin RS256 Keys

Este directorio aloja las claves RSA usadas para firmar/verificar el JWT
super-admin (`/api/auth/super-admin/login` y middleware
`middleware/superAdminAuth.js`).

> **IMPORTANTE:** los archivos `*.pem` NUNCA deben commitearse.
> `.gitignore` ya excluye `keys/*.pem`. Este directorio se conserva en el
> repo mediante `.gitkeep` para que despliegues puedan asumir su
> existencia.

## Generar el par de claves (una sola vez, en un entorno seguro)

```bash
# Private key (2048-bit RSA, PKCS#8)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
    -out super-admin-private.pem

# Public key (SPKI, derivada de la private key)
openssl rsa -in super-admin-private.pem -pubout -out super-admin-public.pem

# Permisos restrictivos
chmod 600 super-admin-private.pem
chmod 644 super-admin-public.pem
```

## Distribución

- **Backend (Render / producción):** monta `super-admin-private.pem` como
  secret file o env-file; apunta `SUPER_ADMIN_PRIVATE_KEY_PATH` al path
  absoluto. La public key también debe estar accesible al backend vía
  `SUPER_ADMIN_PUBLIC_KEY_PATH` (usado por `superAdminAuth` middleware).
- **Desktop (sya-admin-tools):** embebe la public key en el binario para
  poder verificar tokens localmente si se requiere. La private key
  **nunca** sale del backend.

## Rotación

1. Generar un nuevo par (`super-admin-private-v2.pem` /
   `super-admin-public-v2.pem`).
2. Desplegar la nueva public key a todos los consumidores.
3. Cambiar `SUPER_ADMIN_PRIVATE_KEY_PATH` al archivo nuevo y reiniciar
   el backend.
4. Revocar en masa los JTIs antiguos insertando filas en
   `super_admin_jwt_revocations` si es necesario.

## Checklist de seguridad

- [ ] `keys/*.pem` está en `.gitignore` (verifica con `git check-ignore keys/super-admin-private.pem`).
- [ ] Permisos del directorio `keys/` en producción: `700`.
- [ ] Permisos del archivo private: `600`.
- [ ] Backup cifrado del private key guardado fuera del servidor.
