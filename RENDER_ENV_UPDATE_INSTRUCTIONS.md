# 📋 INSTRUCCIONES: Actualizar Variables de Entorno en Render.com

## Variables de Dropbox a actualizar en Render.com:

Ve a tu dashboard de Render.com → Selecciona tu servicio `sya-socketio-server` → Settings → Environment

### Variables a actualizar/agregar:

```
DROPBOX_ACCESS_TOKEN=sl.u.AGBMDtvVbAHhRT7ACZ5NkbKGdlehO787PAFxVfeLY5x3yxxpSunLnn9x4y7X-ENQ8EH0MPc6U-Yp-lDnFLu0K0ZHA6WnJ0-JKoXkbcMei2mStKV-HVyIF3L-EtrdIFpE6heUHqOV2Xub06gN3IJAfp1OgLl2o8jCPtMbwp1_hVYXGI-atkRb-4Aqqh1V1EKmMbqlhFrQjaU5PimqykrwEzmzdd25P_lhsVArz8TBldou1_46uGcQgY1Rjl38JNfDUgeJh3DL76pSQ2AbeIEvRLhvgcny1rP9v5T48cTACGNwnKGXC8SXm4WhGxMHUKydn4J3stK0GyiaddRME90TnpSI0aXgsdfIyCuVon6MBnolRu33ZYRF81vm1prKlfGkGQ2ZmDG31cBV_PPIWgW2ycw6IlsAkJ-CICHdKmrAU6qfsfNRGzX1PnpYYcIybl7y0LfaCebSA1_lQabShT70ne1sbKlGBD0C4ylYa5jjvXNQ6rO8Wrslqw3K9JaLa5ERGU-4Q8rwKzJH3aCCf6XNnaG3ndUiXPqsBfM_Uh9alyQru0PUQr-ZPdEBFEw5RSnmIWoW7XdutSa1Pgn4bU-6XTL0vfXRhK_5r7ZKuQNoi9sciKkw6wpoFgl2qkKrkNnfx7i7wel7WZ-55w5fdXYJtfNQ5DDVkt_N3ZZdFEBgcTEKwIBTsN5eSNNNIP3jSs-2wfzSHZtwQxWwsVa0Y2gw7-G2QMnS4POSEfvdFGE4hXlHHmUhEGey7q66CAQsu7y2cF_lCdv_sSMUskZTE46qTbCayc2ECiQQpYirVN0y9DfjdBe1TYQMP1H0kHLirRqC-Du2gXK-sMCFpdnHme6xCEJWDfA1K-j-VCLS0ApUx8Fs8uon51XXvLrp25q6gzgJrF4eRGJE69eD1LYsbH6baGdL4YUSxYFD_j22LIkHumbDbOtrgu0kamqc-j7rAYC0kLUG3zzQvLKg8lqo6d6PVfIiYXFkCrf9JYLAHiRnT3N3fqdHB4O8JS3XPIa7D4bcS72KcJyYbGWdqd9WrUoiLIJOdW6uQ5uva-NXJKXH0hBOfXIVcJHgQKZo3uwXtR-JsRe5EUrWplpiJkDzaWcSCmaChF7Zep_mNkdh9Br7aIWlCz-JCMR8By_B9TS0c1o5RbSr5STsbOba5EdMuPsoGsM0Ez3k729BgdZUsXLWhnA1BV3GgXDmkcJ04uJFew87pK6z0e_0c1OGO0MTZmgol8cy5brbv8Bg4pbZt9WYSwfiMw_oKQVOKs07S2h7-1s99DzMO6cQ6qevaMUjfiBQpB_nbcNOjSy9Eb11S7B3M37bhJk1fVJevGnJwJEq9mm9MOVgOEBA-HnkWYArmywUEjk16zkiPEYWieCNyyFHvo8tKYrbKPhbM14H8GVFlsZ2XQv1XpOqTuERUckliVeAaF8-

DROPBOX_REFRESH_TOKEN=gcdjgrGh7twAAAAAAAAAAeA1mIfsFNXPB47yzoRVL-zZuSsDw8QUTdsYoATNMu_F

DROPBOX_APP_KEY=zf6rn0c3dyq5ji0

DROPBOX_APP_SECRET=sindb8xm948blvo
```

## ⚠️ IMPORTANTE:

1. **Sistema de Refresh Token FUNCIONA**
   - El DROPBOX_REFRESH_TOKEN nunca expira
   - El servidor automáticamente renovará el access_token cuando expire (cada 4 horas)
   - NO necesitas hacer nada manual después de configurar esto

2. **Después de actualizar las variables:**
   - Haz clic en "Save Changes"
   - Render automáticamente reiniciará el servicio

3. **Ejecutar migración en producción:**
   Una vez que el servicio se reinicie, necesitas ejecutar el script de migración.
   - Opción 1: Usar el shell de Render.com y ejecutar: `node fix_backup_metadata_employee_id.js`
   - Opción 2: La migración se puede ejecutar automáticamente al iniciar el servidor

## ✅ Verificación:

Después de actualizar las variables, verifica que Dropbox funcione:
- Ve a los logs de Render.com
- Busca mensajes de inicio del servidor
- NO deberías ver errores de Dropbox 401

## ✅ Refresh Token Permanente - RESUELTO:

Usamos las credenciales de tu app ANTERIOR de Dropbox que ya tenía refresh_token configurado.
Esta app funciona perfectamente y el servidor renovará tokens automáticamente.

---

**Estado actual:**
- ✅ Código desplegado a GitHub
- ⏳ Esperando que Render.com detecte el push y despliegue
- ⏳ Falta actualizar variables de entorno en Render.com
- ⏳ Falta ejecutar migración en producción
