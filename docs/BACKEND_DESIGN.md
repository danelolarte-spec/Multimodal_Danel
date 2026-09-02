# Diseño del backend/API real — PIG Trámites y Operaciones

Estado: **API fase 1 implementada** (auth + flota + trámites + afiliación) y **frontend conectado para Auth, Vehículos, Conductores y Cartera** (probado con dos sesiones/computadores simulados: un cambio hecho en uno aparece en el otro sin recargar código, solo la página). El submódulo **Extractos (FUEC)** está completo end-to-end (backend + frontend + probado) — ver §8. El módulo **Comercial** (alta de clientes corporativos con contrato + tarifario, con flujo de verificación hacia Trámites) también está completo end-to-end — ver §9. Extractos por grupo específico desde el Portal del Afiliado (con rutas por municipio de Colombia), generación de extracto de un solo clic por servicio puntual, bloqueo por mora, buscador de extractos y firma electrónica están descritos en §10. Numeración legible de servicio, jerarquía de campos, ruta gráfica, historial de cambios, línea de "ahora" en el Tablero, búsqueda por número y ficha de contrato (contactos/consideraciones/visibilidad por logístico) están en §14. El mapa real de la ruta del servicio (Leaflet/OpenStreetMap), la carga masiva de tarifas por Excel con plantillas por defecto (Comercial), y el Portal Conductor (login propio, mobile-first, con su propia máquina de estados incluyendo "Rechazado") están en §15. El flujo real de Liquidación → Aprobaciones (Director de Operaciones) → Contabilidad (V°B° de Gerencia + archivo plano de pago), con indicadores financieros globales y por servicio, está en §18. El calendario del Portal Conductor, la edición y bloqueo de la liquidación desde el módulo mientras está en una orden activa, la relación de cobro al cliente sin datos internos del proveedor, y el detalle completo de un servicio para Director/Gerencia están en §19. Este documento describe la arquitectura, el modelo de datos, el contrato de la API y el plan para terminar de conectar el resto del frontend.

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
- **Auditoría** — varias tablas ya capturan `usuario`/`registrado_por`/`autorizado_por` como texto libre; sería más robusto que fueran `user_id` con FK a `users`.

## 8. Submódulo Extractos (FUEC) — completo end-to-end

Implementa el "Formato Único de Extracto del Contrato" exigido por la **Resolución 6652 de 2019** del Ministerio de Transporte (Colombia) para el servicio público de transporte especial. Backend, frontend y flujo de generación de documentos ya están conectados y probados (incluida persistencia entre sesiones).

### 8.1 Modelo de datos

- `extracto_config` (fila única) — código de la Dirección Territorial, número y año de la resolución de habilitación de la empresa, y tolerancia en días para el certificado de manejo defensivo. **Ajustar con los datos reales de habilitación de Transportes Multimodal Group** (`PUT /api/extracto-config`, solo `admin`) — los valores actuales (`305`/`0010`/`13`) son un ejemplo tomado de la Dirección Territorial Antioquia-Chocó, no la habilitación real de la empresa.
- `extracto_clientes` — clientes del módulo (independiente de `convenios`), con banderas `es_icbf`/`es_corporativo` que restringen quién puede operar con ellos, y `formulario_disenado` (ver §9).
- `extracto_contratos` — contrato con cada cliente; flujo `PENDIENTE_FIRMA → PENDIENTE_VALIDACION → APROBADO | DEVUELTO | RECHAZADO`; `numero` es el consecutivo de contrato de la empresa (los 4 dígitos correspondientes en el FUEC). Las columnas `origen`/`destino` quedan para contratos antiguos o para el texto legal de modalidades con ruta fija (Grupo Específico, Turística) — **ya no limitan qué rutas se pueden usar en un extracto**: eso lo decide el tarifario del cliente (`tarifario_items`, §9), que no tiene límite de filas.
- `extractos` — instancias del FUEC generadas; **inmutables** una vez creadas (el único cambio de estado permitido es anular). Incluyen `numero_fuec` (21 dígitos), `tarifario_item_id` (la fila del tarifario del cliente usada, con su origen/destino copiados a las columnas `origen`/`destino` del extracto), `qr_token` único para la verificación pública, y `declaracion_aceptada_en`.
- `extracto_conductores`, `extracto_historial` — relación con conductores (hasta 3) y bitácora de cada extracto.

### 8.2 Número del FUEC (Art. 4, Resolución 6652/2019)

21 dígitos, construidos por `generarNumeroFuec()` en `server.js`: `código territorial (3) + número de resolución de habilitación (4) + año de habilitación (2) + año del extracto (4) + número de contrato (4) + consecutivo del extracto para ese contrato (4)`. Verificado contra el ejemplo real de FUEC de ICBF entregado (`305001013202600074666`).

### 8.3 Motor de validación (`validarGeneracionExtracto`)

Antes de generar cualquier extracto se valida, en orden, y devolviendo **siempre un mensaje específico** (nunca genérico, tal como exige el documento de proceso):

1. Contrato existe, está `APROBADO`, y la vigencia solicitada cae dentro de la vigencia del contrato → si no, `"Contrato vencido"`.
2. Si el contrato requiere convenio de colaboración y no está registrado → `"Convenio inexistente"`.
3. Se indicó un `tarifarioItemId` y ese `tarifario_items.id` pertenece al cliente del contrato → si no, `"Ruta no autorizada"`. **La ruta ya no la valida el contrato** (no hay un origen/destino único por contrato) — la valida el tarifario del cliente (§9), que puede tener cualquier cantidad de rutas y tipos de servicio. El origen/destino del extracto se copian de la fila del tarifario elegida, no se reciben como texto libre.
4. Si lo genera un **afiliado**: el cliente no puede ser ICBF/corporativo (`"Cliente no autorizado"`), y el vehículo no puede tener cartera vencida (`"Mora del afiliado"`).
5. Documentos del vehículo vigentes hasta la fecha fin del extracto: SOAT, RTM, Tarjeta de Operación.
6. Documentos de cada conductor vigentes hasta la fecha fin: licencia, examen médico, seguridad social. El certificado de manejo defensivo tiene la tolerancia configurable en `extracto_config` (10 días por defecto) antes de bloquear.

Cubre así el control de vigencias (la vigencia del extracto nunca puede superar la de los documentos ni la del contrato) y los mensajes de bloqueo específicos exigidos por el proceso.

### 8.4 Endpoints

| Método y ruta | Notas |
|---|---|
| `GET/PUT /api/extracto-config` | Numeración FUEC. Escritura solo `admin`. |
| `GET/POST/PUT /api/extractos/clientes[/:id]` | |
| `GET/POST/PUT /api/extractos/contratos[/:id]` | `PUT` con `estado` mueve el flujo de aprobación; ICBF restringido a `admin`/`tramites`. |
| `GET/POST /api/extractos`, `GET /api/extractos/:id` | `POST` exige `aceptaDeclaracion: true` (declaración de responsabilidad) y `tarifarioItemId` (fila del tarifario del cliente — ver §9), y corre el motor de validación; responde `422` con el mensaje específico si falla. |
| `POST /api/extractos/:id/duplicar` | Copia cliente/vehículo/conductor/`tarifarioItemId`, genera nuevo consecutivo y vigencia (requiere fechas nuevas + aceptar declaración de nuevo). |
| `PUT /api/extractos/:id/anular` | No se modifican los datos originales — solo cambia el estado y queda en el historial. |
| `GET /api/extractos/dashboard` | Indicadores: generados, vigentes, próximos a vencer, vencidos, por modalidad, vehículos sin extracto vigente. |
| `GET /api/public/extractos/:qrToken` | **Sin autenticación** — consulta pública del QR (número, estado, vehículo, conductor, cliente, vigencia). |

### 8.5 Frontend

- Menú "Extractos (FUEC)" dentro de Trámites y Control de Flota, con pestañas Panel / Clientes / Contratos / Extractos.
- Generación de documentos (contrato firmable y FUEC final) reutiliza el patrón `window.open + document.write + print()` ya usado por `generarPDFConvenio`/`generarPDFConductor`. Plantillas reales de contrato disponibles para las modalidades **Grupo Específico** y **Turística** (transcritas de los formatos entregados); **Empresarial** y **Disposición Total** todavía no tienen plantilla cargada — la UI lo indica en vez de inventar texto legal.
- El QR se genera en el navegador con `qrcode` (vendorizado en `public/vendor/qrcode.min.js`, ver §2) y codifica `origin + /verificar/<qr_token>`.
- **Verificación pública**: `public/index.html` revisa `window.location.pathname` antes de montar `AuthGate` — si coincide con `/verificar/:token`, monta `VerificacionPublica` en su lugar (sin login), que consume `GET /api/public/extractos/:qrToken`. Es la única ruta de la SPA que no pasa por autenticación.
- Roles: el rol `tramites` cubre lo que el proceso llama "Área de Trámites" y "Auxiliar Documental" (no existen como roles separados en el sistema); `operaciones` se usa como aproximación de "Logística" para clientes corporativos. Documentado como simplificación deliberada.

### 8.6 Pendiente

- Plantilla de contrato para modalidad **Empresarial** (no se entregó un formato de referencia).
- Número de Tarjeta de Operación del vehículo: la columna existe (`vehiculos.numero_tarjeta_operacion`) y la API ya la acepta, pero no hay campo en el formulario de Vehículos para editarla — hoy solo se puede fijar llamando a la API directamente.
- Carga real de archivos para el contrato firmado (hoy queda como `data:` URL en la base de datos vía `FileReader`, funcional pero no ideal a gran escala — ver §7).

## 9. Módulo Comercial — completo end-to-end, tarifario único para Comercial/Operaciones/Extractos

Reemplaza el slot "Comercial" (antes deshabilitado en `HomeERP`) por el módulo donde se dan de alta los clientes corporativos: cada cliente se crea con su contrato firmado y su tarifario, y queda pendiente de verificación en Trámites antes de poder generar extractos a su nombre. No duplica infraestructura: reutiliza `extracto_clientes`/`extracto_contratos` (§8), la misma bandera `es_corporativo` y el mismo flujo de aprobación de contrato que ya usa Extractos.

