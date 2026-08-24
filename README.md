# PIG — Plataforma Integral de Gestión (Transportes Multimodal Group S.A.S.)

Aplicación web para la gestión de trámites de flota y operaciones de transporte. Este repositorio contiene el montaje inicial del prototipo entregado (`PIGTramitesMultimodal_60.html`) como base sobre la cual se seguirán construyendo integraciones reales.

## Cómo ejecutar

```bash
npm install
npm start
# App disponible en http://localhost:3000
```

`server.js` levanta la API REST (`/api/...`) y sirve `public/index.html` como estático (con fallback SPA). Al primer arranque crea `data.sqlite` con un usuario administrador y datos de ejemplo.

**Credenciales de la API**: `admin@multimodalgroup.com` / `admin123` (rol `admin`).

## Desplegar para uso real (varios usuarios, varios computadores)

Ver [`docs/DEPLOY.md`](docs/DEPLOY.md) — despliegue en Render con disco persistente (`render.yaml` ya incluido en el repo).

## Stack actual

- **Frontend**: React 18 (UMD) + XLSX (SheetJS), servidos como archivos locales desde `public/vendor/` (no CDN — ver más abajo) y montados con `React.createElement` — sin JSX, sin bundler, sin build step. Todo vive en `public/index.html` (~21.8k líneas).
- **Librerías externas**:
  - `react` / `react-dom` 18 y `xlsx` — vendorizadas en `public/vendor/` (antes cargaban desde unpkg/cdnjs; se movieron localmente para no depender de CDNs externos en producción).
  - `Leaflet` — se sigue inyectando dinámicamente por CDN solo al entrar al tablero de despacho (mapa de rutas); no forma parte del flujo ya conectado.
  - `Google Maps JavaScript API` — con **API key placeholder** (`TU_API_KEY_DE_GOOGLE_MAPS`), ver sección de integraciones pendientes.
  - Google Fonts (Space Grotesk, Inter, JetBrains Mono) — por CDN, con fallback a fuentes del sistema si no cargan.
- **Backend**: Node.js + Express + SQLite (`better-sqlite3`) + sesiones (`express-session`/`bcryptjs`). API REST real con autenticación por rol. Ver diseño completo y catálogo de endpoints en [`docs/BACKEND_DESIGN.md`](docs/BACKEND_DESIGN.md).
- **Persistencia**: SQLite (`data.sqlite`, no versionado; en producción vive en el disco persistente de Render). **El frontend ya está conectado a la API real** para Autenticación, Vehículos, Conductores y Cartera — los cambios que se hacen ahí se guardan en el servidor y los ve cualquier usuario, en cualquier computador, que entre a la misma URL (verificado con pruebas automatizadas simulando dos sesiones/computadores distintos). El resto de módulos (Infracciones, Pólizas, Convenios, Leasing, Caja menor, Trámites, Solicitudes, Operaciones) todavía usan datos de ejemplo en memoria del navegador — la API para todos ellos ya existe, falta repetir el mismo patrón de conexión (`docs/BACKEND_DESIGN.md` §5).

## Estructura del repo

```
server.js            # servidor Express: API REST + estático
database.js          # esquema SQLite (better-sqlite3) y seed inicial
render.yaml           # Blueprint de despliegue en Render (con disco persistente)
docs/
  BACKEND_DESIGN.md   # diseño del backend, modelo de datos y catálogo de endpoints
  DEPLOY.md           # cómo desplegar en Render para uso multiusuario real
package.json
public/
  index.html          # aplicación completa (Auth/Vehículos/Conductores/Cartera ya conectados a la API)
  vendor/             # React, ReactDOM y XLSX vendorizados localmente (sin depender de CDN)
```

## Arquitectura de la aplicación (dentro de `index.html`)

`App` (línea ~21578) es el componente raíz. Al cargar muestra `HomeERP`, un selector de "módulos empresariales" de alto nivel:

