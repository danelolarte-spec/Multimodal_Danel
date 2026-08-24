const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'pig-multimodal-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────── Helpers ─────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
    if (!roles.includes(req.session.rol)) return res.status(403).json({ error: 'No autorizado' });
    next();
  };
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// Genérico para tablas de configuración/catálogo simples (sin relaciones anidadas)
function crudRoutes(basePath, table, { idPrefix, writeRoles = ['admin', 'tramites'], orderBy = 'id' } = {}) {
  app.get(basePath, requireAuth, (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all());
  });
  app.get(`${basePath}/:id`, requireAuth, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    res.json(row);
  });
  app.post(basePath, requireRole(...writeRoles), (req, res) => {
    const body = { ...req.body };
    if (!body.id && idPrefix) body.id = newId(idPrefix);
    const cols = Object.keys(body);
    const stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
    );
    stmt.run(body);
    res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(body.id));
  });
  app.put(`${basePath}/:id`, requireRole(...writeRoles), (req, res) => {
    const body = req.body;
    const cols = Object.keys(body).filter((c) => c !== 'id');
    if (cols.length) {
      db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(',')} WHERE id = @id`).run({
        ...body,
        id: req.params.id,
      });
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    res.json(row);
  });
  app.delete(`${basePath}/:id`, requireRole(...writeRoles), (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.status(204).end();
  });
}

// ───────────────────────── Auth ─────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND activo = 1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  req.session.userId = user.id;
  req.session.rol = user.rol;
  res.json({ id: user.id, nombre: user.nombre, email: user.email, rol: user.rol });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, nombre, email, rol FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  res.json(user);
});

// ───────────────────────── Dashboard ─────────────────────────
app.get('/api/dashboard/resumen', requireAuth, (req, res) => {
  const docsVencidos = db
    .prepare("SELECT entidad_tipo, COUNT(*) n FROM documentos WHERE estado = 'VENCIDO' GROUP BY entidad_tipo")
    .all();
  const carteraTotal = db.prepare('SELECT COALESCE(SUM(saldo),0) total FROM cartera').get().total;
  const infraccionesAbiertas = db.prepare("SELECT COUNT(*) n FROM infracciones WHERE estado != 'CERRADO'").get().n;
  const tramitesEnProceso = db.prepare("SELECT COUNT(*) n FROM tramites WHERE estado = 'EN_PROCESO'").get().n;
  const solicitudesPendientes = db
    .prepare("SELECT COUNT(*) n FROM solicitudes_afiliacion WHERE estado NOT IN ('APROBADO','RECHAZADO')")
    .get().n;
  res.json({
    vehiculos: db.prepare('SELECT COUNT(*) n FROM vehiculos').get().n,
    conductores: db.prepare('SELECT COUNT(*) n FROM conductores').get().n,
    documentosVencidos: docsVencidos,
    carteraTotal,
    infraccionesAbiertas,
    tramitesEnProceso,
    solicitudesPendientes,
  });
});

// ───────────────────────── Vehículos ─────────────────────────
function vehiculoConDetalle(v) {
  if (!v) return v;
  const docs = db.prepare("SELECT doc_tipo, vencimiento, estado, archivo_url FROM documentos WHERE entidad_tipo='vehiculo' AND entidad_id=?").all(v.id);
  const documentos = {};
  docs.forEach((d) => { documentos[d.doc_tipo] = { ven: d.vencimiento, estado: d.estado, archivoUrl: d.archivo_url }; });
  const cartera = db.prepare('SELECT saldo, estado, ultimo_pago, restriccion, restriccion_manual FROM cartera WHERE vehiculo_id=?').get(v.id);
  return { ...v, documentos, cartera: cartera || null };
}

app.get('/api/vehiculos', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM vehiculos ORDER BY placa').all();
  res.json(rows.map(vehiculoConDetalle));
});

app.get('/api/vehiculos/:id', requireAuth, (req, res) => {
  const v = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'No encontrado' });
  res.json(vehiculoConDetalle(v));
});

app.post('/api/vehiculos', requireRole('admin', 'tramites'), (req, res) => {
  const body = req.body || {};
  const id = body.id || newId('v');
  const cols = ['id','placa','clase','marca','linea','modelo','motor','chasis','vin','color','capacidad','combustible','tipo','interno','estado','propietario_nombre','propietario_documento','propietario_telefono','propietario_email','fecha_vin','convenio_cliente','convenio_vigencia','convenio_estado'];
  const row = Object.fromEntries(cols.map((c) => [c, body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'Activo';
  db.prepare(`INSERT INTO vehiculos (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row);
  db.prepare('INSERT INTO cartera (vehiculo_id, saldo, estado) VALUES (?, 0, ?)').run(id, 'AL_DIA');
  res.status(201).json(vehiculoConDetalle(db.prepare('SELECT * FROM vehiculos WHERE id=?').get(id)));
});