**Principio central**: el tarifario del cliente (`tarifario_items`) es la única fuente de rutas y tipos de servicio — Comercial lo administra (qué se cobra al cliente y qué se paga a afiliado/convenio por cada servicio), y tanto Operaciones (para crear servicios) como Trámites (para generar extractos) lo consultan tal cual, sin copiarlo. El contrato **no** limita cuántas rutas puede tener un cliente — puede tener cualquier cantidad de filas en su tarifario.

### 9.1 Modelo de datos

- `tarifario_items` — filas del tarifario de un cliente (`cliente_id → extracto_clientes`): tipo de servicio, tipo de vehículo, **descripción** (texto libre del servicio), origen/destino opcionales, valor del servicio en pesos, pago a afiliados/convenios por ese servicio, y `orden`. Se reemplaza por completo en cada guardado (`PUT /api/extractos/clientes/:id/tarifario` — `DELETE` + `INSERT` en una transacción), no hay historial de versiones del tarifario. Editable desde Comercial (alta y detalle de cliente) y desde el detalle de contrato en Trámites — ambos reutilizan `TarifarioTabla`.
- `extracto_clientes.formulario_disenado` — bandera que indica si Operaciones ya diseñó los campos adicionales del formulario de servicios de este cliente (ver 9.4).
- `extracto_contrato_historial` — bitácora por contrato (`contrato_id → extracto_contratos`): quién hizo qué y cuándo (creación, carga de firma, cambios de estado con motivo). Se muestra en el detalle del contrato tanto en Comercial como en Trámites.
- `contratos.extracto_cliente_id` — vincula un contrato de Operaciones (tabla `contratos`, la que usan `GET/POST/PUT /api/contratos` y `/api/servicios`, construida en una fase anterior pero nunca conectada al frontend hasta ahora) con el cliente de Comercial del que se generó automáticamente. El id de este contrato vinculado es siempre `com-<clienteId>`.
- `contrato_campos.id` ahora se expone en `GET /api/contratos` (antes se omitía) — lo necesita el frontend para poder editar/eliminar cada campo individualmente.
- `servicios.campos` (JSON) y `servicios.liquidacion` (JSON) — nuevas columnas para que un servicio real (tabla `servicios`) pueda guardar las respuestas a los campos personalizados del cliente y los datos de liquidación, igual que ya podía el servicio "mock" de Operaciones (`docs/BACKEND_DESIGN.md` §5).

### 9.2 Flujo cliente → contrato → verificación → habilitación de Operaciones

1. Comercial (o Trámites/admin) crea el cliente (`POST /api/extractos/clientes`, rol `comercial` habilitado) marcado `es_corporativo: true`, con su tarifario (cualquier cantidad de filas) y el contrato con el archivo firmado adjunto.
2. `POST /api/extractos/contratos` con `archivoFirmadoUrl` salta directo a `PENDIENTE_VALIDACION` en vez de `PENDIENTE_FIRMA` — esa es la "solicitud de verificación" que le llega a Trámites.
3. Trámites revisa el contrato (y puede editar el tarifario ahí mismo) y lo mueve a `APROBADO`, `DEVUELTO` o `RECHAZADO` vía `PUT /api/extractos/contratos/:id`.
4. **Al aprobar**, el backend crea (o reactiva) automáticamente un contrato vinculado en la tabla `contratos` de Operaciones (id `com-<clienteId>`, `extracto_cliente_id` apuntando al cliente) — esto es lo que "habilita a Operaciones" a generar servicios para ese cliente: aparece en su selector de Contrato y en la sección "Clientes Comercial".
5. Con `estado = APROBADO` el motor de validación (§8.3) también permite generar extractos a nombre del cliente, seleccionando cualquier fila de su tarifario.

### 9.3 Endpoints nuevos/cambiados

| Método y ruta | Notas |
|---|---|
| `GET /api/extractos/clientes/:id/tarifario` | Lista el tarifario del cliente, ordenado. |
| `PUT /api/extractos/clientes/:id/tarifario` | Reemplaza el tarifario completo (`items: [...]`, incluye `descripcion`). Roles `admin`/`tramites`/`comercial`. |
| `PUT /api/contratos/:id/campos` | Reemplaza los campos personalizados del formulario de servicios de ese contrato (`campos: [...]`). Si el contrato está vinculado a un cliente de Comercial, marca `formulario_disenado=1` en ese cliente. Roles `admin`/`operaciones`. |
| `POST /api/extractos` | Ahora requiere `tarifarioItemId` (antes `origen`/`destino` de texto libre) — ver §8.3 y §8.4. |

Además, `POST/PUT /api/extractos/clientes` y `POST /api/extractos/contratos` aceptan el rol `comercial` (antes solo `admin`/`tramites`); `PUT /api/extractos/contratos/:id` también.

**Bug preexistente corregido de paso**: `server.js` tenía dos funciones `contratoConDetalle` con el mismo nombre en el mismo scope (una para `contratos`/Operaciones, otra para `extracto_contratos`/Extractos) — en JavaScript la segunda pisaba silenciosamente a la primera, así que `/api/contratos` llevaba tiempo devolviendo la forma equivocada (sin `productos`/`conductorIds`/`campos`). Nunca se notó porque el frontend de Operaciones no consultaba esa API. Se renombró la de Operaciones a `opContratoConDetalle`.

### 9.4 Frontend

- `ComercialApp` — listado de clientes con badge de estado del contrato, alta de cliente con formulario + tarifario en modo tabla (`TarifarioTabla`, con columna Descripción) y carga del contrato firmado. **Ya no pide origen/destino del contrato** — el tarifario es la única fuente de rutas. El detalle de cada cliente (`ClienteComercialDetalleModal`) permite editar el tarifario en cualquier momento ("✎ Editar tarifario").
- El detalle de contrato en Trámites (`ContratoDetalleModal`, Extractos → Contratos) también muestra y permite editar el tarifario del cliente, además del historial — útil tanto para revisar lo que cargó Comercial como para clientes que no vienen de Comercial (Grupo Específico/Turística/ICBF creados directamente desde Trámites, que también necesitan tarifario para poder generar extractos).
- `GenerarExtractoForm` (Trámites → Extractos → Extractos): el campo de ruta ya no es texto libre — es un selector "Servicio y ruta" que carga el tarifario del cliente del contrato elegido y envía `tarifarioItemId`.
- **Operaciones → "Clientes Comercial"** (nuevo ítem de menú): lista los clientes de Comercial con contrato `APROBADO`, con badge "Diseñado"/"Pendiente de diseño" según `formulario_disenado`. `DisenarFormularioModal` deja agregar campos personalizados (mismo editor que ya tenía `ContratoFormModal` para sus campos: nombre, tipo, requerido, opciones) sobre el contrato vinculado (`com-<clienteId>`), guardando con `PUT /api/contratos/:id/campos`. El tarifario se muestra ahí solo de lectura ("lo administra Comercial").
- **Operaciones → Servicios** (`ServicioFormModal`): el selector de "Contrato" ahora incluye, además de los contratos locales/mock (`Universidad de Antioquia`, `EPM`, etc. — datos de ejemplo, sin persistencia real), los contratos reales vinculados a clientes de Comercial (marcados "(Comercial)"). Al elegir uno de estos:
  - El selector "Servicio y ruta" se llena con el tarifario real del cliente (`tarifario_items`, vía `GET /api/extractos/clientes/:id/tarifario`) en vez del tarifario local del contrato mock (`contrato.productos`).
  - **No hay "+ Generar nueva ruta"** — el tarifario de un cliente de Comercial solo lo edita Comercial (o Trámites), consistente con "Comercial es quien indica a Operaciones cuánto pagan y cuánto cobran por cada servicio". Se muestra un aviso pidiendo que Comercial agregue la ruta si falta.
  - Los campos personalizados vienen del contrato vinculado (`contrato_campos`, diseñados en "Clientes Comercial").
  - El servicio se guarda con `POST`/`PUT /api/servicios` (persistencia real), no en el store local del navegador — a diferencia de los contratos mock, que siguen usando `getServiciosStore()` sin persistir.
- Rol `comercial`: ya estaba anticipado en el esquema (comentarios desde las primeras migraciones) pero no tenía módulo asociado; este es el primero que lo usa.

### 9.5 Pendiente

- El tarifario no valida contra duplicados (misma combinación tipo de servicio + tipo de vehículo + origen/destino dos veces) — se guarda tal cual se ingresa.
- Los contratos/servicios "mock" de Operaciones (`Universidad de Antioquia`, `EPM`, `ICBF Regional Antioquia`, `Aeropuerto José María Córdova` — datos de ejemplo del prototipo original) siguen sin persistencia real; solo los clientes que llegan por el flujo Comercial → Trámites usan la API real de `contratos`/`servicios`. Migrar esos contratos de ejemplo a la API real (o reemplazarlos por clientes reales) queda pendiente — ver también §5.
- La liquidación de servicios reales (`servicios.liquidacion`) ya tiene columna y endpoint, pero no se probó con datos reales de facturación — sigue siendo la misma UI de siempre (`LiquidarServicioModal`), solo que ahora persiste para los clientes de Comercial.

## 10. Rutas por municipio, extracto por servicio, mora, buscador y firma electrónica

### 10.1 Rutas de Colombia (departamento → municipio)

