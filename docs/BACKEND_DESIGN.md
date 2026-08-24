# Diseño del backend/API real — PIG Trámites y Operaciones

Estado: **API fase 1 implementada** (auth + flota + trámites + afiliación) y **frontend conectado para Auth, Vehículos, Conductores y Cartera** (probado con dos sesiones/computadores simulados: un cambio hecho en uno aparece en el otro sin recargar código, solo la página). Este documento describe la arquitectura, el modelo de datos, el contrato de la API y el plan para terminar de conectar el resto del frontend.

## 1. Objetivo y alcance

El frontend (`public/index.html`) es un prototipo funcional sin persistencia: cada módulo mantiene arreglos de ejemplo en memoria (`vehiculos0`, `conductores0`, `tramites0`, etc.) que se pierden al recargar. El objetivo de este backend es reemplazar esos datos mock por una API real y persistente, módulo por módulo, sin necesidad de reescribir el frontend de una sola vez.

## 2. Stack y decisiones

| Decisión | Elección | Razón |
|---|---|---|
| Runtime/framework | Node.js + Express | Igual que `EC_Proyect` (otro proyecto del mismo dueño) — consistencia, sin curva de aprendizaje nueva. |
| Base de datos | SQLite vía `better-sqlite3` | Cero infraestructura que administrar, API síncrona simple, suficiente para el volumen de una sola empresa de transporte. Migrar a Postgres es directo si el volumen crece (mismo patrón de queries). |
| Auth | Sesión de servidor (`express-session`) + `bcryptjs` | Mismo patrón que `EC_Proyect`. Simple, sin necesidad de manejar refresh tokens en un frontend sin build step. |
| Frontend | Sin cambios de stack por ahora | Se sigue sirviendo `public/index.html` como estático; se conecta a la API vía `fetch` reemplazando las funciones "store" (ver §5). |

## 3. Autenticación y roles

- `POST /api/auth/login` `{email, password}` → crea sesión, responde `{id, nombre, email, rol}`.
- `POST /api/auth/logout`
- `GET /api/auth/me`
- Roles: `admin`, `tramites`, `operaciones`, `comercial` (el último reservado, sin endpoints propios aún — corresponde al módulo "Comercial" ya previsto en `HomeERP` pero deshabilitado).
- Cada ruta de escritura exige uno de los roles autorizados (`requireRole(...)` en `server.js`). Las rutas de lectura solo exigen sesión activa (`requireAuth`), excepto el portal público de afiliación.
- Usuario semilla: `admin@multimodalgroup.com` / `admin123` (rol `admin`) — cambiar en producción.
- **Pendiente de decidir con el negocio**: hoy el frontend usa un único `USUARIO` fijo (`Tramites01`). Al conectar el login real, cada persona del área de trámites necesita su propio usuario — hay que crear altas para "Tramites01", "Tramites02", "Tramites04", "Juliana Cardona", etc. (nombres que aparecen como `solicitadoPor`/`autorizadoPor`/`usuario` en los datos de ejemplo).

## 4. Modelo de datos

Ver el esquema completo y comentado en `database.js`. Resumen por módulo:

### Flota
- `vehiculos` — datos del vehículo + propietario (columnas planas) + convenio asociado (denormalizado; ver Convenios abajo para el convenio "real" con contrato).
- `documentos` — **tabla compartida** para todo documento con vencimiento: `(entidad_tipo, entidad_id, doc_tipo) → {vencimiento, estado, archivo_url}`. Cubre SOAT/RTM/T.O./póliza RC de vehículos y licencia/seg. social/exámenes/antecedentes de conductores con una sola tabla e índice por estado — así el dashboard puede consultar "todo lo vencido" en una query, sin importar el módulo.
- `conductores` + `conductor_seg_social_historial` (histórico de reportes mensuales a seguridad social).
- `cartera` (saldo/estado por vehículo) + `cartera_pagos` (historial de abonos).

### Control y seguimiento
- `infracciones` — comparendos VIGÍA.
- `polizas` + `poliza_vehiculos` (N:M) + `reclamaciones` + `reclamacion_historial`.
- `convenios` + `convenio_vehiculos` (N:M) — convenios comerciales/gubernamentales de la flota (distintos de los `contratos` operativos, ver abajo).
- `leasings` + `leasing_pagos`.

### Gestión documental
- `docs_mensuales` — catálogo de renovaciones periódicas (REDAM, paz y salvo, etc.).
- `caja_menor` — gastos del área de trámites.
- `tipos_tramite` — **configuración**, no dato transaccional: define los tipos de trámite disponibles y sus etapas (lo que hoy diseña `DisenioTramites` en "Configuraciones Avanzadas"). `etapas` se guarda como JSON (`["Solicitud","Validación",...]`).
- `tramites` + `tramite_costos` + `tramite_historial` — instancias de trámite (vinculación, desvinculación, cambio de propietario, etc.), todas comparten esta forma en el prototipo.