app.put('/api/vehiculos/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['placa','clase','marca','linea','modelo','motor','chasis','vin','color','capacidad','combustible','tipo','interno','estado','propietario_nombre','propietario_documento','propietario_telefono','propietario_email','fecha_vin','convenio_cliente','convenio_vigencia','convenio_estado'];
  const present = cols.filter((c) => c in req.body);
  if (present.length) {
    db.prepare(`UPDATE vehiculos SET ${present.map((c) => `${c}=@${c}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...req.body, id: req.params.id });
  }
  const v = db.prepare('SELECT * FROM vehiculos WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'No encontrado' });
  res.json(vehiculoConDetalle(v));
});

app.put('/api/vehiculos/:id/documentos/:docTipo', requireRole('admin', 'tramites'), (req, res) => {
  const { vencimiento, estado, archivoUrl } = req.body || {};
  db.prepare(`INSERT INTO documentos (entidad_tipo, entidad_id, doc_tipo, vencimiento, estado, archivo_url, updated_at)
    VALUES ('vehiculo', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entidad_tipo, entidad_id, doc_tipo) DO UPDATE SET vencimiento=excluded.vencimiento, estado=excluded.estado, archivo_url=excluded.archivo_url, updated_at=datetime('now')`)
    .run(req.params.id, req.params.docTipo, vencimiento ?? null, estado ?? 'PENDIENTE', archivoUrl ?? null);
  res.json(vehiculoConDetalle(db.prepare('SELECT * FROM vehiculos WHERE id=?').get(req.params.id)));
});

