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

## Stack actual

- **Frontend**: React 18 (UMD, vía CDN) montado directamente con `React.createElement` — sin JSX, sin bundler, sin build step. Todo vive en `public/index.html` (~21.7k líneas).
- **Librerías externas cargadas por CDN**:
  - `react` / `react-dom` 18 (unpkg)
  - `xlsx` (SheetJS) — exportación/importación de Excel
  - `Leaflet` — se inyecta dinámicamente solo al entrar al tablero de despacho (mapa de rutas)
  - `Google Maps JavaScript API` — con **API key placeholder** (`TU_API_KEY_DE_GOOGLE_MAPS`), ver sección de integraciones pendientes
  - Google Fonts (Space Grotesk, Inter, JetBrains Mono)
- **Backend**: Node.js + Express + SQLite (`better-sqlite3`) + sesiones (`express-session`/`bcryptjs`). API REST real con autenticación por rol, cubriendo Flota, Cartera, Infracciones, Pólizas/Reclamaciones, Convenios, Leasing, Renovaciones mensuales, Caja menor, Trámites, Portal de afiliación/Solicitudes, y Contratos/Servicios de Operaciones. Ver diseño completo y catálogo de endpoints en [`docs/BACKEND_DESIGN.md`](docs/BACKEND_DESIGN.md).
- **Persistencia**: SQLite (`data.sqlite`, no versionado). **El frontend todavía NO está conectado a esta API** — sigue operando sobre los arreglos mock (`vehiculos0`, `conductores0`, etc.) y pierde los cambios al recargar. Conectar cada módulo es el siguiente paso; la estrategia de migración sin reescribir la UI está documentada en `docs/BACKEND_DESIGN.md` §5.

## Estructura del repo

```
server.js            # servidor Express: API REST + estático
database.js          # esquema SQLite (better-sqlite3) y seed inicial
docs/
  BACKEND_DESIGN.md   # diseño del backend, modelo de datos y catálogo de endpoints
package.json
public/
  index.html          # aplicación completa (frontend + datos mock, aún sin conectar a la API)
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

**Backend**: ya existe un modelo de datos persistente completo en SQLite (`database.js`) con API REST (`server.js`) — ver `docs/BACKEND_DESIGN.md`.

**Frontend**: por ahora sigue sin conectar. Cada módulo de `index.html` mantiene su propio `useState` inicializado con arreglos de ejemplo definidos como constantes en el mismo archivo (`vehiculos0`, `conductores0`, `infracciones0`, `AFILIADO_DEMO`, `TARIFAS`, etc.), sin llamadas `fetch` a la API real. Esto significa que, hasta que se haga la conexión módulo por módulo:

- Todo cambio hecho en la UI se pierde al recargar.
- No hay autenticación real en el frontend (`USUARIO` sigue siendo una constante fija, aunque la API ya soporta login/roles).

## Integraciones pendientes / puntos de extensión

1. **Conectar el frontend a la API real** — el backend ya existe (`docs/BACKEND_DESIGN.md`); falta reemplazar los `useState(seed)`/funciones "store" del frontend por `fetch` a los endpoints, módulo por módulo (orden recomendado en el diseño, §5).
2. **Google Maps** — la API key es un placeholder (`TU_API_KEY_DE_GOOGLE_MAPS`, línea 15 de `index.html`). Sin ella, `AddressField`/`ParadasField` funcionan como texto libre, sin autocompletar ni geolocalizar. Se recomienda mover la key a una variable de entorno inyectada por el servidor en vez de dejarla hardcodeada en el HTML.
3. **Motor de despacho (`EcservisEngine`)** — actualmente autocontenido con datos de ejemplo; es el punto de integración para tracking GPS/asignación de vehículos en tiempo real, sobre las tablas `servicios`/`vehiculos` ya definidas en el backend.
4. **Carga de archivos** — la API modela `archivo_url`/`comprobante_url`/`foto_url` como texto; falta el endpoint de subida real (ver `docs/BACKEND_DESIGN.md` §7).
5. **Exportación/importación Excel** — ya integrada vía SheetJS (`xlsx`), reutilizable para nuevas integraciones de reportes.
6. **Módulos reservados** — el `HomeERP` ya contempla un módulo "Comercial" y varios "slots" vacíos como puntos de entrada para nuevos módulos de negocio.

## Notas para seguir desarrollando

- El archivo `public/index.html` es grande (21.7k líneas) pero está organizado por bloques comentados (`// ─── SECCIÓN ───`) y por componente (`function NombreComponente`). Usa búsqueda por nombre de componente o por el `id` del módulo en `MENU`/`MENU_OP` para ubicar código rápido.
- Antes de dividir el archivo en módulos/bundler, confirmar con el equipo si se prefiere mantener el enfoque "sin build" (más simple de desplegar) o migrar a un setup con Vite/webpack — ninguna integración nueva debería asumir un paso de compilación mientras no se tome esa decisión.
- Al añadir persistencia, priorizar los módulos con mayor "badge" de pendientes en el sidebar (vehículos/conductores con documentos vencidos, validaciones de afiliados) por ser los de mayor uso operativo.
