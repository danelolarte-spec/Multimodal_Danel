const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- ───────────────────────── AUTENTICACIÓN ─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'tramites', -- admin | tramites | operaciones | comercial | director_operaciones | gerente
  activo INTEGER NOT NULL DEFAULT 1,
  firma_url TEXT, -- firma electrónica del usuario (imagen data: URL, dibujada en un canvas)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────── FLOTA ─────────────────────────
CREATE TABLE IF NOT EXISTS vehiculos (
  id TEXT PRIMARY KEY,
  placa TEXT NOT NULL UNIQUE,
  clase TEXT, marca TEXT, linea TEXT, modelo INTEGER,
  motor TEXT, chasis TEXT, vin TEXT, color TEXT,
  capacidad INTEGER, combustible TEXT,
  tipo TEXT, -- Afiliado | Propio
  interno TEXT, estado TEXT NOT NULL DEFAULT 'Activo',
  propietario_nombre TEXT, propietario_documento TEXT,
  propietario_telefono TEXT, propietario_email TEXT,
  fecha_vin TEXT,
  convenio_cliente TEXT, convenio_vigencia TEXT, convenio_estado TEXT,
  log_habilitacion TEXT NOT NULL DEFAULT '[]', -- JSON: historial de habilitar/deshabilitar
  numero_tarjeta_operacion TEXT, -- requerido en el FUEC (Art. 3.10, Resolución 6652/2019)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Documentos con vencimiento, compartidos entre vehículos y conductores
-- (SOAT/RTM/T.O./póliza RC del vehículo; licencia/seg.social/exámenes del conductor)
CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad_tipo TEXT NOT NULL, -- 'vehiculo' | 'conductor'
  entidad_id TEXT NOT NULL,
  doc_tipo TEXT NOT NULL, -- soat | rtm | to | polizaRC | licencia | segSocial | examenMedico | mantDefensivo | antecedentes | cedula | habeasData
  vencimiento TEXT,
  estado TEXT NOT NULL DEFAULT 'PENDIENTE', -- VIGENTE | PROXIMO | VENCIDO | PENDIENTE
  archivo_url TEXT, archivo_nombre TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entidad_tipo, entidad_id, doc_tipo)
);
CREATE INDEX IF NOT EXISTS idx_documentos_entidad ON documentos(entidad_tipo, entidad_id);
CREATE INDEX IF NOT EXISTS idx_documentos_estado ON documentos(estado);

CREATE TABLE IF NOT EXISTS conductores (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL, cedula TEXT NOT NULL UNIQUE,
  telefono TEXT, email TEXT, licencia TEXT, venc_licencia TEXT,
  vehiculo_id TEXT REFERENCES vehiculos(id) ON DELETE SET NULL,
  tipo TEXT, eps TEXT, arl TEXT, pensiones TEXT,
  activo INTEGER NOT NULL DEFAULT 1, fecha_vin TEXT, foto_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conductor_seg_social_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conductor_id TEXT NOT NULL REFERENCES conductores(id) ON DELETE CASCADE,
  mes TEXT, fecha TEXT, estado TEXT, archivo_url TEXT, archivo_nombre TEXT,
  UNIQUE(conductor_id, mes)
);

-- ───────────────────────── CARTERA ─────────────────────────
CREATE TABLE IF NOT EXISTS cartera (
  vehiculo_id TEXT PRIMARY KEY REFERENCES vehiculos(id) ON DELETE CASCADE,
  saldo INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'AL_DIA', -- AL_DIA | PROXIMO | MORA_MODERADA | MORA_CRITICA
  ultimo_pago TEXT,
  restriccion TEXT, -- calculada o manual
  restriccion_manual INTEGER NOT NULL DEFAULT 0,
  restriccion_historial TEXT NOT NULL DEFAULT '[]' -- JSON: historial de cambios manuales
);

CREATE TABLE IF NOT EXISTS cartera_pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehiculo_id TEXT NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL, valor INTEGER NOT NULL, obs TEXT,
  comprobante_url TEXT, comprobante_nombre TEXT, registrado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────── INFRACCIONES (VIGÍA) ─────────────────────────