- **Trámites y Control de Flota** (activo) — el módulo principal, historia de PIG-Trámites.
- **Operaciones** (activo) — `OperacionesApp`, submenú independiente con su propio sidebar.
- Comercial y otros 8 "slots" — reservados/deshabilitados, pensados como puntos de extensión para módulos futuros.

### Módulo "Trámites y Control de Flota" (sidebar principal, `MENU` ~línea 19365)

| Sección | Componente | Descripción |
|---|---|---|
| Dashboard | `Dashboard` | KPIs generales del sistema |
| Flota de Vehículos | `Vehiculos` | Vehículos y su documentación (SOAT, tecnomecánica, tarjeta de operación, etc.) |
| Conductores | `Conductores` | Habilitación, documentos, seguridad social |
| Gestión de Trámites | `GestionTramites` | Vinculaciones, desvinculaciones, operativos |
| Infracciones VIGÍA | `Infracciones` | Control de comparendos/infracciones |
| Cartera Afiliados | `Cartera` | Obligaciones y cobros a afiliados |
| Pólizas y Siniestros | `Polizas` | Seguros, reclamaciones (`RAMOS_POLIZA`, `ESTADOS_RECLAMACION`) y flujos de siniestro configurables (`FlujosEditor`) |
| Convenios | `Convenios` | Convenios empresariales/gubernamentales (ICBF, corporativos) |
| Leasing y Prendas | `LeasingPrendas` | Gravámenes sobre vehículos |
| Renovaciones Mensuales | `TramitesMensuales` | Documentos con vencimiento periódico |
| Caja Menor | `CajaMenor` | Gastos del área de trámites |
| Validaciones Afiliados | `ValidacionesAfiliados` | Documentos/pagos enviados por afiliados (portal externo) |
| Portal de Afiliación | `AutoGestion` | Autogestión pública para interesados en afiliarse (sin login) |
| Solicitudes Recibidas | `AdminSolicitudes` | Bandeja interna de solicitudes de afiliación |
| (Demo) Vista del Afiliado | `PortalAfiliado` | Simulación del portal visto por un afiliado |
| Configuraciones Avanzadas | `ConfiguracionesAvanzadas` | Ver abajo — diseñador de trámites y formatos |

**Configuraciones Avanzadas** agrupa un mini "no-code builder" interno:
- `DisenioTramites` / `DisenioEditor` — diseño de tipos de trámite y sus etapas (drag & drop), `TIPOS_TRAMITE_CONFIG`, `GRUPOS_TRAMITE`.
- `DisenoFormatos` / `BloqueEditor` — diseñador de formatos/documentos por bloques arrastrables (`BLOQUES_DISPONIBLES`, `VARS_TEXTO` para variables de texto tipo mail-merge).
- `AdminDocumentos` — administración de documentos requeridos por solicitud.

### Módulo "Operaciones" (`OperacionesApp`, submenú propio)

| Sección | Componente | Descripción |
|---|---|---|
| Tablero | `OperacionesTablero` → `EcservisEngine` | Despacho en tiempo real sobre mapa (Leaflet), motor cargado dinámicamente (ver abajo) |
| Servicios | `Servicios` | Programación diaria de viajes/servicios |
| Contratos | `Contratos` | Contratos y clientes, campos de servicio |
| Producción | `Produccion` | Indicadores de rentabilidad operativa |
| Liquidación | `LiquidacionServicios` | Relación de servicios ejecutados para facturar al cliente |

**`EcservisEngine`** (~línea 20831) es el punto más "vivo" del prototipo: inyecta su propio CSS/HTML (`ECW_CSS`, `ECW_BODY_HTML`) y ejecuta un script de motor (`ECSERVIS_ENGINE_SRC`) vía `new Function(...)` una vez Leaflet está cargado. Es el candidato natural para conectarse a un backend de despacho/tracking real (asignación de vehículos, GPS, etc.).

### Componentes UI compartidos
`Alert`, `Modal`, `Tabs`, `Stepper`, `Toasts`/`useToast`, `PBar` (barra de progreso), `Sem` (semáforo de estado), `DocBadge`, `IField`, `FG` (form group), `AddressField`/`ParadasField` (integran con Google Maps Places cuando hay API key).