// ───────────────────────── Cartera ─────────────────────────
app.get('/api/cartera', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, v.placa FROM cartera c JOIN vehiculos v ON v.id = c.vehiculo_id ORDER BY c.saldo DESC
  `).all();
  res.json(rows);
});

app.put('/api/cartera/:vehiculoId', requireRole('admin', 'tramites'), (req, res) => {
  const { restriccion, restriccion_manual } = req.body || {};
  db.prepare('UPDATE cartera SET restriccion = COALESCE(?, restriccion), restriccion_manual = COALESCE(?, restriccion_manual) WHERE vehiculo_id = ?')
    .run(restriccion ?? null, restriccion_manual ?? null, req.params.vehiculoId);
  res.json(db.prepare('SELECT * FROM cartera WHERE vehiculo_id = ?').get(req.params.vehiculoId));
});

app.get('/api/cartera/:vehiculoId/pagos', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM cartera_pagos WHERE vehiculo_id = ? ORDER BY fecha DESC').all(req.params.vehiculoId));
});

app.post('/api/cartera/:vehiculoId/pagos', requireRole('admin', 'tramites'), (req, res) => {
  const { fecha, valor, obs, comprobanteUrl } = req.body || {};
  if (!fecha || !valor) return res.status(400).json({ error: 'fecha y valor son requeridos' });
  const registradoPor = db.prepare('SELECT nombre FROM users WHERE id = ?').get(req.session.userId)?.nombre;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO cartera_pagos (vehiculo_id, fecha, valor, obs, comprobante_url, registrado_por) VALUES (?,?,?,?,?,?)')
      .run(req.params.vehiculoId, fecha, valor, obs || null, comprobanteUrl || null, registradoPor);
    const cartera = db.prepare('SELECT saldo FROM cartera WHERE vehiculo_id = ?').get(req.params.vehiculoId);
    const nuevoSaldo = Math.max(0, (cartera?.saldo || 0) - valor);
    db.prepare('UPDATE cartera SET saldo = ?, ultimo_pago = ? WHERE vehiculo_id = ?').run(nuevoSaldo, fecha, req.params.vehiculoId);
  });
  tx();
  res.status(201).json(db.prepare('SELECT * FROM cartera WHERE vehiculo_id = ?').get(req.params.vehiculoId));
});

// ───────────────────────── Conductores ─────────────────────────
function conductorConDetalle(c) {
  if (!c) return c;
  const docs = db.prepare("SELECT doc_tipo, vencimiento, estado, archivo_url FROM documentos WHERE entidad_tipo='conductor' AND entidad_id=?").all(c.id);
  const docsObj = {};
  docs.forEach((d) => { docsObj[d.doc_tipo] = { ven: d.vencimiento, est: d.estado, archivoUrl: d.archivo_url }; });
  const segHist = db.prepare('SELECT mes, fecha, estado FROM conductor_seg_social_historial WHERE conductor_id=? ORDER BY fecha DESC').all(c.id);
  return { ...c, docs: docsObj, segHist };
}

app.get('/api/conductores', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM conductores ORDER BY nombre').all().map(conductorConDetalle));
});

app.get('/api/conductores/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM conductores WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrado' });
  res.json(conductorConDetalle(c));
});

app.post('/api/conductores', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['nombre','cedula','telefono','email','licencia','venc_licencia','vehiculo_id','tipo','eps','arl','pensiones','activo','fecha_vin','foto_url'];
  const id = req.body.id || newId('c');
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.activo = row.activo === null ? 1 : (row.activo ? 1 : 0);
  db.prepare(`INSERT INTO conductores (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
  res.status(201).json(conductorConDetalle(db.prepare('SELECT * FROM conductores WHERE id=?').get(id)));
});

app.put('/api/conductores/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['nombre','cedula','telefono','email','licencia','venc_licencia','vehiculo_id','tipo','eps','arl','pensiones','activo','fecha_vin','foto_url'];
  const present = cols.filter((c) => c in req.body);
  if (present.length) {
    db.prepare(`UPDATE conductores SET ${present.map((c) => `${c}=@${c}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...req.body, id: req.params.id });
  }
  const c = db.prepare('SELECT * FROM conductores WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrado' });
  res.json(conductorConDetalle(c));
});

app.put('/api/conductores/:id/documentos/:docTipo', requireRole('admin', 'tramites'), (req, res) => {
  const { vencimiento, estado, archivoUrl } = req.body || {};
  db.prepare(`INSERT INTO documentos (entidad_tipo, entidad_id, doc_tipo, vencimiento, estado, archivo_url, updated_at)
    VALUES ('conductor', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entidad_tipo, entidad_id, doc_tipo) DO UPDATE SET vencimiento=excluded.vencimiento, estado=excluded.estado, archivo_url=excluded.archivo_url, updated_at=datetime('now')`)
    .run(req.params.id, req.params.docTipo, vencimiento ?? null, estado ?? 'PENDIENTE', archivoUrl ?? null);
  res.json(conductorConDetalle(db.prepare('SELECT * FROM conductores WHERE id=?').get(req.params.id)));
});

// ───────────────────────── Infracciones ─────────────────────────
crudRoutes('/api/infracciones', 'infracciones', { idPrefix: 'i' });

