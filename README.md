# PIG — Plataforma Integral de Gestión (Transportes Multimodal Group S.A.S.)

Aplicación web para la gestión de trámites de flota y operaciones de transporte. Este repositorio contiene el montaje inicial del prototipo entregado (`PIGTramitesMultimodal_60.html`) como base sobre la cual se seguirán construyendo integraciones reales.

## Cómo ejecutar

```bash
npm install
npm start
# App disponible en http://localhost:3000
```

`server.js` es un servidor Express minimalista que sirve `public/index.html` como estático (con fallback SPA). No hay build step: el frontend es un único archivo HTML que carga React sin JSX/compilador.

## Stack actual

- **Frontend**: React 18 (UMD, vía CDN) montado directamente con `React.createElement` — sin JSX, sin bundler, sin build step. Todo vive en `public/index.html` (~21.7k líneas).
- **Librerías externas cargadas por CDN**:
  - `react` / `react-dom` 18 (unpkg)
  - `xlsx` (SheetJS) — exportación/importación de Excel
  - `Leaflet` — se inyecta dinámicamente solo al entrar al tablero de despacho (mapa de rutas)
  - `Google Maps JavaScript API` — con **API key placeholder** (`TU_API_KEY_DE_GOOGLE_MAPS`), ver sección de integraciones pendientes
  - Google Fonts (Space Grotesk, Inter, JetBrains Mono)
- **Backend**: solo un servidor estático (`server.js`, Express). **No hay API ni base de datos todavía** — toda la información vive en memoria del navegador (constantes/`useState` inicializados con datos de ejemplo) y **se pierde al recargar la página**. Esto es lo primero a resolver al construir integraciones reales.
- **Persistencia**: ninguna (ni `localStorage` ni backend). Es un prototipo funcional/demo, no un sistema con datos reales.

## Estructura del repo

```
server.js            # servidor estático Express
package.json
public/
  index.html          # aplicación completa (frontend + datos mock)
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

No hay modelo de datos persistente. Cada módulo mantiene su propio `useState` inicializado con arreglos de ejemplo definidos como constantes en el mismo archivo (`vehiculos0`, `conductores0`, `infracciones0`, `AFILIADO_DEMO`, `TARIFAS`, etc.). No existen llamadas `fetch` a un backend propio (la única referencia a `fetch` está dentro del motor de despacho, cargado como texto). Esto significa:

- Todo cambio hecho en la UI se pierde al recargar.
- No hay autenticación real (`USUARIO` es una constante fija).
- Cualquier integración nueva requiere primero decidir cómo se persistirán los datos (API REST propia, base de datos, etc.) y reemplazar los `useState(seed)` por llamadas reales.

## Integraciones pendientes / puntos de extensión

1. **Backend real / API + base de datos** — hoy no existe. Es el prerequisito para que cualquier módulo (flota, cartera, operaciones) sea funcional más allá de una demo.
2. **Google Maps** — la API key es un placeholder (`TU_API_KEY_DE_GOOGLE_MAPS`, línea 15 de `index.html`). Sin ella, `AddressField`/`ParadasField` funcionan como texto libre, sin autocompletar ni geolocalizar. Se recomienda mover la key a una variable de entorno inyectada por el servidor en vez de dejarla hardcodeada en el HTML.
3. **Motor de despacho (`EcservisEngine`)** — actualmente autocontenido con datos de ejemplo; es el punto de integración para tracking GPS/asignación de vehículos en tiempo real.
4. **Exportación/importación Excel** — ya integrada vía SheetJS (`xlsx`), reutilizable para nuevas integraciones de reportes.
5. **Módulos reservados** — el `HomeERP` ya contempla un módulo "Comercial" y varios "slots" vacíos como puntos de entrada para nuevos módulos de negocio.

## Notas para seguir desarrollando

- El archivo `public/index.html` es grande (21.7k líneas) pero está organizado por bloques comentados (`// ─── SECCIÓN ───`) y por componente (`function NombreComponente`). Usa búsqueda por nombre de componente o por el `id` del módulo en `MENU`/`MENU_OP` para ubicar código rápido.
- Antes de dividir el archivo en módulos/bundler, confirmar con el equipo si se prefiere mantener el enfoque "sin build" (más simple de desplegar) o migrar a un setup con Vite/webpack — ninguna integración nueva debería asumir un paso de compilación mientras no se tome esa decisión.
- Al añadir persistencia, priorizar los módulos con mayor "badge" de pendientes en el sidebar (vehículos/conductores con documentos vencidos, validaciones de afiliados) por ser los de mayor uso operativo.
