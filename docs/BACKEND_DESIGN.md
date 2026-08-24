# Diseño del backend/API real — PIG Trámites y Operaciones

Estado: **API fase 1 implementada** (auth + flota + trámites + afiliación) y **frontend conectado para Auth, Vehículos, Conductores y Cartera** (probado con dos sesiones/computadores simulados: un cambio hecho en uno aparece en el otro sin recargar código, solo la página). El submódulo **Extractos (FUEC)** está completo end-to-end (backend + frontend + probado) — ver §8. El módulo **Comercial** (alta de clientes corporativos con contrato + tarifario, con flujo de verificación hacia Trámites) también está completo end-to-end — ver §9. Este documento describe la arquitectura, el modelo de datos, el contrato de la API y el plan para terminar de conectar el resto del frontend.

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