`COLOMBIA_DEPARTAMENTOS` (en `public/index.html`, justo después del bloque `const { useState, ... } = React;`) es un dataset estático embebido con 33 "departamentos" (los 32 reales del DANE más `Bogotá D.C.` separado de Cundinamarca) y 1104 municipios, tomado de [marcovega/colombia-json](https://github.com/marcovega/colombia-json). `MunicipioField` es el selector encadenado departamento → municipio que lo consume; **solo el municipio se guarda/muestra** en las columnas `origen`/`destino` (texto libre en `extracto_contratos` y `tarifario_items`) — el departamento es solo un filtro de UI para no tener que buscar entre 1104 opciones de una vez.

### 10.2 Portal del Afiliado → Extractos (única sección real del portal)

`PortalAfiliadoExtractos` (pestaña "Extractos" del Portal del Afiliado) es la **primera y única parte de ese portal conectada a la API real** — el resto del portal sigue siendo una simulación con datos locales (`AFILIADO_DEMO`, `_cambiosStore`, etc., sin persistencia). Reutiliza la misma infraestructura de Comercial (§9), y sobre todo el mismo flujo de dos pasos de `ExtractosContratos`/`ContratoDetalleModal` que ya usaba Trámites internamente — el afiliado **no genera el extracto directamente**, genera (arma) el contrato, y solo cuando Trámites lo autoriza queda habilitado para generar extractos con él:

1. **Generar contrato** (`NuevoContratoAfiliadoForm`, pestaña "+ Generar contrato"): el afiliado captura cliente/grupo, objeto, tipo de servicio y la ruta origen/destino como municipios (`MunicipioField`) — sin adjuntar ningún archivo todavía. Esto crea el cliente, el contrato `GRUPO_ESPECIFICO` (arranca en `PENDIENTE_FIRMA`, igual que si lo creara Trámites) y la única fila del tarifario del cliente con esa ruta. `onCreado` cambia automáticamente a la pestaña "Mis contratos" y abre el detalle del contrato recién creado.
2. **Imprimir, firmar y cargar** (`MisContratosAfiliado` → botón "Ver" → `ContratoDetalleModal`, reutilizado tal cual del módulo de Trámites): desde ahí el afiliado puede generar/imprimir el documento del contrato (`GenerarContratoDocModal`, plantilla `GRUPO_ESPECIFICO`), cargar el PDF/imagen ya firmado, y solo entonces aparece el botón "Enviar a validación de Trámites" — antes de cargar la firma se muestra un texto explicándolo en vez del botón, y `PUT /api/extractos/contratos/:id` rechaza con 400 el intento de pasar a `PENDIENTE_VALIDACION` sin `archivo_firmado_url` (ni desde este flujo ni llamando la API directo), sea quien sea el que llame.
3. **Autorización de Trámites**: mismo mecanismo que Comercial — Trámites aprueba/devuelve/rechaza desde su propia vista de `ExtractosContratos`. Como `ContratoDetalleModal` es el mismo componente para staff y afiliado, se le agregó la prop `soloAfiliado` (pasada en `true` solo desde `MisContratosAfiliado`): mientras el contrato está `PENDIENTE_VALIDACION`, en vez de los botones de Aprobar/Devolver/Rechazar el afiliado ve un aviso de que su solicitud está en manos de Trámites — y tampoco ve el botón "✎ Editar tarifario" (evita que edite unilateralmente sus propios precios/pagos). Solo Trámites puede mover el estado.
4. **Generar extracto**: con el contrato `APROBADO`, aparece "📄 Generar extracto" en la fila de "Mis contratos"; el afiliado elige uno de sus propios vehículos (y el conductor asignado a ese vehículo) y genera el extracto — `generadoPorTipo: 'AFILIADO'`, así que le aplican las mismas reglas de mora e ICBF/corporativo que a cualquier generación de afiliado (§10.3).

No existe todavía un rol/login de "afiliado" distinto de los roles admin/tramites/operaciones/comercial — quien esté autenticado en la app ve y usa este flujo. Formalizar una sesión propia para afiliados queda fuera de este alcance.

### 10.3 Mora vs. ICBF/corporativo — reglas independientes

`validarGeneracionExtracto` separó dos restricciones que antes iban juntas bajo `generadoPorTipo === 'AFILIADO'`:

- **Cliente no autorizado** (ICBF/corporativo): un afiliado generando *manualmente* no puede tocar estos clientes — se mantiene, es la restricción original que motivó el módulo Comercial.
- **Mora del afiliado**: si el vehículo tiene saldo pendiente en `cartera`, bloquea **siempre** que el canal sea "afiliado", sin importar el tipo de cliente — ni siquiera un contrato aprobado lo salta.

El parámetro `viaServicio` (ver 10.4) hace una excepción puntual solo a la primera regla: completar el papeleo de un servicio puntual que la empresa ya asignó y tarifó no es lo mismo que un afiliado generando libremente a nombre de un cliente corporativo. La mora nunca se salta, tenga o no `viaServicio`.

### 10.4 Generar extracto de un servicio puntual (un clic)

`POST /api/servicios/:id/generar-extracto` (`requireAuth`, sin rol específico — pensado para que lo dispare quien esté a cargo del servicio, p. ej. el conductor) no recibe datos: todo sale del propio servicio.

1. El servicio debe estar vinculado a un contrato real de Comercial (`contratos.extracto_cliente_id`) con `extracto_contratos` en estado `APROBADO`.
2. Debe tener `vehiculo_id` y `conductor_id` asignados.
3. Busca en el tarifario del cliente una fila cuyo `tipo_servicio`/`origen`/`destino` coincidan exactamente con los del servicio (así se generó el servicio en primer lugar, §9.4) — si no hay match, `"Ruta no autorizada"`.
4. Llama a `crearExtracto` con `fechaInicio = fechaFin = servicios.fecha`, `generadoPorTipo: 'AFILIADO'`, `viaServicio: true` — corre el mismo motor de validación de siempre (documentos, mora, etc.), sin atajos de compliance.
5. Si se genera, guarda `servicios.extracto_id` — un servicio solo puede generar un extracto una vez (`"Este servicio ya tiene un extracto generado"` si se reintenta).

En el frontend, la fila del servicio (`Servicios` → `AccionesMenu`) muestra "📄 Generar extracto" solo si el contrato es real y el servicio no tiene ya uno.

**Bug corregido de paso**: al fusionar servicios reales (`GET /api/servicios`, columnas `snake_case`) con los servicios mock (`contratoId`/`vehiculoId`/`conductorId` en `camelCase`) en la lista de `Servicios`, faltaba mapear los nombres — los servicios reales mostraban "—" en Cliente/Vehículo/Conductor porque las búsquedas por `s.contratoId` etc. no encontraban nada. `refresh()` en `Servicios` ahora mapea `contrato_id → contratoId`, etc. al mezclar.

### 10.5 Duplicar extracto

Ya existía (`POST /api/extractos/:id/duplicar`) y ya cumplía la especificación: copia cliente/vehículo/conductor/ruta (`tarifario_item_id`) y datos contractuales, pide nueva vigencia (`fechaInicio`/`fechaFin`) y nueva declaración de responsabilidad, genera un nuevo consecutivo de FUEC y una nueva `created_at` — el extracto original no se toca. Solo se ajustó el texto del botón/alerta para que sea explícito sobre qué se copia y qué no.

### 10.6 Buscador de extractos

`ExtractosListado` (pestaña "Extractos" de Trámites → Extractos) filtra en el cliente (sin cambios de API) sobre el resultado ya cargado de `GET /api/extractos`: cliente, placa, número de FUEC, conductor (texto libre, busca por nombre), estado, modalidad, rango de fecha de creación (`created_at`) y rango de vigencia (`fecha_inicio`/`fecha_fin`).

### 10.7 Firma electrónica

- `users.firma_url` — imagen (PNG en `data:` URL) que cada usuario dibuja una vez en un `<canvas>` (`FirmaCanvas`/`MiFirmaModal`, botón "✍️" en la barra superior de Trámites) y se guarda con `PUT /api/auth/firma`. Se expone en `GET /api/auth/me` y en la respuesta de login.
- `extracto_contrato_historial.firma_url` — cuando un usuario cambia el estado de un contrato (`PUT /api/extractos/contratos/:id` con `estado`), si tiene firma guardada, se copia (no se referencia) a esa fila del historial — es una foto del momento, no cambia si el usuario redibuja su firma después. Se muestra inline en el historial del `ContratoDetalleModal`.
- Pendiente: solo se firma el cambio de estado del contrato (aprobar/devolver/rechazar). No se firman todavía la generación/anulación de extractos ni los documentos PDF generados (contrato imprimible, FUEC) — sería el siguiente paso natural si se necesita la firma impresa en esos documentos.

### 10.8 Portal del Afiliado → Conductor (edición, documentos, reasignación y ficha)

La pestaña "Conductor" del Portal del Afiliado (`PortalAfiliado`, sección demo) tenía un bug de fondo: el conductor mostrado por vehículo salía de un estado local (`conductorVeh`, un `useState({})` que nunca se llenaba desde ningún lado más que el propio formulario de asignación) en lugar del store real de conductores (`getConductores()`, respaldado por `/api/conductores`). Como consecuencia, en cuanto Trámites aprobaba la asignación (que sí crea el conductor real vía `addConductorAprobado`), el afiliado seguía viendo "Sin conductor asignado" — parecía que la asignación no había funcionado, y no había forma de editar al conductor, cargarle documentos, ni reasignarlo a otro vehículo tras la aprobación.

Cambios:

- **Fuente de verdad real**: `cond = conductores.find(c => c.vehiculo === v.id && c.activo)`, con `conductores` como estado local sincronizado con `getConductores()` (`refreshConductores()`). Así, apenas Trámites aprueba, el afiliado lo ve reflejado.
- **Editar datos** (`✏ Editar datos`): reutiliza el mismo modal de "Asignar conductor" pre-cargado con los datos actuales; genera un cambio pendiente `CONDUCTOR_EDITAR` con `conductorId`. Al aprobarse, `updateConductorStore(conductorId, {...})` actualiza el store local y persiste con `syncConductorFields` (`PUT /api/conductores/:id`).
- **Cambiar vehículo** (`🔁 Cambiar vehículo`, visible si el afiliado tiene más de un vehículo — disponible tanto desde la pestaña "Conductor" como desde "Mis Vehículos"): genera un cambio `CONDUCTOR_VEHICULO` con el vehículo destino. Al aprobarse, actualiza `vehiculo` en el store y en el servidor.
- **Cargar documentos** (dentro de la ficha, uno por tipo — licencia, seg. social, examen médico, mant. defensivo, antecedentes, cédula, habeas data): genera un cambio `CONDUCTOR_DOC` con `conductorId`/`campo`/fecha de vencimiento/archivo. Al aprobarse, `updateConductorDocStore` recalcula el estado (VIGENTE/PROXIMO/VENCIDO) igual que para documentos de vehículo y persiste con `syncConductorDoc` (`PUT /api/conductores/:id/documentos/:docTipo`).
- **Ficha de conductor** (clic en el nombre, en "Conductor" o en "Mis Vehículos"): modal de solo lectura con los datos del conductor y la lista completa de documentos con su estado (`DocBadge`) y botón de actualizar por documento — mismo patrón visual que la pestaña "Documentos" de vehículo.
- `ValidacionesAfiliados.aprobar()` gana los tres tipos nuevos (aplican el cambio al store real) y el `TIPO_ICO`/`TIPO_CLS`/vista previa del listado de pendientes se extendieron para mostrarlos con contexto (nuevos datos, vehículo destino, documento + vencimiento). De paso se corrigió un bug menor: el toast de aprobación decía siempre "conductor agregado al módulo de Conductores" sin importar el tipo de cambio (documento, pago, planilla…) — ahora ese texto solo aplica cuando el tipo es `CONDUCTOR` (alta nueva).
- **Bug de apilamiento de modales corregido de paso**: la ficha y el modal de "Actualizar documento" son dos `Modal` independientes que pueden estar abiertos a la vez (se abre el de documento sin cerrar la ficha). Como ambos usan el mismo overlay de pantalla completa, el que se declara **después** en el árbol se pinta encima — al principio la ficha estaba declarada después del modal de documento, así que su overlay tapaba el botón "Enviar para revisión" y el clic no llegaba a ningún lado. Se reordenó para que el modal de documento se declare después de la ficha.
- **Selectores de mes de todo el año**: `opcionesMesAnio()` (helper nuevo, junto a `MunicipioField`) genera las 12 opciones "Mes Año" del año en curso; reemplazó las listas de 3-6 meses "quemadas" a mano en Pago Administración y Planilla SS/ARL del Portal del Afiliado, y en los dos selectores equivalentes del módulo de Conductores de Trámites (reporte individual y masivo de Seguridad Social).

## 12. Tablero de Operaciones — calendario tipo Google Calendar

El módulo "Tablero" de Operaciones (`OperacionesApp`, entrada de menú `operaciones`) era un motor de despacho legacy (`EcservisEngine`) — HTML/CSS/JS plano de ~185.000 caracteres inyectado con `innerHTML` + `new Function(...)`, con su propio mapa Leaflet, completamente aparte de React. Se eliminó por completo (`ECW_CSS`, `ECW_BODY_HTML`, `ECSERVIS_ENGINE_SRC`, `EcservisEngine`), junto con un `AsignarModal` que quedó como código muerto de un tablero Kanban anterior (nunca se usaba en ningún lado). En su lugar, `OperacionesTablero` es ahora un calendario propio, construido con los mismos componentes que ya usa "Servicios" (`ServicioFormModal`, `VerServicioModal`, `LiquidarServicioModal`, `AccionesMenu`) — cada **evento del calendario es un servicio**.

- **Vistas** (`vista`: `dia` | `semana` | `mes`, por defecto `semana`, como Google Calendar):
  - **Mes**: grilla de 7 columnas al estilo `CargaOperativa` pero con los eventos reales como chips (hasta 3 por día + "+N más", que lleva a la vista de Día de ese día).
  - **Semana/Día**: grilla de horas (`TABLERO_HORAS`, 05:00–22:00) × columnas de día (7 en semana, 1 en día); cada servicio se ubica en la fila de su hora de inicio — no hay hora de fin en el modelo de datos, así que no se dibuja un bloque proporcional a la duración (sería una precisión que los datos no respaldan), pero si dos servicios comparten hora se apilan en la misma celda.
  - Navegación: "Hoy" / ‹ / › (avanza un día, semana o mes según la vista activa) + etiqueta del período.
- **Colorear por** (`colorBy`: `estado` | `cliente` | `conductor`): por estado usa una paleta fija (`TABLERO_ESTADO_COLOR`); por cliente/conductor usa un hash determinístico del id sobre `PALETA_PRODUCTOS` (la misma paleta que ya coloreaba los productos de servicio) para que cada cliente/conductor tenga siempre el mismo color. Debajo de los filtros se muestra una leyenda con los colores realmente presentes en el período visible.
- **Filtros**: estado, cliente/contrato, conductor, vehículo — mismo patrón que `Servicios`/`Produccion`.
- **Crear desde el calendario**: clic en una celda vacía abre `ServicioFormModal` precargado con `{fecha, hora}` de esa celda (en Mes, solo `fecha`). Esto requirió dos ajustes puntuales y seguros en `ServicioFormModal` (usado también por la lista de Servicios, sin cambio de comportamiento ahí): el estado inicial del formulario ahora siempre parte de un único objeto `SERVICIO_FORM_DEFAULT` y le superpone `servicio` (antes, en modo edición, se perdían los defaults de los campos no incluidos en `servicio`); y el título usa `servicio && servicio.id` en vez de solo `servicio` para distinguir "nuevo precargado" (sin `id`) de "editar" (con `id`).
- **Editar/cancelar/liquidar/generar extracto** desde cualquier evento: cada chip (`TableroEvento`) trae el mismo `AccionesMenu` que la lista de Servicios, con la misma lógica de guardado (mock local vs. `/api/servicios` real según si el contrato tiene `extracto_cliente_id`, igual que en `Servicios`) — duplicada intencionalmente en vez de extraída a un hook compartido, para no arriesgar el comportamiento ya probado de la lista.
- **Bug de propagación de clics corregido durante las pruebas**: el chip del evento (`TableroEvento`) es un contenedor flex con dos hijos (etiqueta y menú de acciones), cada uno con su propio `stopPropagation`; un clic que cayera justo en el borde/`gap` del contenedor —fuera de ambos hijos— no lo detenía y burbujeaba hasta la celda del calendario, abriendo "Nuevo Servicio" por accidente. Se agregó `stopPropagation` también en el contenedor raíz del chip.

## 13. Secuencia de estados del servicio, detalle completo y datos de demostración de septiembre

### 13.1 Nueva secuencia de estados

El estado de un servicio (`servicios.estado`, columna de texto libre — sin `CHECK` en SQLite, se valida solo en el frontend) pasó de 6 valores (`Pendiente, Asignado, En Curso, Finalizado, Cancelado, Liquidado`) a una secuencia operativa más granular, definida una sola vez en `public/index.html`:

```js
const ESTADOS_SERVICIO_SECUENCIA = ['Creado', 'Asignado', 'Aceptado', 'En Ruta', 'En Sitio', 'Realizando', 'Finalizado', 'Liquidado', 'Liquidado Confirmado'];
const ESTADOS_SERVICIO_TODOS = [...ESTADOS_SERVICIO_SECUENCIA, 'Cancelado'];
const SIGUIENTE_ESTADO_SIMPLE = { 'Creado': 'Asignado', 'Asignado': 'Aceptado', 'Aceptado': 'En Ruta', 'En Ruta': 'En Sitio', 'En Sitio': 'Realizando', 'Realizando': 'Finalizado' };
```

`Cancelado` sigue siendo un estado de excepción aparte, no un paso más de la secuencia (puede ocurrir desde casi cualquier punto). Estas tres constantes son la única fuente de verdad — reemplazaron los arreglos `['Pendiente', 'Asignado', ...]` que antes estaban repetidos y "quemados" en cuatro lugares distintos (filtros de `Servicios`, filtros del Tablero, el `<select>` de estado de `ServicioFormModal`, y `ESTADOS_ORDEN` de `Producción`).

`SIGUIENTE_ESTADO_SIMPLE` cubre solo los pasos que son un cambio de estado sin datos que capturar. Los otros dos pasos tienen su propio flujo:
- **Finalizado → Liquidado**: pasa por `LiquidarServicioModal` (tarifa confirmada, valor a pagar, a quién pagar, novedades) — no es un salto de un clic.
- **Liquidado → Liquidado Confirmado**: un botón dedicado, "✓ Confirmar liquidación", sin modal.

`AccionesMenu` ahora recibe un único prop `estado` (en vez de los booleanos `cancelado`/`liquidado` que tenía antes) y deriva todo internamente: si hay un `SIGUIENTE_ESTADO_SIMPLE[estado]` muestra "▶ Marcar «X»"; si `estado === 'Liquidado'` muestra "✓ Confirmar liquidación"; "Cancelar servicio" se oculta una vez el servicio ya está liquidado (antes solo se ocultaba si ya estaba cancelado); "Liquidar servicio" solo aparece cuando `estado === 'Finalizado'` (antes aparecía para cualquier estado no cancelado, lo que permitía liquidar un servicio recién creado saltándose toda la secuencia). Los dos lugares que renderizan `AccionesMenu` (la lista de `Servicios` y los chips del Tablero, `TableroEvento`) ganaron los handlers `handleAvanzarEstado`/`handleConfirmarLiquidacion`, con la misma lógica mock-vs-`/api/servicios` real que ya tenían `handleCancelar`/`handleLiquidar` (duplicada en ambos componentes a propósito, ver §12).

Colores: `ESTADO_SVC_BADGE` (clases CSS `.badge`, para tablas) se remapeó a los 10 estados reutilizando las 7 clases de badge que existen (`bg/br/by/bb/bgr/bdk/bamb` — no hay más definidas en el CSS, así que algunos estados adyacentes comparten clase, p.ej. `Asignado`/`Aceptado` en azul o `Liquidado`/`Liquidado Confirmado` en oscuro; el texto de la etiqueta sigue distinguiéndolos). `TABLERO_ESTADO_COLOR` (colores inline del calendario, sin esa limitación) tiene los 10 colores completamente distintos.

Los ~458 servicios de ejemplo preexistentes (`servicios0`) se migraron a la nueva nomenclatura: `Pendiente → Creado`, `En Curso → Realizando` (los demás nombres no cambiaron).

### 13.2 Detalle completo del servicio (`VerServicioModal`)

Antes solo mostraba contrato/fecha-hora/origen/destino/vehículo/conductor/pax/valor/observaciones. Ahora:

- **Ruta**: sección propia con origen, destino y, si el cliente tiene un campo personalizado de tipo `paradas` (ver §9, `DisenarFormularioModal`/`ParadasField`) y el servicio tiene datos ahí, la lista numerada de paradas. Sigue mostrando el enlace a Google Maps (`RutaMapaLink`) cuando hay geocoordenadas.
- **Valor a pagar al proveedor**: solo para servicios de un cliente de Comercial (`contrato.extracto_cliente_id`). El servicio guarda el valor cobrado al cliente (`s.valor`) pero no lo que se le paga al afiliado/proveedor — eso vive en el tarifario del cliente (`tarifario_items.pago_afiliado`, ver §9). Al abrir el modal, un `useEffect` pide `/api/extractos/clientes/:id/tarifario` y busca la fila cuyo producto/origen/destino coincide con el servicio (la misma que se usó para crearlo) para mostrar ese valor. Para contratos mock (no Comercial) esta fila no se muestra — ese modelo de datos no tiene el concepto de "pago a proveedor" separado.
- **Campos personalizados del cliente**: cualquier otro campo (`contrato.campos`, distinto de `paradas`) que el servicio tenga respondido se lista igual que en el formulario de edición.

### 13.3 Datos de demostración: servicios del 1 al 20 de septiembre de 2026

`generarServiciosDemoSeptiembre()` (junto a `getServiciosStore()`) genera, completamente en el navegador (no se guarda en el servidor — es puramente para poblar la demo), entre 50 y 70 servicios ficticios por cada día del 1 al 20 de septiembre de 2026, con hora repartida entre las 05:00 y las 22:00 (igual rango que la grilla del Tablero). Usa los 4 contratos de ejemplo (`k001`-`k004`) con sus productos/campos reales, vehículos `v001`-`v005` y conductores `c001`-`c003` (los mismos que siembra `database.js`), y reparte los 10 estados con una distribución ponderada (más peso en `Creado`/`Asignado`/`Finalizado`/`Liquidado`, menos en `Cancelado`). Para el contrato del Aeropuerto (`k004`), ~1 de cada 3 servicios recibe 1-3 paradas falsas en su campo `Paradas del recorrido`, para poder ver esa sección del detalle sin tener que crear un servicio a mano. Los IDs usan el prefijo `sd` (`sd0001`, `sd0002`, ...) para no chocar con los `s001`-`s458` del set de ejemplo original ni con los que genera `addServicioStore` al crear servicios nuevos desde la UI.

### 13.4 Todos los servicios con ruta real en Google Maps

`LOC_COORDS` (junto a `generarServiciosDemoSeptiembre`) es un diccionario nombre-de-lugar → `[lat, lng]` con coordenadas aproximadas del área metropolitana de Medellín, para los ~29 nombres de lugar que aparecen como origen/destino/parada en los servicios de ejemplo (tanto los 458 originales como los generados para septiembre). `locGeo(nombre)` la consulta y devuelve `{lat, lng}` o `null`. Antes, los 458 servicios de ejemplo originales tenían `origenGeo`/`destinoGeo` en `null` (nunca se georreferenciaron a mano), así que `RutaMapaLink` no mostraba el enlace "Ver ruta en Google Maps" en ninguno. Ahora:
- `generarServiciosDemoSeptiembre()` asigna `origenGeo`/`destinoGeo` (y geo a cada parada) desde `LOC_COORDS` al generar cada servicio.
- `getServiciosStore()` completa `origenGeo`/`destinoGeo` de los 458 servicios originales por nombre, la primera vez que se cargan (sin pisar un geo que ya exista).

Con esto, todo servicio de ejemplo cuyo origen/destino sea uno de esos ~29 lugares conocidos queda con ruta real navegable en Google Maps desde su detalle (`VerServicioModal`). Un servicio creado a mano por un usuario con una dirección de texto libre no incluida en `LOC_COORDS` sigue sin geo, como siempre — para eso está la integración real de Google Places en `AddressField` (pendiente de API key, ver README).

### 13.5 Asignar conductor y vehículo al pasar a "Asignado"

Antes, `Creado → Asignado` era un salto "de un clic" más de `SIGUIENTE_ESTADO_SIMPLE`, sin pedir ningún dato — un servicio podía quedar "Asignado" sin conductor ni vehículo real. Ahora ese paso abre `AsignarServicioModal`: se elige primero el conductor (obligatorio) y, al elegirlo, se precarga automáticamente el vehículo que tiene asignado por defecto (`conductor.vehiculo`, el mismo campo que administra Trámites en el módulo de Conductores) — el campo de vehículo queda editable por si el servicio necesita un vehículo distinto al habitual de ese conductor. Al confirmar, guarda `{estado: 'Asignado', vehiculoId, conductorId}` con el mismo patrón mock-vs-`/api/servicios` real que el resto de acciones. `AccionesMenu` gana el botón "▶ Asignar conductor y vehículo", visible solo cuando `estado === 'Creado'` (se quitó `'Creado': 'Asignado'` de `SIGUIENTE_ESTADO_SIMPLE` para que no compitiera con este flujo).

### 13.6 Filtros de selección múltiple (cliente, conductor, vehículo)

`MultiSelectFiltro` (junto a `FG`) reemplaza los `<select>` de una sola opción por un desplegable de casillas: el botón muestra "Todos", el nombre de la única opción marcada, o "N seleccionados"; el popover lista todas las opciones con checkbox y un botón "✕ Limpiar selección". El estado del filtro pasa de un string (`'todos'` o un id) a un arreglo de ids (`[]` = todos), y el filtrado cambia de `x === valor` a `arreglo.length === 0 || arreglo.includes(valor)`. Se aplicó a los tres filtros de cliente/contrato, conductor y vehículo en el Tablero de calendario, en la lista de Servicios (que además ganó ahí filtros explícitos de conductor y vehículo — antes solo tenía cliente, y conductor/vehículo solo se alcanzaban por el buscador de texto libre) y en Producción y Rentabilidad.

## 14. Numeración de servicio, jerarquía de campos, ruta gráfica, historial, línea de "ahora", búsqueda por número y ficha del contrato

Esta sección cubre un lote de pedidos puntuales sobre Operaciones. Dos pedidos de ese mismo lote —la carga masiva de tarifas por Excel al crear un cliente, y el portal móvil de conductor con la máquina de estados accionada por el propio conductor (incluido el estado "Rechazado" con alerta a la logística)— **no están incluidos aquí**: son subsistemas por sí solos y quedaron deliberadamente para una siguiente etapa. Todo lo demás de la solicitud sí quedó implementado en esta pasada.

### 14.1 Numeración legible del servicio (`numero`)

Cada servicio ahora tiene, además de su `id` técnico (PK, usado en las rutas de la API — no puede contener `/`), un `numero` legible con formato `DD/MM/AA-NNN`, donde la fecha es la de agendamiento (`servicios.fecha`) y `NNN` es un consecutivo de 3 dígitos entre los servicios agendados ese mismo día.

- **Backend** (`server.js`): nueva columna `servicios.numero TEXT` (`database.js`). `numeroServicio(fecha)` cuenta cuántos servicios ya existen con esa `fecha` y arma el siguiente consecutivo; se llama desde `POST /api/servicios` al crear.
- **Mock** (`public/index.html`): `numeroServicioMock(fecha)` hace lo mismo contra `_serviciosStore`; se llama desde `addServicioStore`. `getServiciosStore()` completa `numero` en los 458 servicios de ejemplo originales (que no lo traían) con un contador por fecha, la primera vez que se cargan — mismo patrón ya usado para `origenGeo`/`destinoGeo` (ver §13.4).
- El `numero` se muestra en vez del `id` en la columna de la tabla de Servicios y en el título de `VerServicioModal`/`HistorialServicioModal`; el buscador de servicios y la búsqueda del Tablero (§14.6) aceptan tanto `numero` como `id`.

### 14.2 Campos nuevos del servicio y jerarquía de visualización

Tres campos nuevos en `servicios`: `ventana_ruta` (texto libre, ej. "06:00 - 06:30"), `referencia` (texto libre, referencia/PO del cliente) y `usuarios` (JSON `[{nombre, telefono, id}]` — los pasajeros nominados del servicio, distintos de `pax`, que sigue siendo solo el conteo). Se agregaron a `database.js`, a los `cols` de `POST`/`PUT /api/servicios` en `server.js`, y a `servicioApiBody` en ambos componentes que hablan con la API real (`Servicios`, `OperacionesTablero`).

`UsuariosField` (junto a `ParadasField`/`AddressField`) es el componente repetible de nombre+teléfono+ID para capturar `usuarios` en el formulario.

`ServicioFormModal` y `VerServicioModal` se reordenaron para seguir la jerarquía solicitada: **Cliente → Fecha → Hora → Tipo de servicio → Origen → Destino → Ventana de ruta → Referencia → Anotaciones generales (antes "Observaciones") → Número de usuarios (antes solo "Pasajeros") → Usuarios (nombre+teléfono+ID) → Valor**. Los campos operativos que no pertenecen a esa jerarquía de negocio (estado, vehículo, conductor, campos personalizados del contrato) quedaron después, separados por un `divider`.

### 14.3 Ventana gráfica de la ruta (`RutaMapaGrafico`)

Pedido: ver la ruta del servicio "de forma gráfica" dentro de su ficha, incluyendo paradas adicionales — sin depender de una API key de mapas (el proyecto ya evita ese requisito para funcionalidad núcleo, ver `AddressField`). `RutaMapaGrafico` (junto a `RutaMapaLink`) dibuja un mini-mapa esquemático en SVG: proyecta las coordenadas de origen/paradas/destino (`origenGeo`/`campos[paradaId].geo`/`destinoGeo`) a un `viewBox` normalizado, traza una línea punteada entre los puntos en orden y marca cada uno con un círculo rotulado (O / 1, 2, 3... / D) más una leyenda de texto debajo. Si no hay ninguna coordenada disponible, muestra un mensaje en vez de un mapa vacío. Se usa en `VerServicioModal`, junto al enlace existente "Ver ruta en Google Maps" (`RutaMapaLink`), que sigue abriendo la ruta real cuando el usuario la necesita.

### 14.4 Historial de cambios del servicio

Nueva columna `servicios.historial TEXT` (JSON `[{fecha, usuario, accion, detalle}]`), con guardado automático — el usuario nunca lo edita a mano — en cada creación y cada cambio:

- **Backend**: `actorNombre(req)` resuelve el nombre del usuario autenticado desde la sesión; `agregarHistorial(id, entrada)` hace `SELECT` + `UPDATE` del JSON dentro de una `db.transaction`. Se llama desde `POST /api/servicios` (entrada "Servicio creado") y desde `PUT /api/servicios/:id` (una entrada por cada actualización, con el detalle "Cambió estado a: X" cuando la actualización incluye `estado`, o "Editó el servicio" en otro caso).
- **Mock**: `agregarHistorialMock(id, entrada)` hace el mismo `map` sobre `_serviciosStore`; se llama desde `updateServicio` y `addServicioStore`. Los servicios de ejemplo (los 458 originales y los generados para septiembre, ver §13.3) reciben una entrada semilla "Servicio creado" al cargarse, para que el historial nunca aparezca vacío en la demo.
- **UI**: `HistorialServicioModal` (nuevo) lista las entradas más recientes primero. Se abre desde el botón "🕐 Ver historial" en `AccionesMenu` (nueva prop `onVerHistorial`) y desde el mismo botón dentro de `VerServicioModal` — ambos puntos de entrada están cableados en los dos lugares que usan estos modales (`Servicios` y `OperacionesTablero`), cada uno con su propio estado `viendoHistorial`.

### 14.5 Línea de "ahora" en la vista de Día del Tablero

`TableroGridHoras` calcula, solo cuando se está viendo un único día (`dias.length === 1`) y ese día es hoy, la posición vertical de la hora actual dentro de la grilla (usando la altura de fila fija `ROW_H`/`HEADER_H` que ya usa la grilla) y dibuja una línea roja horizontal con un punto y la hora en un pequeño rótulo, superpuesta con `position: absolute`. Un `setInterval` de 60s fuerza un re-render para que la línea avance sin que el usuario tenga que refrescar la página. La ficha del servicio (`VerServicioModal`) ya muestra, como sus primeros campos por la jerarquía de §14.2, exactamente lo pedido para la "previsualización" de día: fecha, hora, cliente, tipo de servicio y ruta — no se construyó un componente de previsualización aparte porque hacerlo hubiera duplicado esa misma información.

### 14.6 Búsqueda por número de servicio en el Tablero

Nuevo cuadro "🔎 Buscar por N.° de servicio" en la cabecera de `OperacionesTablero`: busca por `numero` o por `id` técnico entre los servicios visibles para el usuario (ver §14.8), cambia la vista a Día en la fecha donde está agendado (reutilizando `irADia`, la misma función que usa el clic en un día del Mes) y abre directamente su `VerServicioModal` con toda la información. Si no encuentra coincidencia, muestra un mensaje de error en línea en vez de fallar en silencio.

### 14.7 Ficha del contrato: contactos y consideraciones

Cinco columnas nuevas en `contratos` (`contacto_negociador`, `contacto_contable`, `consideraciones_operativas`, `consideraciones_contables`, `consideraciones_comerciales`), agregadas a `database.js` y a los `cols` de `POST`/`PUT /api/contratos` en `server.js`. `ContratoFormModal` gana los inputs correspondientes (los tres de consideraciones como `textarea`) y la ficha de cada contrato en el listado de `Contratos` los muestra condicionalmente (solo si tienen contenido, igual que el resto de campos opcionales de la ficha).

Nota de alcance: el componente `Contratos` del frontend sigue siendo 100% mock (`updateContrato`/`addContratoStore` sobre `_contratosStore`, nunca llama a `/api/contratos`) — una brecha preexistente, no introducida en esta pasada. Las columnas y el `cols` del backend quedaron listos para cuando se conecte, pero por ahora estos campos nuevos solo persisten para los contratos de ejemplo/demo, igual que el resto de la ficha de contrato.

### 14.8 Visibilidad de servicios por logístico asignado en Operaciones

Pedido: que un usuario de Operaciones solo vea los servicios de los contratos donde está asignado como logístico. En vez de construir un sistema nuevo de asignación de usuarios a contratos, se reutilizó el campo de texto libre `logisticoNombre` que ya existía en el contrato (ver §11/12) — evita un endpoint `GET /api/users` y una UI de asignación que el pedido no alcanzaba a justificar por sí solo.

`contratosVisiblesOperaciones(contratos)` (junto a `habilitadosParaOperar`/`conductoresHabilitados`) es la única fuente de verdad: si `USUARIO.rol !== 'operaciones'` devuelve la lista sin tocar; si es `'operaciones'`, filtra a los contratos sin logístico asignado (visibles para todos, para no bloquear contratos legados que nunca se configuraron) o cuyo `logisticoNombre` coincide exactamente con `USUARIO.nombre`. Se aplica en `Servicios` y `OperacionesTablero`, en dos capas: sobre la lista de `contratos` que ambos componentes arman (de donde salen también las opciones de los filtros y el selector del formulario) y, explícitamente, sobre la lista de servicios que se muestra (`filtered` en `Servicios`, `serviciosFiltrados` y la búsqueda por número en `OperacionesTablero`) — un servicio cuyo contrato no está en la lista visible no aparece, aunque el usuario intente encontrarlo por número.

Esta es una comparación de texto exacta y sensible a mayúsculas contra `logisticoNombre`, no una relación por id — coherente con que el campo del contrato tampoco es una relación por id, sino texto libre.

## 15. Mapa real de la ruta, carga masiva de tarifas por Excel y Portal Conductor

### 15.1 Mapa real de la ventana de ruta (Leaflet + OpenStreetMap)

El mini-mapa esquemático en SVG de §14.3 mostraba los puntos de la ruta sobre un lienzo en blanco — sin calles, sin contexto geográfico. Se reemplazó por un mapa real: `RutaMapaGrafico` ahora monta un mapa de [Leaflet](https://leafletjs.com/) (cargado por CDN — `<link>`/`<script>` de `unpkg.com/leaflet@1.9.4` en el `<head>`, sin necesidad de API key) con teselas de OpenStreetMap (`tile.openstreetmap.org`, gratuitas, con su atribución obligatoria visible en el mapa). Un marcador circular rotulado (O / 1, 2, 3.../ D, mismos colores que antes) se coloca por cada punto con coordenadas, el mapa hace `fitBounds` para encuadrarlos todos, y se traza el recorrido en dos pasos:
1. Inmediatamente, una línea recta punteada entre los puntos (para que el mapa nunca se vea "vacío" mientras carga).
2. En segundo plano, una petición a [OSRM](http://project-osrm.org/) (`router.project-osrm.org`, servidor demo público, sin API key) pide la geometría de la ruta vial real; si responde a tiempo, reemplaza la línea recta por el trazado real y reencuadra el mapa a esa geometría. Si la petición falla o no hay red, la línea recta se queda — el mapa sigue siendo útil, solo menos preciso.

Ambos servicios externos (OpenStreetMap y OSRM) son gratuitos y no requieren credenciales, consistente con cómo el resto de la plataforma evita depender de API keys pagas para funcionalidad núcleo (ver `AddressField`/Google Places). El componente es tolerante a que Leaflet no llegue a cargar (red bloqueada, CDN caído): el `useEffect` que inicializa el mapa comprueba `window.L` antes de usarlo y simplemente no dibuja nada si no está disponible, sin romper el resto de la ficha del servicio.

### 15.2 Carga masiva de tarifas por Excel + tarifarios por defecto (Comercial)

Pedido: poder definir una base de tarifas ya cargada por defecto al crear un cliente, o cargarlas masivamente desde Excel. Ambas cosas se resolvieron dentro de `TarifarioTabla` (el editor de filas de tarifario reutilizado en alta de cliente, edición desde `ClienteComercialDetalleModal` y edición de contrato desde `ContratoDetalleModal`) — no fue necesario tocar el backend: `PUT /api/extractos/clientes/:id/tarifario` ya reemplazaba el tarifario completo a partir de un arreglo `items` (ver §9), que es exactamente la forma que produce cualquiera de los dos caminos nuevos.

- **Tarifarios por defecto** (`TARIFARIOS_DEFECTO`): tres plantillas de ejemplo ("Corporativo estándar", "Aeropuerto / traslados", "Intermunicipal / turismo"), cada una con filas típicas (producto, tipo de vehículo, valores de referencia). Un `<select>` en la barra de herramientas de `TarifarioTabla` agrega las filas de la plantilla elegida al tarifario en edición (no lo reemplaza — se puede combinar con filas manuales o con más de una plantilla). Son un punto de partida editable, no un catálogo cerrado: el usuario ajusta valores/rutas después de cargarlas.
- **Carga desde Excel** (`parseTarifarioExcel`, usa `window.XLSX` — SheetJS, ya cargado globalmente vía `/vendor/xlsx.full.min.js` para las exportaciones de Producción): lee la primera hoja del archivo, mapea cada fila a `{tipoServicio, tipoVehiculo, descripcion, origen, destino, valorServicio, pagoAfiliado}` resolviendo "Tipo de servicio" y "Tipo de vehículo" contra los catálogos existentes (`PRODUCTOS_SERVICIO`, `CLASES_VEHICULO_COM`) por nombre, sin distinguir mayúsculas/tildes (`normalizarTxt`). Una fila cuyo tipo de servicio no se reconoce, o sin valor al cliente, se descarta y se reporta en un toast (no se importa con datos incorrectos) — las demás filas válidas sí se agregan. `descargarPlantillaTarifarioExcel` genera y descarga (también con SheetJS) un `.xlsx` de plantilla con las columnas esperadas y una fila de ejemplo, para que el flujo de ida y vuelta (descargar → llenar → volver a cargar) sea autoexplicativo.

`TarifarioTabla` ahora recibe también `toast` (antes no lo necesitaba) — se agregó en sus tres puntos de uso (`NuevoClienteComercialModal`, `ClienteComercialDetalleModal`, `ContratoDetalleModal`).

### 15.3 Portal Conductor (`/conductor`)

Pedido: una visual tipo conductor, con login propio, diseñada para celular, mostrando los servicios del día y programados — y que el conductor accione él mismo los cambios de estado de su servicio (aceptar/rechazar la asignación, marcar en ruta/en sitio/realizando/finalizado), con un nuevo estado "Rechazado" que alerte a la logística para reasignar.

**Autenticación, separada de la del personal PIG.** Los conductores no viven en `users` (esa tabla es solo para personal: admin/tramites/operaciones/comercial) — se les agregó `conductores.password_hash TEXT`, nullable. Mientras esté en `NULL`, ese conductor no puede iniciar sesión en el portal aunque esté `activo`. La cédula (ya `UNIQUE` en el esquema) hace de usuario. Un conductor no se autorregistra: Trámites u Operaciones activa/restablece su acceso desde la ficha del conductor en Flota → Conductores (nuevo botón "🔑 Activar Portal Conductor" / "🔑 Portal Conductor: Activo", que abre `ConductorPortalAccesoModal` y llama a `POST /api/conductores/:id/set-password`, protegido con `requireRole('admin','tramites','operaciones')`). La sesión del conductor usa una clave de sesión distinta (`req.session.conductorId`, nunca `req.session.userId`) — `requireConductor` la exige en cada endpoint del portal, y `actorNombre(req)` (usada por `agregarHistorial`) resuelve el nombre desde `conductores` cuando hay `conductorId` de sesión, para que el historial del servicio registre correctamente que fue el conductor quien hizo el cambio.

Endpoints nuevos en `server.js`:
- `POST /api/conductor-auth/login` `{cedula, password}` → verifica `activo=1` y `password_hash`, abre sesión.
- `POST /api/conductor-auth/logout`, `GET /api/conductor-auth/me`.
- `POST /api/conductores/:id/set-password` `{password}` (rol personal) — activa/restablece el acceso.
- `GET /api/conductor/servicios` (`requireConductor`) — servicios reales (`servicios.conductor_id = req.session.conductorId`), con el nombre del cliente ya resuelto (`LEFT JOIN contratos`) para no requerir que el conductor tenga acceso a `GET /api/contratos` (que exige sesión de personal).
- `PUT /api/conductor/servicios/:id/estado` (`requireConductor`) `{estado}` — valida que el servicio sea suyo (`conductor_id` coincide) y que la transición esté permitida por `ESTADO_TRANSICIONES_CONDUCTOR` (`Asignado→Aceptado|Rechazado`, `Aceptado→En Ruta`, `En Ruta→En Sitio`, `En Sitio→Realizando`, `Realizando→Finalizado`); cualquier otro salto se rechaza con 400. Actualiza el estado y registra en el historial ("El conductor rechazó el servicio" para el caso especial, o "Cambió estado a: X" para el resto).

`conductorConDetalle` (helper existente para `GET /api/conductores`) se ajustó para nunca devolver `password_hash` al personal y en cambio exponer un booleano `portalActivo`.

**Estado "Rechazado".** Se agregó como estado de excepción (junto a "Cancelado", fuera de `ESTADOS_SERVICIO_SECUENCIA`) en `ESTADOS_SERVICIO_TODOS`, con su propio color/badge. Solo se alcanza desde "Asignado", únicamente por acción del conductor. `AccionesMenu.puedeAsignar` ahora también es verdadero en estado "Rechazado" (antes solo en "Creado"), así que Operaciones reasigna conductor/vehículo con el mismo `AsignarServicioModal` de siempre (el botón se relabela "▶ Reasignar conductor y vehículo"); al confirmar, el servicio vuelve a "Asignado" igual que una asignación nueva. `Servicios` y `OperacionesTablero` muestran un banner rojo ("⚠ N servicio(s) rechazado(s) por el conductor — requieren reasignación") cuando hay alguno, clicable para filtrar directamente por ese estado — la forma de "alertar a la logística" dado que la plataforma no tiene infraestructura de notificaciones push; el conductor rechazado, la razón y el momento quedan además en el historial del servicio (ver §14.4).

**Doble camino mock/real, igual que el resto de Operaciones.** El Portal Conductor corre en la misma página (mismo bundle de React) que el resto de la plataforma, así que tiene acceso directo a `getServiciosStore()`/`updateServicio()`/`getContratosStore()` del lado del cliente. `cargarServiciosConductor(conductorId)` combina los servicios de demostración (`_serviciosStore`, filtrados por `conductorId`) con los reales (`GET /api/conductor/servicios`); cada servicio queda marcado con `_origen: 'mock'|'real'`. `avanzarEstadoConductor(s, nuevoEstado)` decide por ese campo: si es `'real'`, llama a `PUT /api/conductor/servicios/:id/estado`; si es `'mock'`, valida la transición contra `ESTADO_TRANSICIONES_CONDUCTOR` en el cliente (espejo exacto del backend) y llama a `updateServicio` — mismo patrón que `servicioApiBody`/mock-vs-real ya usado en `Servicios`/`OperacionesTablero` (ver §12).

**Ruteo.** `/conductor` (cualquier subruta) no pasa por `AuthGate` (el shell de personal): el IIFE final que monta React revisa `window.location.pathname` — igual que ya hacía para `/verificar/:token` (`VerificacionPublica`) — y monta `ConductorAuthGate` en su lugar. El catch-all `app.get('*', ...)` de `server.js` ya servía `index.html` para cualquier ruta no-API, así que no hizo falta tocar el backend para que `/conductor` cargue.

**UI.** `ConductorLoginScreen` (cédula + contraseña, tema oscuro consistente con `LoginScreen`/`HomeERP`) → `ConductorAuthGate` (verifica `/api/conductor-auth/me`, gestiona login/logout) → `ConductorApp`: cabecera fija con nombre del conductor y vehículo asignado, un banner si tiene servicios pendientes de aceptar/rechazar, y tres pestañas — **Hoy** (fecha de hoy, estados no terminales), **Programados** (otras fechas, no terminales) y **Historial** (`Finalizado`/`Liquidado`/`Liquidado Confirmado`/`Cancelado`/`Rechazado`, sin importar la fecha). Cada servicio es una tarjeta (`ConductorServicioCard`) con borde de color por estado; al tocarla abre `ConductorServicioDetalle` (reutiliza `Modal`, `RutaMapaGrafico` y `RutaMapaLink`) con la misma jerarquía de campos que el resto de la plataforma (cliente/fecha/hora/origen/destino/ventana de ruta/usuarios) y, al final, el botón de acción que corresponde al estado actual: "✓ Aceptar servicio" + "✕ Rechazar servicio" (con confirmación) cuando está "Asignado", o un único botón de avance ("🚗 Salir hacia el origen", "📍 Llegué al punto de origen", "▶ El usuario abordó — iniciar servicio", "🏁 Finalizar servicio") para los demás pasos — sin botones en los estados terminales. El layout es de una sola columna, ancho máximo centrado, tarjetas grandes y botones de altura generosa, pensado primero para pantalla de celular.

## 18. Liquidación → Aprobaciones → Contabilidad: el flujo real de pago

Pedido: que "Liquidación" muestre solo servicios en estado `Liquidado`, que Operaciones pueda enviar
una "orden de aprobación" filtrada por cliente y rango de fechas con indicadores financieros
(global y por servicio), que un nuevo rol Director de Operaciones apruebe o devuelva esa orden
(completa o servicio por servicio), que lo aprobado genere una orden de pago para un nuevo módulo
Contabilidad con V°B° de un nuevo rol Gerente, y que Contabilidad pueda descargar un archivo plano
una vez autorizado. Devolver un servicio puntual (por Dirección o por Gerencia) no descarta el resto
de la orden — sigue su curso solo con lo aprobado — y la devolución debe llegar de vuelta a la
logística que envió la orden.

### 18.1 Por qué las órdenes son un snapshot, no una referencia viva

La mayoría de los servicios de esta plataforma solo existen en el store de demostración del
navegador (`_serviciosStore`, ver §13.3) — nunca tocan la tabla `servicios` de esta base de datos.
Pero el flujo de aprobación es multi-rol y multi-sesión (Operaciones envía, Director aprueba días
después, Gerencia después de eso) — tiene que vivir en el servidor, no en memoria del navegador.
La solución: `orden_aprobacion_items.snapshot` guarda una copia JSON completa de cada servicio en el
momento de enviar la orden (fecha, hora, origen, destino, valor cobrado al cliente, valor a pagar al
proveedor, tipo y nombre del proveedor, margen) — el frontend arma ese snapshot con los mismos datos
que ya tiene cargados (mock + reales, igual que en `Servicios`/`OperacionesTablero`, ver §12), y una
vez enviado el snapshot es la única fuente de verdad: la orden ya no depende de que el servicio siga
existiendo o sin cambios en el store del navegador. `servicio_id` se guarda solo como referencia
informativa (sin FK — puede ser un id `s001`/`sd0001` del store mock, que no existe en esta base de
datos), igual que `ordenes_aprobacion.contrato_id`.

### 18.2 Categoría de vehículo "Aliado" y los tres tipos de proveedor

`vehiculos.tipo` tenía solo `Propio`/`Afiliado`; se agregó `Aliado` como una tercera categoría (los
tres `<option>` de tipo de vehículo, en los dos formularios de Vehículos) para poder discriminar el
pago exactamente como se pidió: **Propio** (flota de la empresa), **Aliado** (flota de un tercero
subcontratado) y **Afiliado** (vehículo vinculado bajo el permiso de operación de la empresa, dueño
independiente). `resolverProveedorVehiculo(vehiculo)` (junto a `LiquidacionServicios`) resuelve el
tipo y el nombre/documento del beneficiario del pago (`vehiculo.propietario_nombre`/
`propietario_documento`, ya existentes en el esquema) — si el servicio no tiene vehículo asignado,
cae a `Afiliado` con "Sin vehículo asignado" para no romper el cálculo.

### 18.3 Indicadores financieros

`calcularIndicadoresLiquidacion(items)` (compartida entre `LiquidacionServicios` y las vistas de
Director/Gerencia) es la única fuente de verdad para los indicadores, calculada tanto sobre los
servicios filtrados (antes de enviar, en Liquidación) como sobre el snapshot ya guardado de una
orden (en las vistas de revisión) — mismos números en todos los puntos del flujo:
- **Total a facturar al cliente**: suma de `valorCliente` (el `s.valor` del servicio).
- **Total a pagar a Propios/Aliados/Afiliados**: suma de `valorProveedor` (`s.liquidacion.valorAPagar`,
  cargado en `LiquidarServicioModal`, ver §15) agrupado por el tipo de proveedor del vehículo.
- **% de uso por tipo de vehículo**: proporción de servicios (no de valor) cubiertos por cada tipo —
  qué tanto se apoya la operación en cada categoría de proveedor.
- **Margen (global y por servicio)**: `(valorCliente − valorProveedor) / valorCliente × 100`. El
  componente `MargenValor` lo pinta en rojo (`var(--red)`) cuando es menor a 20%, en el color normal
  en caso contrario — igual en la tarjeta resumen de Liquidación, en la tabla por servicio, y en el
  detalle que ven Director y Gerencia, para que el indicador se vea "rápido y discriminado" en todos
  los niveles como se pidió.

### 18.4 Máquina de estados: orden de aprobación → orden de pago

Cada ítem (`orden_aprobacion_items.estado`) pasa por hasta cuatro estados: `Pendiente` (recién
enviado, esperando a Director) → `Aprobado` (Director lo aprobó — entra a la orden de pago) →
`Autorizado` (Gerencia dio V°B° — listo para el archivo plano) — o `Devuelto` en cualquiera de las
dos revisiones, con `devuelto_por`/`devuelto_etapa` (`'Director'`|`'Gerencia'`) y
`motivo_devolucion`. La orden (`ordenes_aprobacion.estado`) se deriva sola cuando ya no quedan ítems
`Pendiente`: `Revisada` si al menos uno quedó `Aprobado`, `Devuelta` si todos se devolvieron.

`PUT /api/liquidacion/ordenes/:id/decidir` (rol `director_operaciones`/`admin`) recibe
`{aprobarItems: [ids], devolverItems: [{id, motivo}]}` — puede ser parcial (Director puede decidir
por tandas, los ítems no mencionados quedan `Pendiente` para una próxima revisión). En cuanto hay al
menos un ítem `Aprobado` y todavía no existe una orden de pago para esa orden de aprobación, el mismo
endpoint crea una (`ordenes_pago`, estado inicial `'Pdte. V°B° Gerencia'`) — no hay una tabla de
ítems de pago aparte: los ítems de una orden de pago son simplemente los `orden_aprobacion_items` de
su `orden_aprobacion_id` con estado `Aprobado`/`Autorizado`/`Devuelto` (`ordenPagoConItems` en
`server.js`), así que no hay que duplicar el snapshot.

`PUT /api/contabilidad/ordenes-pago/:id/decidir` (rol `gerente`/`admin`) recibe solo
`{devolverItems: [{id, motivo}]}` — los que se devuelven quedan `Devuelto` (etapa `'Gerencia'`); el
resto de los ítems `Aprobado` de esa orden de pago se marcan `Autorizado` de una vez. Esto refleja
la mecánica pedida: Gerencia decide qué NO autorizar, y con eso ya termina de decidir toda la orden
en un solo paso (no hace falta marcar uno por uno los que sí se aprueban).

### 18.5 Alertar a la logística sin infraestructura de notificaciones

Igual que con los servicios rechazados por el conductor (§14.8/§15.3), no hay push notifications —
`LiquidacionServicios` muestra un banner rojo ("⚠ N orden(es) con servicios devueltos por Dirección o
Gerencia") cuando alguna de sus órdenes tiene ítems `Devuelto`, y la tabla de "Órdenes de aprobación
enviadas" siempre está visible con el estado y el conteo de devoluciones de cada una — para corregir,
la logística edita la liquidación del servicio devuelto (`LiquidarServicioModal`) y lo vuelve a
incluir en una nueva orden (la orden original no se reenvía ni se edita: cada envío es un snapshot
nuevo e independiente).

### 18.6 Nuevos módulos y roles

`users.rol` gana `director_operaciones` y `gerente` (usuarios de ejemplo:
`director@multimodalgroup.com` / `director123` y `gerente@multimodalgroup.com` / `gerente123`, junto
al `admin` existente). Dos tiles nuevos en `HomeERP` — **Aprobaciones** (`AprobacionesApp` →
`AprobacionesDirector`) y **Contabilidad** (`ContabilidadApp` → `ContabilidadGerencia`) — con el
mismo patrón de shell que `ComercialApp` (sidebar mínima + `topMod` en `App()`). A diferencia de
Flota/Operaciones/Comercial (visibles para cualquiera, sin gating), estos dos tiles se ocultan para
quien no tiene el rol correspondiente (o `admin`) en vez de mostrarse y bloquear la acción adentro —
son de un solo rol y no tendría sentido que el resto del personal aterrizara ahí. `Contabilidad`
también sirve como el punto donde, una vez `Aprobada` una orden de pago, se descarga el archivo
plano — no se creó un rol "contable" aparte porque el pedido no distinguía esa función de Gerencia;
`admin` cubre el caso de alguien de soporte necesitando descargarlo.

### 18.7 Archivo plano de pago

`descargarArchivoPlano` (en `OrdenPagoDetalleModal`, solo visible cuando la orden de pago está
`Aprobada`) agrupa los ítems `Autorizado` por beneficiario (tipo + nombre + documento del
propietario) y genera un `.txt` delimitado por `|` (`TIPO|DOCUMENTO|BENEFICIARIO|N_SERVICIOS|VALOR_A_PAGAR`,
una fila por beneficiario) vía un `Blob` descargado directamente en el navegador — sin endpoint
nuevo en el backend, ya que toda la información ya está cargada en el detalle que ve Gerencia/Contabilidad.

## 19. Calendario del conductor, edición/bloqueo de la liquidación, relación de cobro sin datos internos y detalle completo para Director/Gerencia

### 19.1 Calendario del Portal Conductor

Pedido: que el conductor vea sus servicios (asignados o ya hechos) en un calendario mensual, y que
tocar un día lo lleve a la agenda de ese día. `ConductorApp` gana una cuarta pestaña, **Calendario**
— `ConductorCalendarioMes` dibuja una grilla de 7 columnas del mes en curso (con navegación ‹/›),
donde cada día que tiene al menos un servicio (`porFecha[fechaISO]`, agrupando `list` completa —
cualquier estado, no solo los activos) se resalta y muestra un contador; el día de hoy lleva un
borde ámbar. Tocar un día llama a `onDiaClick(fechaISO)`, que cambia a `ConductorAgendaDia`: la
misma tarjeta (`ConductorServicioCard`) que usan Hoy/Programados/Historial, filtrada a esa fecha y
ordenada por hora, con un botón "← Volver al calendario". Cambiar de pestaña (`cambiarTab`) limpia
el día seleccionado para no quedar atrapado en la agenda al volver a Calendario.

### 19.2 Edición de la liquidación desde el módulo, bloqueada mientras está en una orden activa

Antes, la única forma de editar `s.liquidacion` era `LiquidarServicioModal` desde Servicios/Tablero.
Pedido: que la logística también pueda editarla directamente desde Liquidación (donde ya filtró los
servicios liquidados por cliente y rango), pero que deje de poder hacerlo — ni el servicio ni la
liquidación — en cuanto la orden de aprobación ya se envió, salvo que Dirección devuelva ese
servicio puntual.

- **Editar**: cada fila de "Servicios liquidados por enviar" tiene un botón "✎" que abre
  `LiquidarServicioModal` con el servicio original (`x.servicio`, no el snapshot calculado);
  `handleGuardarLiquidacion` guarda por el mismo camino mock-vs-real que el resto del módulo
  (`updateServicio` o `PUT /api/servicios/:id`, según si el contrato es de Comercial).
- **Bloqueo**: nuevo `GET /api/liquidacion/servicios-en-ordenes` devuelve, para todo
  `orden_aprobacion_items` con `estado != 'Devuelto'` (es decir, `Pendiente`/`Aprobado`/`Autorizado`
  — cualquier ítem todavía "vivo" en una orden), su `servicio_id` y en qué orden/estado está.
  `LiquidacionServicios` separa los servicios liquidados filtrados en `enviables` (sin bloqueo — se
  pueden editar y son los que se envían) y `yaEnviados` (con bloqueo — de solo lectura, en una tabla
  aparte que muestra en qué orden están y su estado, con la nota de que Dirección tiene que
  devolverlos para poder tocarlos de nuevo). Los indicadores globales y el botón de envío usan
  únicamente `enviables` — un servicio que ya está en una orden activa no puede volver a incluirse en
  una nueva mientras siga así, evitando enviarlo dos veces.
- Cuando Dirección devuelve un ítem (`devolverItems` en `PUT /api/liquidacion/ordenes/:id/decidir`),
  su `orden_aprobacion_items.estado` pasa a `Devuelto` y por lo tanto sale de
  `/servicios-en-ordenes` — el servicio reaparece automáticamente en "Servicios liquidados por
  enviar" la próxima vez que la logística recargue el módulo, listo para editar y reenviar en una
  orden nueva.

### 19.3 La relación de cobro al cliente ya no expone datos internos

El Excel que genera `LiquidacionServicios` para enviarle al cliente (`filaExcel`/`generarExcel`)
tenía "Valor a pagar al proveedor" y "Margen (%)" — información puramente interna de rentabilidad
que no le corresponde ver al cliente. Se quitaron esas dos columnas (y también "Tipo de proveedor"/
"Proveedor", que ya no aplican sin el contexto del margen); la hoja de detalle del Excel del cliente
ahora solo trae identificación del servicio, ruta, vehículo/conductor y el valor a facturar. Los
indicadores internos (pago a proveedor, márgenes) se siguen viendo en la pantalla de Liquidación y en
las vistas de Director/Gerencia — nunca en lo que sale hacia el cliente.

### 19.4 Detalle completo de un servicio para Director y Gerencia

Pedido: que Director y Gerente puedan hacer clic sobre un servicio, dentro de la orden que están
revisando, para ver toda su información — no solo la fila resumida de la tabla.
`ItemLiquidacionDetalleModal` (nuevo, compartido entre `OrdenAprobacionDetalleModal` y
`OrdenPagoDetalleModal`) reconstruye la misma jerarquía compacta de `VerServicioModal` (cliente,
fecha, hora, origen, destino, ventana de ruta, referencia, anotaciones, usuarios, ventana gráfica de
la ruta, vehículo/conductor, valores y margen, más el motivo de devolución si lo tiene) — pero
leyendo únicamente el `snapshot` que ya viaja en el ítem de la orden, no el store en vivo del
navegador (ver §18.1: el servicio de origen puede ser de la demo o haber cambiado desde que se
envió). Cada fila de ambas tablas ganó una primera columna con un botón "👁" que abre este modal; para
que el snapshot alcance a mostrar todo eso, `construirItem` (en `LiquidacionServicios`) se amplió más
allá de los campos que ya usaban los indicadores — ahora también guarda `origenGeo`/`destinoGeo`/
`paradas` (para el mapa), `ventanaRuta`, `referencia`, `obs`, `pax`, `usuarios`, y
`tarifaConfirmada`/`novedadesLiquidacion` de la liquidación — todo lo que se necesita para que el
detalle sea realmente completo y no una versión reducida.