// ───────────────────────── Pólizas y Reclamaciones ─────────────────────────
app.get('/api/polizas', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM polizas ORDER BY hasta').all();
  res.json(rows.map((p) => ({
    ...p,
    vehiculosIds: db.prepare('SELECT vehiculo_id FROM poliza_vehiculos WHERE poliza_id=?').all(p.id).map((r) => r.vehiculo_id),
  })));
});

app.post('/api/polizas', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['tipo','aseguradora','num','desde','hasta','valor','cuotas','cuota','cobertura','intermediario','estado','asesor_nombre','asesor_telefono','asesor_email','asistencia_telefono','asistencia_desc','caratula_url'];
  const id = req.body.id || newId('p');
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'VIGENTE';
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO polizas (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
    (req.body.vehiculosIds || []).forEach((vid) => db.prepare('INSERT INTO poliza_vehiculos (poliza_id, vehiculo_id) VALUES (?,?)').run(id, vid));
  });
  tx();
  res.status(201).json(db.prepare('SELECT * FROM polizas WHERE id=?').get(id));
});

app.put('/api/polizas/:id/vehiculos', requireRole('admin', 'tramites'), (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM poliza_vehiculos WHERE poliza_id=?').run(req.params.id);
    (req.body.vehiculosIds || []).forEach((vid) => db.prepare('INSERT INTO poliza_vehiculos (poliza_id, vehiculo_id) VALUES (?,?)').run(req.params.id, vid));
  });
  tx();
  res.status(204).end();
});

app.get('/api/reclamaciones', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reclamaciones ORDER BY fecha_siniestro DESC').all();
  res.json(rows.map((r) => ({ ...r, historial: db.prepare('SELECT * FROM reclamacion_historial WHERE reclamacion_id=? ORDER BY id').all(r.id) })));
});

app.post('/api/reclamaciones', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['vehiculo_id','poliza_id','tipo','fecha_siniestro','fecha_reporte','estado','descripcion','valor_estimado','valor_indemnizado','deducible','radicado_aseguradora'];
  const id = req.body.id || newId('rc');
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'REPORTADO';
  db.prepare(`INSERT INTO reclamaciones (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  db.prepare("INSERT INTO reclamacion_historial (reclamacion_id, fecha, hora, usuario, accion, tipo, nota) VALUES (?, date('now'), time('now'), ?, 'Caso creado', 'sistema', '')")
    .run(id, usuario);
  res.status(201).json(db.prepare('SELECT * FROM reclamaciones WHERE id=?').get(id));
});

app.put('/api/reclamaciones/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['estado','descripcion','valor_estimado','valor_indemnizado','deducible','radicado_aseguradora'];
  const present = cols.filter((c) => c in req.body);
  const tx = db.transaction(() => {
    if (present.length) {
      db.prepare(`UPDATE reclamaciones SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
    }
    if (req.body.estado) {
      const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
      db.prepare("INSERT INTO reclamacion_historial (reclamacion_id, fecha, hora, usuario, accion, tipo, nota) VALUES (?, date('now'), time('now'), ?, ?, 'estado', ?)")
        .run(req.params.id, usuario, `Cambió estado a: ${req.body.estado}`, req.body.nota || '');
    }
  });
  tx();
  res.json(db.prepare('SELECT * FROM reclamaciones WHERE id=?').get(req.params.id));
});

// ───────────────────────── Convenios ─────────────────────────
app.get('/api/convenios', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM convenios ORDER BY fecha_fin').all();
  res.json(rows.map((c) => ({ ...c, vehiculosIds: db.prepare('SELECT vehiculo_id FROM convenio_vehiculos WHERE convenio_id=?').all(c.id).map((r) => r.vehiculo_id) })));
});