### Portal externo / afiliación
- `documentos_solicitud_config` — catálogo configurable de documentos requeridos (lo que administra `AdminDocumentos`).
- `solicitudes_afiliacion` + `solicitud_docs_confirmados` + `solicitud_historial`.
- El envío del formulario público (`AutoGestion`, sin login) usa `POST /api/portal/solicitudes`, sin autenticación — igual que hoy el prototipo permite enviar sin login.

### Operaciones (contratos, servicios, despacho)
- `contratos` + `contrato_productos` + `contrato_conductores` + `contrato_campos` (campos dinámicos por contrato, ej. "N.º de vuelo").
- `servicios` — servicio/viaje individual, referencia opcional a `contrato`, `vehiculo`, `conductor`.
- **No implementado aún**: `produccion` (agregación calculada, no necesita tabla propia) y `liquidacion` (probablemente una vista/reporte sobre `servicios`, no una tabla nueva) — se diseñan en la fase 2 una vez se defina cómo se factura al cliente.
- El motor de despacho (`EcservisEngine`, mapa Leaflet) hoy es autónomo con datos de ejemplo embebidos en el HTML; conectarlo a `servicios`/`vehiculos` en tiempo real (con tracking GPS) es la integración más grande pendiente y merece su propio diseño (ver §7).

## 5. Estrategia de migración del frontend (sin reescribir todo de una vez)

**Ya implementado y validado para Vehículos y Conductores** (ver `public/index.html`, buscar `loadVehiculosStore`/`loadConductoresStore`): la costura correcta resultó ser mantener `getVehiculosStore()` **síncrona** — decenas de componentes la llaman en medio del render (`useState(() => getVehiculosStore()...)`, `.find()` dentro de handlers, etc.), así que convertirla en `async` habría obligado a tocar todos esos sitios. En cambio:

- `getVehiculosStore()` sigue devolviendo el arreglo en memoria tal cual, sin red.
- Una función nueva `loadVehiculosStore()` (async) hace el `fetch('/api/vehiculos')` **una sola vez**, al iniciar sesión (en `AuthGate`, antes de mostrar `App`), y llena ese mismo arreglo en memoria. De ahí en adelante todo el resto del código sigue funcionando exactamente igual que con el mock.
- `updateVehiculo(id, upd)` y `addVehiculoStore(v)` actualizan el arreglo en memoria de forma optimista (igual que antes) **y además** disparan en segundo plano (`fetch` sin `await`, con `.catch` a consola) la llamada real a la API (`syncVehiculoUpdate`/`syncVehiculoCreate`). La UI no espera la respuesta del servidor — se comporta igual que el prototipo original, solo que ahora también persiste.

Lo mismo se aplicó a Conductores, pero ahí no existía capa de store para las mutaciones (solo para lectura/alta) — hubo que añadir una llamada `sync*` justo al lado de cada `setConds(...)` existente en el componente `Conductores`. Es más código tocado que en Vehículos, pero el patrón (optimista en memoria + `fetch` en paralelo) es el mismo.

**Errores reales encontrados al conectar** (dejar registrado para no repetirlos al migrar los módulos que faltan):
1. La API debe devolver exactamente la forma anidada que el frontend espera (`propietario: {nombre, ...}`, `convenio: {...}` anidados, no columnas planas `propietario_nombre`) — de lo contrario los componentes truenan en `.map()` con "Cannot read properties of undefined".
2. Un `PUT` de documento que solo manda un campo (p. ej. solo `archivoUrl` al subir un archivo) no debe pisar con `null`/`PENDIENTE` los campos que no vinieron en el body — hay que leer el registro existente y solo sobrescribir lo que llegó.
3. Un `''` (string vacío) en un campo `*_id` (ej. "sin vehículo asignado") rompe la restricción de llave foránea en SQLite — SQLite solo aplica `NULL`/comportamiento de FK opcional cuando el valor es `NULL`, no `''`. Hay un middleware genérico en `server.js` que normaliza cualquier campo `*_id` vacío a `null` antes de tocar la base de datos; conviene mantenerlo al agregar endpoints nuevos.

Los módulos que **no** tienen ninguna capa de store (infracciones, pólizas, convenios, leasing, caja menor, trámites, solicitudes, operaciones) necesitan que se introduzca el mismo patrón de `sync*` junto a cada mutación local — es mecánico, pero hay que hacerlo módulo por módulo, e idealmente probando con dos sesiones de navegador distintas (como se hizo aquí) para confirmar que lo que un usuario guarda lo ve el otro.

