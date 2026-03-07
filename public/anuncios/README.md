# Sistema de Anuncios - SYA Tortillerias

## Como funciona

Este sistema permite enviar anuncios a **todos los POS conectados** en tiempo real. El anuncio se muestra como una ventana (ContentDialog) con una pagina HTML renderizada dentro del sistema de punto de venta.

```
Tu HTML --> Backend (Render) --> Socket.IO --> Todos los POS conectados --> ContentDialog con WebView2
```

---

## Paso 1: Crear tu pagina HTML

Crea un archivo `.html` en esta carpeta (`public/anuncios/`). Puedes usar cualquier editor de texto o codigo.

**Ejemplo basico:**
```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            background: #0a1628;
            color: #e0e0e0;
            font-family: 'Segoe UI', Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 30px;
        }
        .card {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(79,195,247,0.2);
            border-radius: 16px;
            padding: 40px;
            max-width: 600px;
            text-align: center;
        }
        h1 { color: #4fc3f7; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Tu titulo aqui</h1>
        <p>Tu mensaje aqui</p>
    </div>
</body>
</html>
```

**Tips de diseno:**
- Usa fondo oscuro (`#0a1628` o similar) para que se vea bien con el tema del POS
- Tamano del dialogo: aprox 850x600px, disena para ese espacio
- Puedes usar imagenes, CSS, fuentes de Google, lo que quieras
- El HTML tiene scroll si el contenido es mas largo que la ventana

---

## Paso 2: Subir la pagina

### Opcion A: Desde terminal (Git Bash / PowerShell)

```bash
cd C:\SYA\sya-socketio-server
git add public/anuncios/mi-anuncio.html
git commit -m "nuevo anuncio: mi-anuncio"
git push
```

### Opcion B: Desde GitHub web

1. Ir a https://github.com/SHussep/sya-socketio-server
2. Navegar a `public/anuncios/`
3. Click **"Add file" > "Create new file"**
4. Pegar tu HTML, ponerle nombre, y dar commit

Render hace deploy automatico en ~2-3 minutos despues del push.

---

## Paso 3: Enviar el anuncio a todos los POS

### Con URL (pagina hospedada)

```
POST https://sya-socketio-server.onrender.com/api/superadmin/broadcast

Headers:
  Content-Type: application/json
  X-Admin-PIN: <tu-pin-de-superadmin>

Body:
{
  "title": "Titulo de la ventana",
  "contentUrl": "https://sya-socketio-server.onrender.com/public/anuncios/mi-anuncio.html"
}
```

### Con HTML directo (sin crear archivo)

```
POST https://sya-socketio-server.onrender.com/api/superadmin/broadcast

Headers:
  Content-Type: application/json
  X-Admin-PIN: <tu-pin-de-superadmin>

Body:
{
  "title": "Aviso rapido",
  "htmlContent": "<h1 style='color:#4fc3f7'>Hola</h1><p>Este es un aviso rapido</p>"
}
```

---

## Donde hacer el POST

- **Postman**: crear un request POST con los headers y body de arriba
- **curl** (terminal):
  ```bash
  curl -X POST https://sya-socketio-server.onrender.com/api/superadmin/broadcast \
    -H "Content-Type: application/json" \
    -H "X-Admin-PIN: tu-pin" \
    -d '{"title":"Mi anuncio","contentUrl":"https://sya-socketio-server.onrender.com/public/anuncios/mi-anuncio.html"}'
  ```
- **App iOS de superadmin**: si le agregas un boton que haga el POST

---

## Paginas de ejemplo incluidas

| Archivo | Descripcion |
|---------|------------|
| `bienvenida.html` | Anuncio de bienvenida con features de la app |
| `promo-app.html` | Promocion de app movil con diseno navy blue |

Puedes usarlas como plantilla para crear las tuyas.

---

## Estructura de archivos

```
public/
  anuncios/
    README.md          <-- Este archivo
    bienvenida.html    <-- Ejemplo: pagina de bienvenida
    promo-app.html     <-- Ejemplo: promo app movil navy blue
    tu-anuncio.html    <-- Tus propias paginas aqui
```

## Endpoint de referencia

| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `title` | string | Si | Titulo que aparece en la barra del dialogo |
| `htmlContent` | string | Si* | HTML directo para mostrar |
| `contentUrl` | string | Si* | URL de la pagina HTML a cargar |
| `type` | string | No | Tipo: "info", "warning", "promo" (default: "info") |

*Se requiere `htmlContent` O `contentUrl`, al menos uno de los dos.