app.post('/api/convenios', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['cliente','nit','contacto','telefono','email','tipo','fecha_inicio','fecha_fin','valor','estado','obs','origen','destino','archivo_url'];
  const id = req.body.id || newId('con');
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'VIGENTE';
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO convenios (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
    (req.body.vehiculosIds || []).forEach((vid) => db.prepare('INSERT INTO convenio_vehiculos (convenio_id, vehiculo_id) VALUES (?,?)').run(id, vid));
  });
  tx();
  res.status(201).json(db.prepare('SELECT * FROM convenios WHERE id=?').get(id));
});

app.put('/api/convenios/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['cliente','nit','contacto','telefono','email','tipo','fecha_inicio','fecha_fin','valor','estado','obs','origen','destino','archivo_url'];
  const present = cols.filter((c) => c in req.body);
  const tx = db.transaction(() => {
    if (present.length) db.prepare(`UPDATE convenios SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
    if (req.body.vehiculosIds) {
      db.prepare('DELETE FROM convenio_vehiculos WHERE convenio_id=?').run(req.params.id);
      req.body.vehiculosIds.forEach((vid) => db.prepare('INSERT INTO convenio_vehiculos (convenio_id, vehiculo_id) VALUES (?,?)').run(req.params.id, vid));
    }
  });
  tx();
  res.json(db.prepare('SELECT * FROM convenios WHERE id=?').get(req.params.id));
});

// ───────────────────────── Leasing y Prendas ─────────────────────────
app.get('/api/leasings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM leasings ORDER BY fecha_fin').all();
  res.json(rows.map((l) => ({ ...l, pagos: db.prepare('SELECT * FROM leasing_pagos WHERE leasing_id=? ORDER BY fecha DESC').all(l.id) })));
});

app.post('/api/leasings', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['vehiculo_id','tipo','entidad','contacto','telefono','cuota_mensual','fecha_inicio','fecha_fin','saldo_pendiente','estado','obs','archivo_url'];
  const id = req.body.id || newId('ls');
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'ACTIVO';
  db.prepare(`INSERT INTO leasings (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
  res.status(201).json(db.prepare('SELECT * FROM leasings WHERE id=?').get(id));
});

app.put('/api/leasings/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['tipo','entidad','contacto','telefono','cuota_mensual','fecha_inicio','fecha_fin','saldo_pendiente','estado','obs','archivo_url'];
  const present = cols.filter((c) => c in req.body);
  if (present.length) db.prepare(`UPDATE leasings SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(db.prepare('SELECT * FROM leasings WHERE id=?').get(req.params.id));
});

app.post('/api/leasings/:id/pagos', requireRole('admin', 'tramites'), (req, res) => {
  const { fecha, valor, obs } = req.body || {};
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO leasing_pagos (leasing_id, fecha, valor, obs) VALUES (?,?,?,?)').run(req.params.id, fecha, valor, obs || null);
    db.prepare('UPDATE leasings SET saldo_pendiente = MAX(0, saldo_pendiente - ?) WHERE id = ?').run(valor, req.params.id);
  });
  tx();
  res.status(201).json(db.prepare('SELECT * FROM leasings WHERE id=?').get(req.params.id));
});

// ───────────────────────── Renovaciones mensuales ─────────────────────────
crudRoutes('/api/docs-mensuales', 'docs_mensuales', { idPrefix: 'dm' });

// ───────────────────────── Caja menor ─────────────────────────
crudRoutes('/api/caja-menor', 'caja_menor', { idPrefix: 'cm' });

// ───────────────────────── Tipos de trámite (diseñador) ─────────────────────────
app.get('/api/tipos-tramite', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tipos_tramite ORDER BY grupo, label').all().map((t) => ({ ...t, etapas: JSON.parse(t.etapas || '[]') })));
});
app.post('/api/tipos-tramite', requireRole('admin'), (req, res) => {
  const id = req.body.id || newId('tt');
  db.prepare('INSERT INTO tipos_tramite (id, label, grupo, icono, etapas, activo) VALUES (?,?,?,?,?,?)')
    .run(id, req.body.label, req.body.grupo || null, req.body.icono || null, JSON.stringify(req.body.etapas || []), req.body.activo ?? 1);
  res.status(201).json(db.prepare('SELECT * FROM tipos_tramite WHERE id=?').get(id));
});
app.put('/api/tipos-tramite/:id', requireRole('admin'), (req, res) => {
  const { label, grupo, icono, etapas, activo } = req.body || {};
  db.prepare('UPDATE tipos_tramite SET label=COALESCE(?,label), grupo=COALESCE(?,grupo), icono=COALESCE(?,icono), etapas=COALESCE(?,etapas), activo=COALESCE(?,activo) WHERE id=?')
    .run(label ?? null, grupo ?? null, icono ?? null, etapas ? JSON.stringify(etapas) : null, activo ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM tipos_tramite WHERE id=?').get(req.params.id));
});

// ───────────────────────── Trámites (vinculaciones, desvinculaciones, etc.) ─────────────────────────
function tramiteConDetalle(t) {
  return {
    ...t,
    costos: db.prepare('SELECT concepto, valor FROM tramite_costos WHERE tramite_id=?').all(t.id),
    historial: db.prepare('SELECT * FROM tramite_historial WHERE tramite_id=? ORDER BY id').all(t.id),
  };
}

app.get('/api/tramites', requireAuth, (req, res) => {
  let sql = 'SELECT * FROM tramites';
  const params = [];
  if (req.query.tipo) { sql += ' WHERE tipo_tramite_id = ?'; params.push(req.query.tipo); }
  sql += ' ORDER BY fecha_inicio DESC';
  res.json(db.prepare(sql).all(...params).map(tramiteConDetalle));
});

app.post('/api/tramites', requireRole('admin', 'tramites'), (req, res) => {
  const id = req.body.id || newId('t');
  const cols = ['tipo_tramite_id','vehiculo_id','conductor_id','estado','fecha_inicio','fecha_cierre','etapa','obs','radicado_num','radicado_fecha','radicado_dias'];
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'EN_PROCESO';
  row.etapa = row.etapa ?? 1;
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO tramites (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
    (req.body.costos || []).forEach((c) => db.prepare('INSERT INTO tramite_costos (tramite_id, concepto, valor) VALUES (?,?,?)').run(id, c.con || c.concepto, c.val ?? c.valor));
    db.prepare("INSERT INTO tramite_historial (tramite_id, fecha, hora, usuario, accion, tipo, nota) VALUES (?, date('now'), time('now'), ?, 'Trámite creado', 'sistema', '')").run(id, usuario);
  });
  tx();
  res.status(201).json(tramiteConDetalle(db.prepare('SELECT * FROM tramites WHERE id=?').get(id)));
});

app.put('/api/tramites/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['estado','fecha_cierre','etapa','obs','radicado_num','radicado_fecha','radicado_dias'];
  const present = cols.filter((c) => c in req.body);
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  const tx = db.transaction(() => {
    if (present.length) db.prepare(`UPDATE tramites SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
    if (req.body.nota || req.body.etapa) {
      db.prepare("INSERT INTO tramite_historial (tramite_id, fecha, hora, usuario, accion, tipo, nota) VALUES (?, date('now'), time('now'), ?, ?, 'estado', ?)")
        .run(req.params.id, usuario, req.body.accion || 'Actualización de trámite', req.body.nota || '');
    }
  });
  tx();
  res.json(tramiteConDetalle(db.prepare('SELECT * FROM tramites WHERE id=?').get(req.params.id)));
});

// ───────────────────────── Portal de afiliación / Solicitudes ─────────────────────────
// Sin autenticación: formulario público de autogestión
app.get('/api/portal/documentos-requeridos', (req, res) => {
  res.json(db.prepare("SELECT * FROM documentos_solicitud_config WHERE contexto='vinculacion' ORDER BY orden").all());
});

app.post('/api/portal/solicitudes', (req, res) => {
  const b = req.body || {};
  const id = 'SOL-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
  const cols = ['fecha','estado','nombre','cedula','telefono','email','ciudad','placa','clase','marca','linea','modelo','color','capacidad','combustible','es_nuevo','icbf_trabaja','tiene_convenio','cliente_convenio','observaciones','etapa','radicado'];
  const row = Object.fromEntries(cols.map((c) => [c, b[c] ?? null]));
  row.id = id;
  row.fecha = row.fecha || new Date().toISOString().slice(0, 10);
  row.estado = row.estado || 'RECIBIDO';
  row.etapa = row.etapa || 'Recepción y registro';
  row.radicado = id;
  row.es_nuevo = b.esNuevo || b.es_nuevo ? 1 : 0;
  row.icbf_trabaja = b.icbfTrabaja || b.icbf_trabaja ? 1 : 0;
  row.tiene_convenio = b.tieneConvenio || b.tiene_convenio ? 1 : 0;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO solicitudes_afiliacion (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
    Object.entries(b.docsConfirmados || {}).forEach(([docId, ok]) =>
      db.prepare('INSERT INTO solicitud_docs_confirmados (solicitud_id, doc_id, confirmado) VALUES (?,?,?)').run(id, docId, ok ? 1 : 0)
    );
    db.prepare("INSERT INTO solicitud_historial (solicitud_id, fecha, accion, usuario) VALUES (?, date('now'), 'Solicitud recibida vía portal', 'Sistema')").run(id);
  });
  tx();
  res.status(201).json({ id, radicado: id });
});