CREATE TABLE IF NOT EXISTS infracciones (
  id TEXT PRIMARY KEY,
  vehiculo_id TEXT REFERENCES vehiculos(id) ON DELETE SET NULL,
  conductor_id TEXT REFERENCES conductores(id) ON DELETE SET NULL,
  comparendo TEXT, tipo TEXT, codigo TEXT, fecha TEXT, secretaria TEXT,
  valor INTEGER, valor_a_pagar INTEGER,
  estado TEXT NOT NULL DEFAULT 'PENDIENTE', -- PENDIENTE | CONDUCTOR_NOTIFICADO | CERRADO
  recurrente INTEGER NOT NULL DEFAULT 0, dias INTEGER,
  semaforo TEXT, -- VERDE | AMARILLO | NEGRO | CERRADO
  metodo_cierre TEXT, obs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────── PÓLIZAS Y SINIESTROS ─────────────────────────
CREATE TABLE IF NOT EXISTS polizas (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL, aseguradora TEXT, num TEXT,
  desde TEXT, hasta TEXT, valor INTEGER, cuotas INTEGER, cuota INTEGER,
  cobertura TEXT, intermediario TEXT, estado TEXT NOT NULL DEFAULT 'VIGENTE',
  asesor_nombre TEXT, asesor_telefono TEXT, asesor_email TEXT,
  asistencia_telefono TEXT, asistencia_desc TEXT, caratula_url TEXT
);

CREATE TABLE IF NOT EXISTS poliza_vehiculos (
  poliza_id TEXT NOT NULL REFERENCES polizas(id) ON DELETE CASCADE,
  vehiculo_id TEXT NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
  PRIMARY KEY (poliza_id, vehiculo_id)
);

CREATE TABLE IF NOT EXISTS reclamaciones (
  id TEXT PRIMARY KEY,
  vehiculo_id TEXT REFERENCES vehiculos(id) ON DELETE SET NULL,
  poliza_id TEXT REFERENCES polizas(id) ON DELETE SET NULL,
  tipo TEXT, fecha_siniestro TEXT, fecha_reporte TEXT,
  estado TEXT NOT NULL DEFAULT 'REPORTADO',
  descripcion TEXT, valor_estimado INTEGER, valor_indemnizado INTEGER,
  deducible INTEGER, radicado_aseguradora TEXT
);

CREATE TABLE IF NOT EXISTS reclamacion_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reclamacion_id TEXT NOT NULL REFERENCES reclamaciones(id) ON DELETE CASCADE,
  fecha TEXT, hora TEXT, usuario TEXT, accion TEXT, tipo TEXT, nota TEXT
);

-- ───────────────────────── CONVENIOS ─────────────────────────
CREATE TABLE IF NOT EXISTS convenios (
  id TEXT PRIMARY KEY,
  cliente TEXT NOT NULL, nit TEXT, contacto TEXT, telefono TEXT, email TEXT,
  tipo TEXT, fecha_inicio TEXT, fecha_fin TEXT, valor INTEGER,
  estado TEXT NOT NULL DEFAULT 'VIGENTE', obs TEXT,
  origen TEXT, destino TEXT, archivo_url TEXT
);

CREATE TABLE IF NOT EXISTS convenio_vehiculos (
  convenio_id TEXT NOT NULL REFERENCES convenios(id) ON DELETE CASCADE,
  vehiculo_id TEXT NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
  PRIMARY KEY (convenio_id, vehiculo_id)
);

-- ───────────────────────── LEASING Y PRENDAS ─────────────────────────
CREATE TABLE IF NOT EXISTS leasings (
  id TEXT PRIMARY KEY,
  vehiculo_id TEXT REFERENCES vehiculos(id) ON DELETE SET NULL,
  tipo TEXT, entidad TEXT, contacto TEXT, telefono TEXT,
  cuota_mensual INTEGER, fecha_inicio TEXT, fecha_fin TEXT,
  saldo_pendiente INTEGER, estado TEXT NOT NULL DEFAULT 'ACTIVO',
  obs TEXT, archivo_url TEXT
);

CREATE TABLE IF NOT EXISTS leasing_pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leasing_id TEXT NOT NULL REFERENCES leasings(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL, valor INTEGER NOT NULL, obs TEXT
);

-- ───────────────────────── RENOVACIONES MENSUALES ─────────────────────────
CREATE TABLE IF NOT EXISTS docs_mensuales (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL, periodicidad TEXT, vence TEXT,
  estado TEXT NOT NULL DEFAULT 'PENDIENTE', descripcion TEXT,
  responsable TEXT, activo INTEGER NOT NULL DEFAULT 1
);

-- ───────────────────────── CAJA MENOR ─────────────────────────
CREATE TABLE IF NOT EXISTS caja_menor (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL, entidad TEXT, asunto TEXT,
  vehiculo_id TEXT REFERENCES vehiculos(id) ON DELETE SET NULL, vehiculo_placa TEXT,
  valor INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'EN_GESTION',
  detalle TEXT, solicitado_por TEXT, autorizado_por TEXT,
  categoria TEXT, comprobante_url TEXT
);

-- ───────────────────────── GESTIÓN DE TRÁMITES ─────────────────────────
-- Tipos de trámite configurables desde el diseñador (Configuraciones Avanzadas)
CREATE TABLE IF NOT EXISTS tipos_tramite (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL, grupo TEXT, icono TEXT,
  etapas TEXT NOT NULL DEFAULT '[]', -- JSON array de nombres de etapa, en orden
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tramites (
  id TEXT PRIMARY KEY,
  tipo_tramite_id TEXT REFERENCES tipos_tramite(id) ON DELETE SET NULL,
  vehiculo_id TEXT REFERENCES vehiculos(id) ON DELETE SET NULL,
  conductor_id TEXT REFERENCES conductores(id) ON DELETE SET NULL,
  estado TEXT NOT NULL DEFAULT 'EN_PROCESO', -- EN_PROCESO | FINALIZADO | CANCELADO
  fecha_inicio TEXT, fecha_cierre TEXT, etapa INTEGER NOT NULL DEFAULT 1,
  obs TEXT, radicado_num TEXT, radicado_fecha TEXT, radicado_dias INTEGER
);

CREATE TABLE IF NOT EXISTS tramite_costos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tramite_id TEXT NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
  concepto TEXT NOT NULL, valor INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tramite_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tramite_id TEXT NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
  fecha TEXT, hora TEXT, usuario TEXT, accion TEXT, tipo TEXT, nota TEXT
);