## Datos y estado

**Backend**: modelo de datos persistente completo en SQLite (`database.js`) con API REST (`server.js`) — ver `docs/BACKEND_DESIGN.md`.

**Frontend**: `AuthGate` (pantalla de login real, ver el final de `index.html`) valida sesión contra `/api/auth/me` y, tras iniciar sesión, carga Vehículos y Conductores desde la API antes de mostrar la app — de ahí en adelante `USUARIO` refleja al usuario real de la sesión, no una constante fija. Los módulos de Vehículos, Conductores y Cartera guardan cada cambio (documentos, pagos, restricciones, altas) contra el servidor mediante las funciones `sync*` en `index.html` (`syncVehiculoUpdate`, `syncConductorFields`, etc. — buscar `credentials: 'same-origin'` para ubicarlas todas), manteniendo el mismo patrón síncrono de "store" que ya tenían para no tocar el resto de los componentes. El resto de módulos (Infracciones, Pólizas, Convenios, Leasing, Caja menor, Renovaciones mensuales, Trámites, Solicitudes/Portal de afiliación, Operaciones) siguen usando `useState` con arreglos de ejemplo (`infracciones0`, `polizas0`, etc.) — la API para todos ellos ya existe, falta aplicar el mismo patrón de conexión módulo por módulo.

## Integraciones pendientes / puntos de extensión

1. **Terminar de conectar el frontend a la API real** — Vehículos, Conductores, Cartera y Auth ya están conectados y probados (incluida persistencia entre sesiones/computadores distintos); falta repetir el patrón en el resto de módulos (orden recomendado en `docs/BACKEND_DESIGN.md` §5).
2. **Carga de archivos real** — hoy `archivoUrl`/`comprobante` se guardan como `blob:` locales al navegador (no sobreviven a un recargo ni se comparten entre usuarios), aunque la API ya tiene las columnas listas (`archivo_url`, `archivo_nombre`, `comprobante_url`). Falta un endpoint de subida (`multipart/form-data` → disco o almacenamiento externo).
3. **Google Maps** — la API key es un placeholder (`TU_API_KEY_DE_GOOGLE_MAPS`, línea 15 de `index.html`). Sin ella, `AddressField`/`ParadasField` funcionan como texto libre, sin autocompletar ni geolocalizar. Se recomienda mover la key a una variable de entorno inyectada por el servidor en vez de dejarla hardcodeada en el HTML.
4. **Motor de despacho (`EcservisEngine`)** — actualmente autocontenido con datos de ejemplo; es el punto de integración para tracking GPS/asignación de vehículos en tiempo real, sobre las tablas `servicios`/`vehiculos` ya definidas en el backend.
5. **Exportación/importación Excel** — ya integrada vía SheetJS (`xlsx`), reutilizable para nuevas integraciones de reportes.
6. **Módulos reservados** — el `HomeERP` ya contempla un módulo "Comercial" y varios "slots" vacíos como puntos de entrada para nuevos módulos de negocio.
7. **Sesiones persistentes entre reinicios** — `express-session` usa almacenamiento en memoria; un redeploy cierra la sesión de todos los usuarios (los datos no se pierden, solo el login). Ver `docs/DEPLOY.md`.

## Notas para seguir desarrollando

- El archivo `public/index.html` es grande (21.7k líneas) pero está organizado por bloques comentados (`// ─── SECCIÓN ───`) y por componente (`function NombreComponente`). Usa búsqueda por nombre de componente o por el `id` del módulo en `MENU`/`MENU_OP` para ubicar código rápido.
- Antes de dividir el archivo en módulos/bundler, confirmar con el equipo si se prefiere mantener el enfoque "sin build" (más simple de desplegar) o migrar a un setup con Vite/webpack — ninguna integración nueva debería asumir un paso de compilación mientras no se tome esa decisión.
- Al añadir persistencia, priorizar los módulos con mayor "badge" de pendientes en el sidebar (vehículos/conductores con documentos vencidos, validaciones de afiliados) por ser los de mayor uso operativo.