function solicitudConDetalle(s) {
  const docs = db.prepare('SELECT doc_id, confirmado FROM solicitud_docs_confirmados WHERE solicitud_id=?').all(s.id);
  const docsConfirmados = {};
  docs.forEach((d) => { docsConfirmados[d.doc_id] = !!d.confirmado; });
  return {
    ...s,
    docsConfirmados,
    historial: db.prepare('SELECT * FROM solicitud_historial WHERE solicitud_id=? ORDER BY id').all(s.id),
  };
}

app.get('/api/solicitudes', requireRole('admin', 'tramites'), (req, res) => {
  res.json(db.prepare('SELECT * FROM solicitudes_afiliacion ORDER BY fecha DESC').all().map(solicitudConDetalle));
});

app.put('/api/solicitudes/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['estado','etapa','asignado_a','motivo_rechazo','puntaje','cotizacion_admin','cotizacion_poliza_rc','cotizacion_icbf','cotizacion_total'];
  const present = cols.filter((c) => c in req.body);
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  const tx = db.transaction(() => {
    if (present.length) db.prepare(`UPDATE solicitudes_afiliacion SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
    if (req.body.accion) {
      db.prepare("INSERT INTO solicitud_historial (solicitud_id, fecha, accion, usuario) VALUES (?, date('now'), ?, ?)").run(req.params.id, req.body.accion, usuario);
    }
  });
  tx();
  res.json(solicitudConDetalle(db.prepare('SELECT * FROM solicitudes_afiliacion WHERE id=?').get(req.params.id)));
});

// ───────────────────────── Operaciones: Contratos ─────────────────────────
function contratoConDetalle(k) {
  return {
    ...k,
    productos: db.prepare('SELECT producto, tarifa FROM contrato_productos WHERE contrato_id=?').all(k.id),
    conductorIds: db.prepare('SELECT conductor_id FROM contrato_conductores WHERE contrato_id=?').all(k.id).map((r) => r.conductor_id),
    campos: db.prepare('SELECT nombre, tipo, req, opciones, orden FROM contrato_campos WHERE contrato_id=? ORDER BY orden').all(k.id)
      .map((c) => ({ ...c, opciones: c.opciones ? JSON.parse(c.opciones) : undefined })),
  };
}

app.get('/api/contratos', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM contratos ORDER BY nombre').all().map(contratoConDetalle));
});

app.post('/api/contratos', requireRole('admin', 'operaciones'), (req, res) => {
  const id = req.body.id || newId('k');
  const cols = ['nombre','nit','tipo','estado','valor','logistico_nombre'];
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'Activo';
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO contratos (id, ${cols.join(',')}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`).run(row);
    (req.body.productos || []).forEach((p) => db.prepare('INSERT INTO contrato_productos (contrato_id, producto, tarifa) VALUES (?,?,?)').run(id, p.producto, p.tarifa));
    (req.body.conductorIds || []).forEach((cid) => db.prepare('INSERT INTO contrato_conductores (contrato_id, conductor_id) VALUES (?,?)').run(id, cid));
    (req.body.campos || []).forEach((c, i) => db.prepare('INSERT INTO contrato_campos (contrato_id, nombre, tipo, req, opciones, orden) VALUES (?,?,?,?,?,?)')
      .run(id, c.nombre, c.tipo, c.req ? 1 : 0, c.opciones ? JSON.stringify(c.opciones) : null, i));
  });
  tx();
  res.status(201).json(contratoConDetalle(db.prepare('SELECT * FROM contratos WHERE id=?').get(id)));
});