-- ───────────────────────── PORTAL DE AFILIACIÓN / SOLICITUDES ─────────────────────────
CREATE TABLE IF NOT EXISTS documentos_solicitud_config (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL, tip TEXT, tipo TEXT DEFAULT 'doc',
  obligatorio INTEGER NOT NULL DEFAULT 1, orden INTEGER NOT NULL DEFAULT 0,
  contexto TEXT NOT NULL DEFAULT 'vinculacion' -- 'vinculacion' | 'portal_cambio_vehiculo'
);

CREATE TABLE IF NOT EXISTS solicitudes_afiliacion (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'RECIBIDO',
  nombre TEXT NOT NULL, cedula TEXT, telefono TEXT, email TEXT, ciudad TEXT,
  placa TEXT, clase TEXT, marca TEXT, linea TEXT, modelo INTEGER, color TEXT,
  capacidad INTEGER, combustible TEXT,
  es_nuevo INTEGER NOT NULL DEFAULT 0, icbf_trabaja INTEGER NOT NULL DEFAULT 0,
  tiene_convenio INTEGER NOT NULL DEFAULT 0, cliente_convenio TEXT,
  observaciones TEXT, etapa TEXT, radicado TEXT,
  cotizacion_admin INTEGER, cotizacion_poliza_rc INTEGER, cotizacion_icbf INTEGER, cotizacion_total INTEGER,
  puntaje INTEGER, asignado_a TEXT, motivo_rechazo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS solicitud_docs_confirmados (
  solicitud_id TEXT NOT NULL REFERENCES solicitudes_afiliacion(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL, confirmado INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (solicitud_id, doc_id)
);

CREATE TABLE IF NOT EXISTS solicitud_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id TEXT NOT NULL REFERENCES solicitudes_afiliacion(id) ON DELETE CASCADE,
  fecha TEXT, accion TEXT, usuario TEXT
);

-- ───────────────────────── OPERACIONES: CONTRATOS Y SERVICIOS ─────────────────────────
CREATE TABLE IF NOT EXISTS contratos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL, nit TEXT, tipo TEXT, estado TEXT NOT NULL DEFAULT 'Activo',
  valor INTEGER, logistico_nombre TEXT
);

CREATE TABLE IF NOT EXISTS contrato_productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contrato_id TEXT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  producto TEXT NOT NULL, tarifa INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contrato_conductores (
  contrato_id TEXT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  conductor_id TEXT NOT NULL REFERENCES conductores(id) ON DELETE CASCADE,
  PRIMARY KEY (contrato_id, conductor_id)
);

CREATE TABLE IF NOT EXISTS contrato_campos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contrato_id TEXT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL, tipo TEXT NOT NULL, req INTEGER NOT NULL DEFAULT 0,
  opciones TEXT, orden INTEGER NOT NULL DEFAULT 0 -- opciones: JSON array
);

CREATE TABLE IF NOT EXISTS servicios (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL, hora TEXT,
  contrato_id TEXT REFERENCES contratos(id) ON DELETE SET NULL,
  producto TEXT,
  vehiculo_id TEXT REFERENCES vehiculos(id) ON DELETE SET NULL,
  conductor_id TEXT REFERENCES conductores(id) ON DELETE SET NULL,
  origen TEXT, destino TEXT, origen_geo TEXT, destino_geo TEXT, -- geo: JSON {lat,lng}
  estado TEXT NOT NULL DEFAULT 'Pendiente', -- Pendiente | Asignado | En Curso | Finalizado | Cancelado | Liquidado
  valor INTEGER, pax INTEGER, obs TEXT,
  campos TEXT, -- JSON: respuestas a los campos personalizados del cliente (contrato_campos)
  liquidacion TEXT, -- JSON: {tarifaConfirmada, novedades, valorAPagar, pagarA, terceroNombre, fecha}
  extracto_id TEXT REFERENCES extractos(id) -- extracto generado para este servicio puntual, si aplica
);

-- ───────────────────────── EXTRACTOS (FUEC — Resolución 6652 de 2019, Mintransporte) ─────────────────────────
-- Configuración de la empresa para construir el número del FUEC (Art. 4 de la resolución):
-- código territorial (3) + número de resolución de habilitación (4) + año de habilitación (2)
CREATE TABLE IF NOT EXISTS extracto_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  codigo_territorial TEXT NOT NULL DEFAULT '305',
  numero_resolucion_habilitacion TEXT NOT NULL DEFAULT '0010',
  anio_habilitacion TEXT NOT NULL DEFAULT '13',
  tolerancia_mant_defensivo_dias INTEGER NOT NULL DEFAULT 10
);