**Orden recomendado para lo que falta** (por impacto operativo, según los badges de pendientes que ya muestra el sidebar):
1. Validaciones de afiliados / Solicitudes recibidas (flujo con el portal público, ya sin login).
2. Trámites, Pólizas/Reclamaciones, Convenios, Leasing, Caja menor, Renovaciones mensuales.
3. Operaciones (contratos/servicios) — depende de decidir primero el diseño de Producción/Liquidación y la integración del motor de despacho.

## 6. Catálogo de endpoints (fase 1, implementados)

Todas las rutas bajo `/api` salvo `POST /api/portal/solicitudes` y `GET /api/portal/documentos-requeridos` requieren sesión activa.

| Módulo | Método y ruta | Notas |
|---|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | |
| Dashboard | `GET /api/dashboard/resumen` | Conteos y totales agregados para el panel principal. |
| Vehículos | `GET/POST /api/vehiculos`, `GET/PUT /api/vehiculos/:id`, `PUT /api/vehiculos/:id/documentos/:docTipo` | Devuelve `documentos` y `cartera` embebidos. |
| Conductores | `GET/POST /api/conductores`, `GET/PUT /api/conductores/:id`, `PUT /api/conductores/:id/documentos/:docTipo` | Devuelve `docs` y `segHist` embebidos. |
| Cartera | `GET /api/cartera`, `PUT /api/cartera/:vehiculoId`, `GET/POST /api/cartera/:vehiculoId/pagos` | Registrar un pago descuenta el saldo automáticamente. |
| Infracciones | `GET/POST/PUT/DELETE /api/infracciones[/:id]` | CRUD genérico. |
| Pólizas | `GET/POST /api/polizas`, `PUT /api/polizas/:id/vehiculos` | `vehiculosIds` gestiona la relación N:M. |
| Reclamaciones | `GET/POST/PUT /api/reclamaciones[/:id]` | `PUT` con `estado` añade entrada al historial automáticamente. |
| Convenios | `GET/POST/PUT /api/convenios[/:id]` | |
| Leasing | `GET/POST/PUT /api/leasings[/:id]`, `POST /api/leasings/:id/pagos` | Un pago descuenta `saldo_pendiente`. |
| Renovaciones mensuales | `GET/POST/PUT/DELETE /api/docs-mensuales[/:id]` | CRUD genérico. |
| Caja menor | `GET/POST/PUT/DELETE /api/caja-menor[/:id]` | CRUD genérico. |
| Tipos de trámite | `GET/POST/PUT /api/tipos-tramite[/:id]` | Solo `admin` puede escribir (es configuración del sistema). |
| Trámites | `GET /api/tramites?tipo=`, `POST/PUT /api/tramites[/:id]` | `PUT` registra historial cuando se envía `nota`/`accion`. |
| Portal afiliación | `GET /api/portal/documentos-requeridos`, `POST /api/portal/solicitudes` | Sin autenticación — formulario público. |
| Solicitudes (admin) | `GET/PUT /api/solicitudes[/:id]` | Solo roles internos. |
| Contratos | `GET/POST/PUT /api/contratos[/:id]` | Incluye `productos`, `conductorIds`, `campos`. |
| Servicios | `GET /api/servicios?fecha=`, `POST/PUT /api/servicios[/:id]` | |

## 7. Pendiente / fase 2

- **Carga de archivos** — `archivo_url`/`comprobante_url`/`foto_url` hoy son solo campos de texto (URL). Falta un endpoint de subida (`multipart/form-data` → almacenamiento local o S3-compatible) que los llene; el frontend hoy genera URLs `blob:` locales que no sobreviven a un recargo.
- **Producción y Liquidación de servicios** — depende de que el negocio defina cómo se calcula rentabilidad y cómo se genera la relación de cobro al cliente; probablemente reportes/vistas sobre `servicios`, no tablas nuevas.
- **Motor de despacho (`EcservisEngine`)** — la pieza más compleja: tracking en tiempo real, asignación de vehículo/conductor a un `servicio`. Candidatos: WebSockets o polling corto sobre `/api/servicios`, y una tabla de posiciones GPS si se integra un dispositivo/app de conductor.
- **Google Maps** — la API key sigue como placeholder en el HTML. Debe moverse a variable de entorno del servidor e inyectarse al servir `index.html` (o usar un endpoint proxy), en vez de quedar hardcodeada en el archivo.
- **Multiusuario real en el sidebar** — reemplazar el `USUARIO` fijo del frontend por el usuario de la sesión (`GET /api/auth/me`) una vez exista una pantalla de login.
- **Auditoría** — varias tablas ya capturan `usuario`/`registrado_por`/`autorizado_por` como texto libre; una vez haya login real, deberían ser `user_id` con FK a `users`.