app.put('/api/contratos/:id', requireRole('admin', 'operaciones'), (req, res) => {
  const cols = ['nombre','nit','tipo','estado','valor','logistico_nombre'];
  const present = cols.filter((c) => c in req.body);
  if (present.length) db.prepare(`UPDATE contratos SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(contratoConDetalle(db.prepare('SELECT * FROM contratos WHERE id=?').get(req.params.id)));
});

// ───────────────────────── Operaciones: Servicios ─────────────────────────
app.get('/api/servicios', requireAuth, (req, res) => {
  let sql = 'SELECT * FROM servicios';
  const params = [];
  if (req.query.fecha) { sql += ' WHERE fecha = ?'; params.push(req.query.fecha); }
  sql += ' ORDER BY fecha, hora';
  res.json(db.prepare(sql).all(...params).map((s) => ({
    ...s,
    origenGeo: s.origen_geo ? JSON.parse(s.origen_geo) : null,
    destinoGeo: s.destino_geo ? JSON.parse(s.destino_geo) : null,
  })));
});

app.post('/api/servicios', requireRole('admin', 'operaciones'), (req, res) => {
  const id = req.body.id || newId('s');
  const cols = ['fecha','hora','contrato_id','producto','vehiculo_id','conductor_id','origen','destino','estado','valor','pax','obs'];
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'Pendiente';
  db.prepare(`INSERT INTO servicios (id, ${cols.join(',')}, origen_geo, destino_geo) VALUES (@id, ${cols.map((c) => '@' + c).join(',')}, @origen_geo, @destino_geo)`)
    .run({ ...row, origen_geo: req.body.origenGeo ? JSON.stringify(req.body.origenGeo) : null, destino_geo: req.body.destinoGeo ? JSON.stringify(req.body.destinoGeo) : null });
  res.status(201).json(db.prepare('SELECT * FROM servicios WHERE id=?').get(id));
});

app.put('/api/servicios/:id', requireRole('admin', 'operaciones'), (req, res) => {
  const cols = ['fecha','hora','contrato_id','producto','vehiculo_id','conductor_id','origen','destino','estado','valor','pax','obs'];
  const present = cols.filter((c) => c in req.body);
  if (present.length) db.prepare(`UPDATE servicios SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(db.prepare('SELECT * FROM servicios WHERE id=?').get(req.params.id));
});

// SPA: cualquier ruta no encontrada devuelve el index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PIG — Trámites disponible en http://localhost:${PORT}`);
});
