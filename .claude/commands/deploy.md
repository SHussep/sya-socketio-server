# Deploy Backend to Render

Automatiza el proceso de commit y push para desplegar cambios del backend en Render.

## Instrucciones

Cuando el usuario ejecute este skill (`/deploy`), sigue estos pasos:

### 1. Verificar Estado del Repositorio

Ejecuta `git status` para ver los archivos modificados, nuevos o eliminados.

### 2. Analizar los Cambios

- Lee los archivos modificados para entender qué cambios se hicieron
- Usa `git diff` para ver las diferencias específicas
- Identifica si son cambios en rutas, controladores, migraciones, utils, o el servidor principal

### 3. Generar Mensaje de Commit Descriptivo

Crea un mensaje de commit siguiendo el formato Conventional Commits:
- `feat:` para nuevas funcionalidades
- `fix:` para correcciones de bugs
- `refactor:` para refactorizaciones
- `chore:` para tareas de mantenimiento
- `docs:` para documentación
- `perf:` para mejoras de rendimiento

El mensaje debe ser conciso pero descriptivo de los cambios realizados.

### 4. Realizar el Commit

```bash
git add .
git commit -m "mensaje generado"
```

### 5. Push a Main

```bash
git push origin main
```

### 6. Confirmar Deploy

Informa al usuario que:
- Los cambios han sido pusheados a la rama `main`
- Render detectará automáticamente los cambios y comenzará el deploy
- El deploy típicamente toma 2-3 minutos en completarse
- Puede verificar el estado en el dashboard de Render

## Notas Importantes

- Este skill está diseñado para el flujo de deploy continuo con Render
- Render está configurado para hacer auto-deploy cuando detecta cambios en `main`
- El archivo `render.yaml` contiene la configuración del servicio
- Si hay conflictos de merge, notificar al usuario antes de continuar

## Argumentos Opcionales

Si el usuario proporciona un mensaje como argumento (ej: `/deploy "mensaje personalizado"`), usa ese mensaje en lugar de generar uno automáticamente.
