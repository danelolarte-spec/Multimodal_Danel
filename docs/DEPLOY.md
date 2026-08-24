# Desplegar en Render

La plataforma ya guarda todo en una base de datos real (SQLite) a través de la API (`server.js`). Para que varias personas, en distintos computadores, vean y editen la misma información, el servidor tiene que correr en un solo sitio con URL pública — no en el computador de cada quien. Esta guía despliega esa instancia única en Render.

## Por qué el plan "Starter" (no el gratis)

Render borra el disco de un servicio gratuito cada vez que se reinicia o se hace un nuevo deploy — la base de datos SQLite desaparecería. El plan **Starter** (de pago) permite adjuntar un **disco persistente**, que es donde vive `data.sqlite`. `render.yaml` ya está configurado así: un disco de 1 GB montado en `/var/data`, más que suficiente para esta aplicación.

## Pasos

1. **Crear cuenta en [render.com](https://render.com)** (si no tienes una) y conectar tu cuenta de GitHub.

2. **Nuevo Blueprint**: en el dashboard de Render, "New" → "Blueprint", y selecciona el repositorio `Multimodal_Danel` (rama `claude/monta-platform-setup-om8jih`, o la que hayas mergeado a tu rama principal). Render detecta automáticamente `render.yaml` en la raíz del repo y propone crear el servicio `pig-multimodal` con su disco.

3. **Confirmar y desplegar**: Render genera solo un `SESSION_SECRET` seguro (por `generateValue: true` en `render.yaml`) — no necesitas configurar nada más a mano. Aprueba la creación.

4. **Esperar el primer build**: Render corre `npm install` y luego `npm start`. Al iniciar, `database.js` crea automáticamente `data.sqlite` en el disco persistente, con el usuario administrador semilla y los datos de ejemplo (igual que en local).

5. **Obtener la URL**: Render asigna una URL del tipo `https://pig-multimodal.onrender.com`. Esa es la dirección que usan todos los usuarios, desde cualquier computador, para entrar a la plataforma.

6. **Cambiar la contraseña del administrador**: las credenciales semilla (`admin@multimodalgroup.com` / `admin123`) son públicas en este repo — cámbialas apenas entres por primera vez a producción (hoy no hay pantalla de "cambiar contraseña" en la UI; se puede hacer directamente en la base de datos o pedirlo como siguiente tarea).

## Variables de entorno

| Variable | Quién la pone | Para qué |
|---|---|---|
| `SESSION_SECRET` | Render (automática) | Firma las cookies de sesión. |
| `DB_PATH` | `render.yaml` (fija) | Ruta del archivo SQLite dentro del disco persistente. |
| `NODE_ENV=production` | `render.yaml` (fija) | Activa cookies seguras (`secure`) y `trust proxy`, necesario porque Render termina HTTPS en su proxy. |
| `PORT` | Render (automática) | Render la inyecta; `server.js` ya la respeta (`process.env.PORT`). |

## Actualizar el despliegue

Cada `git push` a la rama que Render está siguiendo dispara un nuevo build y deploy automático — el disco (y por lo tanto los datos) persiste entre despliegues, solo se reemplaza el código.

## Backups

Render permite tomar snapshots del disco persistente desde su dashboard (plan Starter en adelante). Recomendado configurar un respaldo periódico una vez la plataforma esté en uso real — no viene activado por defecto.

## Limitaciones conocidas en este primer despliegue

- **Sesiones en memoria**: `express-session` usa el almacenamiento por defecto (memoria del proceso). Un reinicio del servicio (deploy nuevo, o que Render reinicie el contenedor) cierra la sesión de todos los usuarios — tendrán que volver a iniciar sesión. Los *datos* no se pierden (viven en SQLite), solo el estado de "quién tiene sesión abierta".
- **Archivos adjuntos** (fotos de conductor, comprobantes de pago, PDFs de documentos): el frontend todavía genera URLs `blob:` locales al navegador, que no se suben a ningún lado — no sobreviven a un recargo ni se comparten entre usuarios. Falta implementar carga real de archivos (ver `docs/BACKEND_DESIGN.md` §7).
- **Módulos aún no conectados a la API**: Infracciones, Pólizas/Reclamaciones, Convenios, Leasing, Caja menor, Renovaciones mensuales, Trámites, Solicitudes de afiliación y Operaciones (Contratos/Servicios) siguen usando datos de ejemplo en memoria del navegador — la API para todos ellos ya existe (ver `docs/BACKEND_DESIGN.md`), falta repetir en cada uno el mismo patrón de conexión ya aplicado a Vehículos, Conductores y Cartera.