-- Clientes para efectos de extractos (distinto de "convenios": aquí se modela el flujo de
-- contrato-con-firma que describe el proceso, y las banderas ICBF/corporativo que restringen
-- quién puede crear extractos para ese cliente).
CREATE TABLE IF NOT EXISTS extracto_clientes (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL, documento TEXT, direccion TEXT, telefono TEXT, email TEXT,
  es_icbf INTEGER NOT NULL DEFAULT 0,
  es_corporativo INTEGER NOT NULL DEFAULT 0,
  formulario_disenado INTEGER NOT NULL DEFAULT 0, -- Operaciones ya diseñó los campos del formulario de servicios de este cliente
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Contratos con cada cliente. Flujo: PENDIENTE_FIRMA -> PENDIENTE_VALIDACION -> APROBADO | DEVUELTO | RECHAZADO.
CREATE TABLE IF NOT EXISTS extracto_contratos (
  id TEXT PRIMARY KEY,
  numero INTEGER NOT NULL UNIQUE, -- consecutivo de contrato de la empresa (4 dígitos en el FUEC)
  cliente_id TEXT NOT NULL REFERENCES extracto_clientes(id) ON DELETE CASCADE,
  modalidad TEXT NOT NULL, -- GRUPO_ESPECIFICO | TURISTICA | EMPRESARIAL | DISPOSICION_TOTAL
  objeto TEXT, origen TEXT, destino TEXT,
  fecha_inicio TEXT, fecha_fin TEXT, -- vigencia del contrato: nunca > 1 año (validado en la API)
  requiere_convenio INTEGER NOT NULL DEFAULT 0,
  convenio_colaboracion TEXT, -- nombre/descr. del convenio de colaboración empresarial, si aplica
  estado TEXT NOT NULL DEFAULT 'PENDIENTE_FIRMA',
  archivo_firmado_url TEXT,
  motivo_devolucion TEXT,
  creado_por TEXT, validado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_extracto_contratos_cliente ON extracto_contratos(cliente_id);

CREATE TABLE IF NOT EXISTS extracto_contrato_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contrato_id TEXT NOT NULL REFERENCES extracto_contratos(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL DEFAULT (datetime('now')), usuario TEXT, accion TEXT, nota TEXT,
  firma_url TEXT -- firma electrónica del usuario en el momento de la acción (si tenía una guardada)
);

-- Extractos generados (instancias del FUEC). Inmutables una vez creados (solo cambia estado por vencimiento/anulación).
CREATE TABLE IF NOT EXISTS extractos (
  id TEXT PRIMARY KEY,
  numero_fuec TEXT NOT NULL UNIQUE, -- 21 dígitos, Art. 4 de la resolución
  contrato_id TEXT NOT NULL REFERENCES extracto_contratos(id),
  vehiculo_id TEXT NOT NULL REFERENCES vehiculos(id),
  tarifario_item_id INTEGER REFERENCES tarifario_items(id), -- ruta/servicio tarifado usado (copiado a origen/destino abajo)
  origen TEXT, destino TEXT,
  fecha_inicio TEXT NOT NULL, fecha_fin TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'VIGENTE', -- VIGENTE | VENCIDO | ANULADO
  generado_por_tipo TEXT NOT NULL DEFAULT 'EMPRESA', -- AFILIADO | EMPRESA
  generado_por TEXT,
  declaracion_aceptada_en TEXT,
  duplicado_de_id TEXT REFERENCES extractos(id),
  qr_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_extractos_contrato ON extractos(contrato_id);
CREATE INDEX IF NOT EXISTS idx_extractos_vehiculo ON extractos(vehiculo_id);

CREATE TABLE IF NOT EXISTS extracto_conductores (
  extracto_id TEXT NOT NULL REFERENCES extractos(id) ON DELETE CASCADE,
  conductor_id TEXT NOT NULL REFERENCES conductores(id),
  orden INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (extracto_id, conductor_id)
);

CREATE TABLE IF NOT EXISTS extracto_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  extracto_id TEXT NOT NULL REFERENCES extractos(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL DEFAULT (datetime('now')), usuario TEXT, accion TEXT, nota TEXT
);

-- Tarifario comercial: tarifa aplicable a un cliente por tipo de servicio + tipo de vehículo
-- (y opcionalmente origen/destino), con el valor cobrado al cliente y lo que se le paga al
-- afiliado/convenio por ese servicio. Lo crea y mantiene el módulo Comercial — es la única fuente
-- de rutas/servicios del cliente: no hay límite de filas, y el contrato no restringe cuáles aplican.
-- Operaciones lo consume tal cual para generar servicios, y Trámites para generar extractos.
CREATE TABLE IF NOT EXISTS tarifario_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id TEXT NOT NULL REFERENCES extracto_clientes(id) ON DELETE CASCADE,
  tipo_servicio TEXT NOT NULL,
  tipo_vehiculo TEXT NOT NULL,
  descripcion TEXT,
  origen TEXT, destino TEXT,
  valor_servicio INTEGER NOT NULL DEFAULT 0,
  pago_afiliado INTEGER NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tarifario_cliente ON tarifario_items(cliente_id);

-- ───────────────────── LIQUIDACIÓN: órdenes de aprobación y de pago ─────────────────────
-- Flujo: Operaciones (logística) filtra servicios en estado "Liquidado" por cliente y rango de
-- fechas y envía una orden de aprobación. Cada servicio incluido queda "congelado" como una fila
-- en orden_aprobacion_items (snapshot en JSON — el servicio de origen puede ser real (tabla
-- servicios) o de la demo en memoria del frontend, así que no hay FK a servicios.id, ver
-- BACKEND_DESIGN.md §16). Director de Operaciones aprueba o devuelve la orden completa o ítems
-- puntuales; por cada ítem que aprueba se genera (o se suma a) una orden de pago para Contabilidad,
-- que Gerencia debe autorizar (V°B°) antes de poder descargar los archivos planos de pago.
CREATE TABLE IF NOT EXISTS ordenes_aprobacion (
  id TEXT PRIMARY KEY,
  numero TEXT NOT NULL,
  contrato_id TEXT, -- informativo, sin FK: el contrato puede ser de la demo en memoria del frontend, no de esta base de datos
  cliente_nombre TEXT NOT NULL,
  fecha_desde TEXT NOT NULL, fecha_hasta TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'Enviada', -- Enviada | Revisada | Devuelta
  totales TEXT, -- JSON: snapshot de los indicadores globales calculados al momento de enviar
  creado_por TEXT, creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  revisado_por TEXT, revisado_en TEXT
);
CREATE TABLE IF NOT EXISTS orden_aprobacion_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orden_id TEXT NOT NULL REFERENCES ordenes_aprobacion(id) ON DELETE CASCADE,
  servicio_id TEXT NOT NULL,
  servicio_numero TEXT,
  snapshot TEXT NOT NULL, -- JSON: fecha, hora, origen, destino, producto, valorCliente, valorProveedor, proveedorTipo, proveedorNombre, vehiculoPlaca, conductorNombre, margenPct
  estado TEXT NOT NULL DEFAULT 'Pendiente', -- Pendiente | Aprobado | Devuelto | Pagado
  devuelto_por TEXT, devuelto_etapa TEXT, motivo_devolucion TEXT
);
CREATE INDEX IF NOT EXISTS idx_orden_aprobacion_items_orden ON orden_aprobacion_items(orden_id);

CREATE TABLE IF NOT EXISTS ordenes_pago (
  id TEXT PRIMARY KEY,
  numero TEXT NOT NULL,
  orden_aprobacion_id TEXT NOT NULL REFERENCES ordenes_aprobacion(id),
  estado TEXT NOT NULL DEFAULT 'Pdte. V°B° Gerencia', -- Pdte. V°B° Gerencia | Aprobada | Devuelta
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  aprobado_por TEXT, aprobado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_ordenes_pago_orden_aprobacion ON ordenes_pago(orden_aprobacion_id);
`);

// Migraciones ligeras: agrega columnas nuevas a tablas que ya existían en despliegues previos
// (CREATE TABLE IF NOT EXISTS no modifica una tabla que ya existe con el disco persistente de Render).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('tarifario_items', 'descripcion', 'TEXT');
ensureColumn('extracto_clientes', 'formulario_disenado', 'INTEGER NOT NULL DEFAULT 0');
// Vincula un contrato de Operaciones (contratos.id) con el cliente corporativo de Comercial del que
// se generó automáticamente al aprobarse su contrato en Trámites — así Operaciones consume el mismo
// tarifario (tarifario_items) y usa contrato_campos para diseñar el formulario de servicios de ese cliente.
ensureColumn('contratos', 'extracto_cliente_id', 'TEXT REFERENCES extracto_clientes(id)');
ensureColumn('servicios', 'campos', 'TEXT');
ensureColumn('servicios', 'liquidacion', 'TEXT');
ensureColumn('servicios', 'extracto_id', 'TEXT REFERENCES extractos(id)');
// Numeración legible del servicio: DD/MM/AA-NNN, NNN consecutivo dentro del día de agendamiento
// (servicios.fecha) — el id técnico (PK) no cambia, esto es solo para mostrar/buscar.
ensureColumn('servicios', 'numero', 'TEXT');
ensureColumn('servicios', 'ventana_ruta', 'TEXT');
ensureColumn('servicios', 'referencia', 'TEXT');
ensureColumn('servicios', 'usuarios', 'TEXT'); // JSON [{nombre, telefono, id}]
ensureColumn('servicios', 'historial', 'TEXT'); // JSON [{fecha, usuario, accion, detalle}]
// Ficha del contrato: contactos de negociación/contabilidad, consideraciones por área, y el
// logístico responsable — en Operaciones, un usuario con rol "operaciones" solo ve los servicios
// de los contratos donde es el logístico asignado (si el contrato no tiene logístico, lo ven todos).
ensureColumn('contratos', 'contacto_negociador', 'TEXT');
ensureColumn('contratos', 'contacto_contable', 'TEXT');
ensureColumn('contratos', 'consideraciones_operativas', 'TEXT');
ensureColumn('contratos', 'consideraciones_contables', 'TEXT');
ensureColumn('contratos', 'consideraciones_comerciales', 'TEXT');
ensureColumn('users', 'firma_url', 'TEXT');
ensureColumn('extracto_contrato_historial', 'firma_url', 'TEXT');
ensureColumn('extractos', 'tarifario_item_id', 'INTEGER REFERENCES tarifario_items(id)');
// Acceso del conductor al Portal Conductor (login propio, separado de `users`): la cédula ya es
// única y hace de usuario; la contraseña la activa Trámites/Operaciones (ver POST
// /api/conductores/:id/set-password) — mientras esté en NULL, ese conductor no puede iniciar sesión.
ensureColumn('conductores', 'password_hash', 'TEXT');

function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(
      'INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)'
    ).run('Administrador PIG', 'admin@multimodalgroup.com', hash, 'admin');
    // Roles de aprobación del flujo de Liquidación (ver §16 de BACKEND_DESIGN.md): Director de
    // Operaciones aprueba/devuelve la relación de servicios liquidados que envía Operaciones;
    // Gerencia da el V°B° final de la orden de pago antes de que Contabilidad descargue los
    // archivos planos. Usuarios de ejemplo con la misma contraseña que el admin, para poder
    // probar el flujo completo de principio a fin.
    const hashAprob = bcrypt.hashSync('director123', 10);
    db.prepare(
      'INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)'
    ).run('Directora de Operaciones', 'director@multimodalgroup.com', hashAprob, 'director_operaciones');
    const hashGer = bcrypt.hashSync('gerente123', 10);
    db.prepare(
      'INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)'
    ).run('Gerente General', 'gerente@multimodalgroup.com', hashGer, 'gerente');
  }

  const vehCount = db.prepare('SELECT COUNT(*) n FROM vehiculos').get().n;
  if (vehCount === 0) {
    const insVeh = db.prepare(`INSERT INTO vehiculos
      (id, placa, clase, marca, linea, modelo, motor, chasis, vin, color, capacidad, combustible, tipo, interno, estado,
       propietario_nombre, propietario_documento, propietario_telefono, propietario_email, fecha_vin,
       convenio_cliente, convenio_vigencia, convenio_estado)
      VALUES (@id,@placa,@clase,@marca,@linea,@modelo,@motor,@chasis,@vin,@color,@capacidad,@combustible,@tipo,@interno,@estado,
       @propietario_nombre,@propietario_documento,@propietario_telefono,@propietario_email,@fecha_vin,
       @convenio_cliente,@convenio_vigencia,@convenio_estado)`);
    const insDoc = db.prepare(`INSERT INTO documentos (entidad_tipo, entidad_id, doc_tipo, vencimiento, estado)
      VALUES ('vehiculo', ?, ?, ?, ?)`);
    const insCartera = db.prepare(`INSERT INTO cartera (vehiculo_id, saldo, estado, ultimo_pago) VALUES (?,?,?,?)`);

    const seed = [
      { id: 'v001', placa: 'HXK-234', clase: 'Campero', marca: 'Toyota', linea: 'Fortuner', modelo: 2021, motor: '4TR123456', chasis: 'CH789012', vin: 'VIN123456789', color: 'Blanco', capacidad: 7, combustible: 'Gasolina', tipo: 'Afiliado', interno: '001', estado: 'Activo',
        propietario_nombre: 'Propietario Afiliado 001', propietario_documento: 'CC-71234567', propietario_telefono: '300-002-0002', propietario_email: 'afiliado001@email.com', fecha_vin: '2023-02-15',
        convenio_cliente: 'ICBF Regional Antioquia', convenio_vigencia: '2026-12-31', convenio_estado: 'Vigente',
        docs: { soat: ['2026-12-31', 'VIGENTE'], rtm: ['2026-08-15', 'VIGENTE'], to: ['2027-03-01', 'VIGENTE'], polizaRC: ['2026-12-31', 'VIGENTE'] },
        cartera: [182000, 'PROXIMO', '2026-06-01'] },
      { id: 'v002', placa: 'SJT-891', clase: 'Van', marca: 'Mercedes-Benz', linea: 'Sprinter', modelo: 2022, motor: 'OM651123', chasis: 'CH456789', vin: 'VIN987654321', color: 'Plata', capacidad: 15, combustible: 'Diesel', tipo: 'Propio', interno: '002', estado: 'Activo',
        propietario_nombre: 'TRANSPORTES MULTIMODAL GROUP S.A.S.', propietario_documento: '900683508', propietario_telefono: '6042345678', propietario_email: 'info@multimodal.com', fecha_vin: '2022-05-20',
        convenio_cliente: 'Bancolombia S.A.', convenio_vigencia: '2026-12-31', convenio_estado: 'Vigente',
        docs: { soat: ['2026-07-10', 'PROXIMO'], rtm: ['2026-09-20', 'VIGENTE'], to: ['2027-01-15', 'VIGENTE'], polizaRC: ['2026-12-31', 'VIGENTE'] },
        cartera: [0, 'AL_DIA', '2026-06-10'] },
      { id: 'v003', placa: 'KLP-567', clase: 'Microbús', marca: 'Chevrolet', linea: 'NPR', modelo: 2019, motor: 'NPR4501', chasis: 'CH321654', vin: 'VIN456123789', color: 'Azul', capacidad: 19, combustible: 'Diesel', tipo: 'Afiliado', interno: '003', estado: 'Activo',
        propietario_nombre: 'Propietaria Afiliada 003', propietario_documento: 'CC-43876543', propietario_telefono: '300-003-0003', propietario_email: 'afiliada003@email.com', fecha_vin: '2021-08-10',
        convenio_cliente: null, convenio_vigencia: null, convenio_estado: null,
        docs: { soat: ['2026-05-30', 'VENCIDO'], rtm: ['2026-06-01', 'VENCIDO'], to: ['2025-12-31', 'VENCIDO'], polizaRC: ['2026-12-31', 'VIGENTE'] },
        cartera: [725000, 'MORA_CRITICA', '2026-03-15'] },
      { id: 'v004', placa: 'BNM-112', clase: 'Automóvil', marca: 'Kia', linea: 'Sportage', modelo: 2023, motor: 'KIA23001', chasis: 'CH654987', vin: 'VIN789321456', color: 'Negro', capacidad: 5, combustible: 'Gasolina', tipo: 'Aliado', interno: '004', estado: 'Activo',
        propietario_nombre: 'Flota Aliada Antioquia S.A.S.', propietario_documento: '900112233', propietario_telefono: '300-004-0004', propietario_email: 'contacto@flotaaliada.com', fecha_vin: '2024-01-08',
        convenio_cliente: 'Universidad de Antioquia', convenio_vigencia: '2026-12-31', convenio_estado: 'Vigente',
        docs: { soat: ['2027-01-15', 'VIGENTE'], rtm: ['2026-12-10', 'VIGENTE'], to: ['2028-01-01', 'VIGENTE'], polizaRC: ['2027-01-15', 'VIGENTE'] },
        cartera: [364000, 'MORA_MODERADA', '2026-04-20'] },
      { id: 'v005', placa: 'PRT-445', clase: 'Bus', marca: 'Marcopolo', linea: 'Volare', modelo: 2020, motor: 'MPW20001', chasis: 'CH987123', vin: 'VIN321789654', color: 'Blanco/Azul', capacidad: 29, combustible: 'Diesel', tipo: 'Propio', interno: '005', estado: 'Activo',
        propietario_nombre: 'TRANSPORTES MULTIMODAL GROUP S.A.S.', propietario_documento: '900683508', propietario_telefono: '6042345678', propietario_email: 'info@multimodal.com', fecha_vin: '2020-09-01',
        convenio_cliente: 'EPM', convenio_vigencia: '2026-12-31', convenio_estado: 'Vigente',
        docs: { soat: ['2026-11-30', 'VIGENTE'], rtm: ['2026-10-15', 'VIGENTE'], to: ['2026-09-30', 'PROXIMO'], polizaRC: ['2026-12-31', 'VIGENTE'] },
        cartera: [0, 'AL_DIA', '2026-06-05'] },
    ];

    const insertAll = db.transaction((rows) => {
      for (const v of rows) {
        const { docs, cartera, ...vRow } = v;
        insVeh.run(vRow);
        for (const [docTipo, [ven, estado]] of Object.entries(docs)) {
          insDoc.run(v.id, docTipo, ven, estado);
        }
        insCartera.run(v.id, ...cartera);
      }
    });
    insertAll(seed);
  }

  const condCount = db.prepare('SELECT COUNT(*) n FROM conductores').get().n;
  if (condCount === 0) {
    const insCond = db.prepare(`INSERT INTO conductores
      (id, nombre, cedula, telefono, email, licencia, venc_licencia, vehiculo_id, tipo, eps, arl, pensiones, activo, fecha_vin)
      VALUES (@id,@nombre,@cedula,@telefono,@email,@licencia,@venc_licencia,@vehiculo_id,@tipo,@eps,@arl,@pensiones,@activo,@fecha_vin)`);
    const insDoc = db.prepare(`INSERT INTO documentos (entidad_tipo, entidad_id, doc_tipo, vencimiento, estado)
      VALUES ('conductor', ?, ?, ?, ?)`);
    const seed = [
      { id: 'c001', nombre: 'Conductor Ejemplo 01', cedula: 'CC-71890234', telefono: '310-001-0001', email: 'conductor01@email.com', licencia: 'B2, C1', venc_licencia: '2027-06-30', vehiculo_id: 'v001', tipo: 'Afiliado', eps: 'Sura EPS', arl: 'Positiva', pensiones: 'Colpensiones', activo: 1, fecha_vin: '2022-03-10',
        docs: { licencia: ['2027-06-30', 'VIGENTE'], segSocial: ['2026-07-31', 'VIGENTE'], examenMedico: ['2026-08-01', 'VIGENTE'], mantDefensivo: ['2026-09-15', 'VIGENTE'], antecedentes: ['2026-12-01', 'VIGENTE'], cedula: [null, 'VIGENTE'], habeasData: [null, 'VIGENTE'] } },
      { id: 'c002', nombre: 'Conductor Ejemplo 02', cedula: 'CC-98234567', telefono: '300-002-0002', email: 'conductor02@multimodal.com', licencia: 'B2, C1, C2', venc_licencia: '2026-08-20', vehiculo_id: 'v002', tipo: 'Propio', eps: 'Compensar', arl: 'Sura ARL', pensiones: 'Porvenir', activo: 1, fecha_vin: '2021-06-15',
        docs: { licencia: ['2026-08-20', 'PROXIMO'], segSocial: ['2026-07-31', 'VIGENTE'], examenMedico: ['2025-12-31', 'VENCIDO'], mantDefensivo: ['2026-11-01', 'VIGENTE'], antecedentes: ['2026-10-15', 'VIGENTE'], cedula: [null, 'VIGENTE'], habeasData: [null, 'VIGENTE'] } },
      { id: 'c003', nombre: 'Conductor Ejemplo 03', cedula: 'CC-35789012', telefono: '310-003-0003', email: 'conductor03@email.com', licencia: 'B1, B2', venc_licencia: '2028-02-15', vehiculo_id: 'v005', tipo: 'Propio', eps: 'Sura EPS', arl: 'Sura ARL', pensiones: 'Colpensiones', activo: 1, fecha_vin: '2020-09-01',
        docs: { licencia: ['2028-02-15', 'VIGENTE'], segSocial: ['2026-07-31', 'VIGENTE'], examenMedico: ['2026-08-01', 'VIGENTE'], mantDefensivo: ['2026-09-15', 'VIGENTE'], antecedentes: ['2026-12-01', 'VIGENTE'], cedula: [null, 'VIGENTE'], habeasData: [null, 'VIGENTE'] } },
    ];
    const insertAll = db.transaction((rows) => {
      for (const c of rows) {
        const { docs, ...cRow } = c;
        insCond.run(cRow);
        for (const [docTipo, [ven, estado]] of Object.entries(docs)) {
          insDoc.run(c.id, docTipo, ven, estado);
        }
      }
    });
    insertAll(seed);
  }

  const tipoTramiteCount = db.prepare('SELECT COUNT(*) n FROM tipos_tramite').get().n;
  if (tipoTramiteCount === 0) {
    db.prepare(`INSERT INTO tipos_tramite (id, label, grupo, icono, etapas) VALUES (?,?,?,?,?)`).run(
      'VINCULACION', 'Vinculación', 'VEHICULO', '🚗',
      JSON.stringify(['Solicitud', 'Validación', 'Cotización', 'Aprobación', 'Radicación', 'Documentos', 'Finalizado'])
    );
    db.prepare(`INSERT INTO tipos_tramite (id, label, grupo, icono, etapas) VALUES (?,?,?,?,?)`).run(
      'DESVINCULACION', 'Desvinculación', 'VEHICULO', '🚫',
      JSON.stringify(['Solicitud', 'Revisión de cartera', 'Aprobación', 'Cierre'])
    );
  }

  const catCount = db.prepare('SELECT COUNT(*) n FROM documentos_solicitud_config').get().n;
  if (catCount === 0) {
    const docs = [
      ['cedula', 'Fotocopia cédula (ambas caras)', 'Legible, sin recortes.', 1],
      ['soat', 'SOAT vigente', 'Debe estar vigente al momento de la vinculación.', 1],
      ['rtm', 'Revisión Técnico-Mecánica vigente', 'Máximo 2 años de antigüedad.', 1],
      ['tarjetaPropiedad', 'Tarjeta de propiedad', 'Ambas caras, legible.', 1],
      ['licencia', 'Licencia de conducción del conductor', 'Categoría acorde al vehículo.', 1],
      ['polizaRC', 'Póliza RC contractual y extracontractual', 'Debe cubrir el período de vinculación.', 1],
      ['antecedentes', 'Antecedentes judiciales', 'Vigencia máxima 30 días.', 1],
    ];
    const ins = db.prepare(`INSERT INTO documentos_solicitud_config (id, label, tip, obligatorio, orden, contexto) VALUES (?,?,?,?,?,'vinculacion')`);
    docs.forEach(([id, label, tip, ob], i) => ins.run(id, label, tip, ob, i));
  }

  const extractoConfigCount = db.prepare('SELECT COUNT(*) n FROM extracto_config').get().n;
  if (extractoConfigCount === 0) {
    // Antioquia-Chocó (305) — domicilio de Transportes Multimodal Group S.A.S. Ajustar si la
    // habilitación real de la empresa corresponde a otra Dirección Territorial o resolución.
    db.prepare('INSERT INTO extracto_config (id, codigo_territorial, numero_resolucion_habilitacion, anio_habilitacion, tolerancia_mant_defensivo_dias) VALUES (1, ?, ?, ?, ?)')
      .run('305', '0010', '13', 10);
  }
}

seedIfEmpty();

module.exports = db;
