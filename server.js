const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Render (y la mayoría de PaaS) terminan TLS en su proxy y reenvían por HTTP interno;
// sin esto, express-session no detecta HTTPS y las cookies "secure" nunca se envían.
if (isProd) app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'pig-multimodal-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8, secure: isProd, sameSite: 'lax' },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// Un '' en un campo de referencia (ej. vehiculo_id) rompe las FK en SQLite —
// SQLite solo aplica el default/NULL de la FK cuando el valor es NULL, no ''.
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    for (const k of Object.keys(req.body)) {
      if (k.endsWith('_id') && req.body[k] === '') req.body[k] = null;
    }
  }
  next();
});

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
  res.json({ id: user.id, nombre: user.nombre, email: user.email, rol: user.rol, firma_url: user.firma_url });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, nombre, email, rol, firma_url FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  res.json(user);
});

app.put('/api/auth/firma', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET firma_url = ? WHERE id = ?').run(req.body.firmaUrl || null, req.session.userId);
  const user = db.prepare('SELECT id, nombre, email, rol, firma_url FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Faltan campos' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 8 caracteres' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.status(204).end();
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
  const docs = db.prepare("SELECT doc_tipo, vencimiento, estado, archivo_url, archivo_nombre FROM documentos WHERE entidad_tipo='vehiculo' AND entidad_id=?").all(v.id);
  const documentos = {};
  docs.forEach((d) => { documentos[d.doc_tipo] = { ven: d.vencimiento, estado: d.estado, archivoUrl: d.archivo_url, archivoNombre: d.archivo_nombre }; });
  const carteraRow = db.prepare('SELECT * FROM cartera WHERE vehiculo_id=?').get(v.id);
  const pagos = db.prepare('SELECT fecha, valor, obs, comprobante_url, comprobante_nombre, registrado_por FROM cartera_pagos WHERE vehiculo_id=? ORDER BY fecha DESC').all(v.id);
  const cartera = carteraRow ? {
    saldo: carteraRow.saldo, estado: carteraRow.estado, ultimoPago: carteraRow.ultimo_pago,
    restriccion: carteraRow.restriccion, restriccionManual: !!carteraRow.restriccion_manual,
    historialRestr: JSON.parse(carteraRow.restriccion_historial || '[]'),
    historialPagos: pagos.map((p) => ({ fecha: p.fecha, valor: p.valor, obs: p.obs, comprobante: p.comprobante_url, comprobanteNombre: p.comprobante_nombre, registradoPor: p.registrado_por })),
  } : null;
  return {
    ...v, documentos, cartera, logHab: JSON.parse(v.log_habilitacion || '[]'),
    propietario: { nombre: v.propietario_nombre, documento: v.propietario_documento, telefono: v.propietario_telefono, email: v.propietario_email },
    convenio: v.convenio_cliente ? { cliente: v.convenio_cliente, vigencia: v.convenio_vigencia, estado: v.convenio_estado } : null,
    fechaVin: v.fecha_vin,
  };
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
  const cols = ['id','placa','clase','marca','linea','modelo','motor','chasis','vin','color','capacidad','combustible','tipo','interno','estado','propietario_nombre','propietario_documento','propietario_telefono','propietario_email','fecha_vin','convenio_cliente','convenio_vigencia','convenio_estado','log_habilitacion','numero_tarjeta_operacion'];
  const row = Object.fromEntries(cols.map((c) => [c, body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'Activo';
  row.log_habilitacion = row.log_habilitacion || '[]';
  db.prepare(`INSERT INTO vehiculos (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row);
  db.prepare('INSERT INTO cartera (vehiculo_id, saldo, estado) VALUES (?, 0, ?)').run(id, 'AL_DIA');
  res.status(201).json(vehiculoConDetalle(db.prepare('SELECT * FROM vehiculos WHERE id=?').get(id)));
});

app.put('/api/vehiculos/:id', requireRole('admin', 'tramites'), (req, res) => {
  const cols = ['placa','clase','marca','linea','modelo','motor','chasis','vin','color','capacidad','combustible','tipo','interno','estado','propietario_nombre','propietario_documento','propietario_telefono','propietario_email','fecha_vin','convenio_cliente','convenio_vigencia','convenio_estado','log_habilitacion','numero_tarjeta_operacion'];
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
  const existing = db.prepare("SELECT vencimiento, estado, archivo_url, archivo_nombre FROM documentos WHERE entidad_tipo='vehiculo' AND entidad_id=? AND doc_tipo=?").get(req.params.id, req.params.docTipo);
  const b = req.body || {};
  const vencimiento = 'vencimiento' in b ? b.vencimiento : existing?.vencimiento ?? null;
  const estado = 'estado' in b ? b.estado : existing?.estado ?? 'PENDIENTE';
  const archivoUrl = 'archivoUrl' in b ? b.archivoUrl : existing?.archivo_url ?? null;
  const archivoNombre = 'archivoNombre' in b ? b.archivoNombre : existing?.archivo_nombre ?? null;
  db.prepare(`INSERT INTO documentos (entidad_tipo, entidad_id, doc_tipo, vencimiento, estado, archivo_url, archivo_nombre, updated_at)
    VALUES ('vehiculo', ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entidad_tipo, entidad_id, doc_tipo) DO UPDATE SET vencimiento=excluded.vencimiento, estado=excluded.estado, archivo_url=excluded.archivo_url, archivo_nombre=excluded.archivo_nombre, updated_at=datetime('now')`)
    .run(req.params.id, req.params.docTipo, vencimiento, estado, archivoUrl, archivoNombre);
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
  const { restriccion, restriccion_manual, historialRestrEntry } = req.body || {};
  const tx = db.transaction(() => {
    if (historialRestrEntry) {
      const cur = db.prepare('SELECT restriccion_historial FROM cartera WHERE vehiculo_id=?').get(req.params.vehiculoId);
      const hist = JSON.parse(cur?.restriccion_historial || '[]');
      hist.push(historialRestrEntry);
      db.prepare('UPDATE cartera SET restriccion_historial = ? WHERE vehiculo_id = ?').run(JSON.stringify(hist), req.params.vehiculoId);
    }
    if (restriccion !== undefined || restriccion_manual !== undefined) {
      db.prepare('UPDATE cartera SET restriccion = COALESCE(?, restriccion), restriccion_manual = COALESCE(?, restriccion_manual) WHERE vehiculo_id = ?')
        .run(restriccion ?? null, restriccion_manual ?? null, req.params.vehiculoId);
    }
  });
  tx();
  const row = db.prepare('SELECT * FROM cartera WHERE vehiculo_id = ?').get(req.params.vehiculoId);
  res.json({ ...row, restriccionManual: !!row.restriccion_manual, historialRestr: JSON.parse(row.restriccion_historial || '[]') });
});

app.get('/api/cartera/:vehiculoId/pagos', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM cartera_pagos WHERE vehiculo_id = ? ORDER BY fecha DESC').all(req.params.vehiculoId));
});

app.post('/api/cartera/:vehiculoId/pagos', requireRole('admin', 'tramites'), (req, res) => {
  const { fecha, valor, obs, comprobanteUrl, comprobanteNombre } = req.body || {};
  if (!fecha || !valor) return res.status(400).json({ error: 'fecha y valor son requeridos' });
  const registradoPor = db.prepare('SELECT nombre FROM users WHERE id = ?').get(req.session.userId)?.nombre;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO cartera_pagos (vehiculo_id, fecha, valor, obs, comprobante_url, comprobante_nombre, registrado_por) VALUES (?,?,?,?,?,?,?)')
      .run(req.params.vehiculoId, fecha, valor, obs || null, comprobanteUrl || null, comprobanteNombre || null, registradoPor);
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
  const docs = db.prepare("SELECT doc_tipo, vencimiento, estado, archivo_url, archivo_nombre FROM documentos WHERE entidad_tipo='conductor' AND entidad_id=?").all(c.id);
  const docsObj = {};
  docs.forEach((d) => { docsObj[d.doc_tipo] = { ven: d.vencimiento, est: d.estado, archivoUrl: d.archivo_url, archivoNombre: d.archivo_nombre }; });
  const segHist = db.prepare('SELECT mes, fecha, estado as est, archivo_url as archivoUrl, archivo_nombre as archivoNombre FROM conductor_seg_social_historial WHERE conductor_id=? ORDER BY fecha DESC').all(c.id);
  const { password_hash, ...cSinHash } = c;
  return { ...cSinHash, docs: docsObj, segHist, vehiculo: c.vehiculo_id, vencLic: c.venc_licencia, fechaVin: c.fecha_vin, activo: !!c.activo, portalActivo: !!password_hash };
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
  const existing = db.prepare("SELECT vencimiento, estado, archivo_url, archivo_nombre FROM documentos WHERE entidad_tipo='conductor' AND entidad_id=? AND doc_tipo=?").get(req.params.id, req.params.docTipo);
  const b = req.body || {};
  const vencimiento = 'vencimiento' in b ? b.vencimiento : existing?.vencimiento ?? null;
  const estado = 'estado' in b ? b.estado : existing?.estado ?? 'PENDIENTE';
  const archivoUrl = 'archivoUrl' in b ? b.archivoUrl : existing?.archivo_url ?? null;
  const archivoNombre = 'archivoNombre' in b ? b.archivoNombre : existing?.archivo_nombre ?? null;
  db.prepare(`INSERT INTO documentos (entidad_tipo, entidad_id, doc_tipo, vencimiento, estado, archivo_url, archivo_nombre, updated_at)
    VALUES ('conductor', ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entidad_tipo, entidad_id, doc_tipo) DO UPDATE SET vencimiento=excluded.vencimiento, estado=excluded.estado, archivo_url=excluded.archivo_url, archivo_nombre=excluded.archivo_nombre, updated_at=datetime('now')`)
    .run(req.params.id, req.params.docTipo, vencimiento, estado, archivoUrl, archivoNombre);
  res.json(conductorConDetalle(db.prepare('SELECT * FROM conductores WHERE id=?').get(req.params.id)));
});

app.post('/api/conductores/:id/seg-social', requireRole('admin', 'tramites'), (req, res) => {
  const { mes, fecha, estado, archivoUrl, archivoNombre } = req.body || {};
  if (!mes) return res.status(400).json({ error: 'mes es requerido' });
  db.prepare(`INSERT INTO conductor_seg_social_historial (conductor_id, mes, fecha, estado, archivo_url, archivo_nombre)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(conductor_id, mes) DO UPDATE SET fecha=excluded.fecha, estado=excluded.estado, archivo_url=excluded.archivo_url, archivo_nombre=excluded.archivo_nombre`)
    .run(req.params.id, mes, fecha || null, estado || 'REPORTADO', archivoUrl || null, archivoNombre || null);
  res.status(201).json(conductorConDetalle(db.prepare('SELECT * FROM conductores WHERE id=?').get(req.params.id)));
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
function opContratoConDetalle(k) {
  return {
    ...k,
    productos: db.prepare('SELECT producto, tarifa FROM contrato_productos WHERE contrato_id=?').all(k.id),
    conductorIds: db.prepare('SELECT conductor_id FROM contrato_conductores WHERE contrato_id=?').all(k.id).map((r) => r.conductor_id),
    campos: db.prepare('SELECT id, nombre, tipo, req, opciones, orden FROM contrato_campos WHERE contrato_id=? ORDER BY orden').all(k.id)
      .map((c) => ({ ...c, opciones: c.opciones ? JSON.parse(c.opciones) : undefined })),
  };
}

app.get('/api/contratos', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM contratos ORDER BY nombre').all().map(opContratoConDetalle));
});

app.post('/api/contratos', requireRole('admin', 'operaciones'), (req, res) => {
  const id = req.body.id || newId('k');
  const cols = ['nombre','nit','tipo','estado','valor','logistico_nombre','contacto_negociador','contacto_contable','consideraciones_operativas','consideraciones_contables','consideraciones_comerciales'];
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
  res.status(201).json(opContratoConDetalle(db.prepare('SELECT * FROM contratos WHERE id=?').get(id)));
});

app.put('/api/contratos/:id', requireRole('admin', 'operaciones'), (req, res) => {
  const cols = ['nombre','nit','tipo','estado','valor','logistico_nombre','contacto_negociador','contacto_contable','consideraciones_operativas','consideraciones_contables','consideraciones_comerciales'];
  const present = cols.filter((c) => c in req.body);
  if (present.length) db.prepare(`UPDATE contratos SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(opContratoConDetalle(db.prepare('SELECT * FROM contratos WHERE id=?').get(req.params.id)));
});

// Campos personalizados del formulario de servicios de este contrato (además de los campos por
// defecto del formulario). Los diseña Operaciones — para un contrato vinculado a un cliente de
// Comercial (extracto_cliente_id), guardar aquí marca el formulario de ese cliente como diseñado.
app.put('/api/contratos/:id/campos', requireRole('admin', 'operaciones'), (req, res) => {
  const contrato = db.prepare('SELECT * FROM contratos WHERE id=?').get(req.params.id);
  if (!contrato) return res.status(404).json({ error: 'No encontrado' });
  const campos = Array.isArray(req.body.campos) ? req.body.campos : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM contrato_campos WHERE contrato_id=?').run(req.params.id);
    const ins = db.prepare('INSERT INTO contrato_campos (contrato_id, nombre, tipo, req, opciones, orden) VALUES (?,?,?,?,?,?)');
    campos.forEach((c, i) => ins.run(req.params.id, c.nombre, c.tipo, c.req ? 1 : 0, c.opciones ? JSON.stringify(c.opciones) : null, i));
    if (contrato.extracto_cliente_id) {
      db.prepare('UPDATE extracto_clientes SET formulario_disenado=1 WHERE id=?').run(contrato.extracto_cliente_id);
    }
  });
  tx();
  res.json(opContratoConDetalle(db.prepare('SELECT * FROM contratos WHERE id=?').get(req.params.id)));
});

// ───────────────────────── Operaciones: Servicios ─────────────────────────
function servicioConDetalle(s) {
  return {
    ...s,
    origenGeo: s.origen_geo ? JSON.parse(s.origen_geo) : null,
    destinoGeo: s.destino_geo ? JSON.parse(s.destino_geo) : null,
    campos: s.campos ? JSON.parse(s.campos) : {},
    liquidacion: s.liquidacion ? JSON.parse(s.liquidacion) : null,
    usuarios: s.usuarios ? JSON.parse(s.usuarios) : [],
    historial: s.historial ? JSON.parse(s.historial) : [],
  };
}
// DD/MM/AA-NNN, NNN consecutivo dentro de los servicios ya agendados para esa misma fecha.
function numeroServicio(fecha) {
  const [y, m, d] = fecha.split('-');
  const n = db.prepare('SELECT COUNT(*) n FROM servicios WHERE fecha=?').get(fecha).n + 1;
  return `${d}/${m}/${y.slice(2)}-${String(n).padStart(3, '0')}`;
}
function actorNombre(req) {
  if (req.session.conductorId) {
    return db.prepare('SELECT nombre FROM conductores WHERE id=?').get(req.session.conductorId)?.nombre || 'Conductor';
  }
  return db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre || 'Sistema';
}
function agregarHistorial(id, entrada) {
  const s = db.prepare('SELECT historial FROM servicios WHERE id=?').get(id);
  const hist = s && s.historial ? JSON.parse(s.historial) : [];
  hist.push({ fecha: new Date().toISOString(), ...entrada });
  db.prepare('UPDATE servicios SET historial=? WHERE id=?').run(JSON.stringify(hist), id);
}
app.get('/api/servicios', requireAuth, (req, res) => {
  let sql = 'SELECT * FROM servicios';
  const params = [];
  if (req.query.fecha) { sql += ' WHERE fecha = ?'; params.push(req.query.fecha); }
  sql += ' ORDER BY fecha, hora';
  res.json(db.prepare(sql).all(...params).map(servicioConDetalle));
});

app.post('/api/servicios', requireRole('admin', 'operaciones'), (req, res) => {
  const id = req.body.id || newId('s');
  const cols = ['fecha','hora','contrato_id','producto','vehiculo_id','conductor_id','origen','destino','estado','valor','pax','obs','ventana_ruta','referencia'];
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.estado = row.estado || 'Creado';
  row.numero = req.body.numero || numeroServicio(row.fecha);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO servicios (id, numero, ${cols.join(',')}, origen_geo, destino_geo, campos, usuarios) VALUES (@id, @numero, ${cols.map((c) => '@' + c).join(',')}, @origen_geo, @destino_geo, @campos, @usuarios)`)
      .run({ ...row, origen_geo: req.body.origenGeo ? JSON.stringify(req.body.origenGeo) : null, destino_geo: req.body.destinoGeo ? JSON.stringify(req.body.destinoGeo) : null, campos: req.body.campos ? JSON.stringify(req.body.campos) : null, usuarios: req.body.usuarios ? JSON.stringify(req.body.usuarios) : null });
    agregarHistorial(id, { usuario: actorNombre(req), accion: 'Servicio creado', detalle: `Estado inicial: ${row.estado}` });
  });
  tx();
  res.status(201).json(servicioConDetalle(db.prepare('SELECT * FROM servicios WHERE id=?').get(id)));
});

app.put('/api/servicios/:id', requireRole('admin', 'operaciones'), (req, res) => {
  const cols = ['fecha','hora','contrato_id','producto','vehiculo_id','conductor_id','origen','destino','estado','valor','pax','obs','ventana_ruta','referencia'];
  const present = cols.filter((c) => c in req.body);
  const body = { ...req.body, id: req.params.id };
  if ('campos' in req.body) { present.push('campos'); body.campos = req.body.campos ? JSON.stringify(req.body.campos) : null; }
  if ('usuarios' in req.body) { present.push('usuarios'); body.usuarios = req.body.usuarios ? JSON.stringify(req.body.usuarios) : null; }
  if ('liquidacion' in req.body) { present.push('liquidacion'); body.liquidacion = req.body.liquidacion ? JSON.stringify(req.body.liquidacion) : null; }
  const tx = db.transaction(() => {
    if (present.length) db.prepare(`UPDATE servicios SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run(body);
    if ('estado' in req.body) {
      agregarHistorial(req.params.id, { usuario: actorNombre(req), accion: `Cambió estado a: ${req.body.estado}`, detalle: req.body.vehiculo_id ? `Vehículo/conductor asignado` : '' });
    } else if (present.length) {
      agregarHistorial(req.params.id, { usuario: actorNombre(req), accion: 'Editó el servicio', detalle: present.filter(c => c !== 'campos' && c !== 'usuarios').join(', ') });
    }
  });
  tx();
  res.json(servicioConDetalle(db.prepare('SELECT * FROM servicios WHERE id=?').get(req.params.id)));
});

// ───────────────────────── Portal Conductor ─────────────────────────
// Login propio del conductor (sesión separada de la de personal PIG — ver requireConductor). La
// cédula (ya única en `conductores`) hace de usuario; la contraseña la activa Trámites/Operaciones
// vía POST /api/conductores/:id/set-password. Mientras un conductor no tenga password_hash, no
// puede iniciar sesión en el portal aunque esté activo.
function requireConductor(req, res, next) {
  if (!req.session.conductorId) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function conductorPublico(c) {
  if (!c) return null;
  const { password_hash, ...pub } = c;
  return pub;
}
// La cédula guardada en `conductores` suele traer un prefijo de tipo de documento (ej. "CC-71890234",
// ver la data de ejemplo en database.js) que el conductor no necesariamente conoce o escribe igual —
// el login compara solo los dígitos de ambos lados para que "71890234" también entre.
function soloDigitos(s) { return String(s || '').replace(/\D/g, ''); }
app.post('/api/conductor-auth/login', (req, res) => {
  const { cedula, password } = req.body || {};
  if (!cedula || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  const digitos = soloDigitos(cedula);
  const conductor = digitos
    ? db.prepare('SELECT * FROM conductores WHERE activo = 1').all().find(c => soloDigitos(c.cedula) === digitos)
    : null;
  if (!conductor || !conductor.password_hash || !bcrypt.compareSync(password, conductor.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  req.session.conductorId = conductor.id;
  res.json(conductorPublico(conductor));
});
app.post('/api/conductor-auth/logout', (req, res) => {
  req.session.conductorId = null;
  res.status(204).end();
});
app.get('/api/conductor-auth/me', requireConductor, (req, res) => {
  const conductor = db.prepare('SELECT * FROM conductores WHERE id = ?').get(req.session.conductorId);
  if (!conductor) return res.status(401).json({ error: 'No autenticado' });
  res.json(conductorPublico(conductor));
});
// Activar/restablecer el acceso de un conductor al portal — lo hace personal de Trámites u
// Operaciones (el conductor no se autorregistra); comunican la contraseña al conductor fuera de la
// plataforma, igual que con cualquier credencial inicial.
app.post('/api/conductores/:id/set-password', requireRole('admin', 'tramites', 'operaciones'), (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const conductor = db.prepare('SELECT * FROM conductores WHERE id = ?').get(req.params.id);
  if (!conductor) return res.status(404).json({ error: 'No encontrado' });
  db.prepare('UPDATE conductores SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.status(204).end();
});

// Estados que el propio conductor puede activar desde el portal, y desde cuáles puede hacerlo —
// distinto del flujo de Operaciones (que asigna/liquida): el conductor solo confirma su propio
// recorrido, y puede rechazar una asignación antes de aceptarla.
const ESTADO_TRANSICIONES_CONDUCTOR = {
  'Asignado': ['Aceptado', 'Rechazado'],
  'Aceptado': ['En Ruta'],
  'En Ruta': ['En Sitio'],
  'En Sitio': ['Realizando'],
  'Realizando': ['Finalizado'],
};
app.get('/api/conductor/servicios', requireConductor, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, k.nombre AS cliente_nombre
    FROM servicios s LEFT JOIN contratos k ON k.id = s.contrato_id
    WHERE s.conductor_id = ?
    ORDER BY s.fecha, s.hora
  `).all(req.session.conductorId);
  res.json(rows.map(servicioConDetalle));
});
app.put('/api/conductor/servicios/:id/estado', requireConductor, (req, res) => {
  const nuevoEstado = req.body && req.body.estado;
  const servicio = db.prepare('SELECT * FROM servicios WHERE id = ?').get(req.params.id);
  if (!servicio) return res.status(404).json({ error: 'No encontrado' });
  if (servicio.conductor_id !== req.session.conductorId) return res.status(403).json({ error: 'Este servicio no está asignado a tu usuario' });
  const permitidos = ESTADO_TRANSICIONES_CONDUCTOR[servicio.estado] || [];
  if (!permitidos.includes(nuevoEstado)) return res.status(400).json({ error: `No puedes pasar de "${servicio.estado}" a "${nuevoEstado}"` });
  const tx = db.transaction(() => {
    db.prepare('UPDATE servicios SET estado = ? WHERE id = ?').run(nuevoEstado, req.params.id);
    const accion = nuevoEstado === 'Rechazado' ? 'El conductor rechazó el servicio' : `Cambió estado a: ${nuevoEstado}`;
    agregarHistorial(req.params.id, { usuario: actorNombre(req), accion, detalle: nuevoEstado === 'Rechazado' ? 'Requiere reasignación de conductor/vehículo' : '' });
  });
  tx();
  res.json(servicioConDetalle(db.prepare('SELECT * FROM servicios WHERE id=?').get(req.params.id)));
});

// ───────────────────── Liquidación: órdenes de aprobación y de pago ─────────────────────
// Ver el esquema en database.js para el porqué de guardar cada ítem como snapshot en vez de una FK
// a servicios.id (los servicios liquidados pueden venir del store de demostración del frontend, que
// no vive en esta base de datos). El servidor confía en los valores que ya trae cada ítem (se
// calcularon en el frontend con los mismos datos de tarifario/vehículo que ya tiene cargados) y solo
// se encarga de la persistencia, los totales, y las transiciones de estado del flujo de aprobación.
function ordenAprobacionConItems(orden) {
  if (!orden) return orden;
  const items = db.prepare('SELECT * FROM orden_aprobacion_items WHERE orden_id=? ORDER BY id').all(orden.id)
    .map(it => ({ ...it, snapshot: JSON.parse(it.snapshot) }));
  return { ...orden, totales: orden.totales ? JSON.parse(orden.totales) : null, items };
}
function ordenPagoConItems(op) {
  if (!op) return op;
  const items = db.prepare("SELECT * FROM orden_aprobacion_items WHERE orden_id=? AND estado IN ('Aprobado','Autorizado','Devuelto') ORDER BY id").all(op.orden_aprobacion_id)
    .map(it => ({ ...it, snapshot: JSON.parse(it.snapshot) }));
  return { ...op, items };
}

app.post('/api/liquidacion/ordenes', requireRole('admin', 'operaciones'), (req, res) => {
  const { contratoId, clienteNombre, fechaDesde, fechaHasta, items, totales } = req.body || {};
  if (!clienteNombre || !fechaDesde || !fechaHasta || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Faltan datos de la orden (cliente, rango de fechas o ítems)' });
  }
  const id = newId('oa');
  const numero = `OA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${id.slice(-4)}`;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO ordenes_aprobacion (id, numero, contrato_id, cliente_nombre, fecha_desde, fecha_hasta, totales, creado_por)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, numero, contratoId || null, clienteNombre, fechaDesde, fechaHasta, JSON.stringify(totales || {}), actorNombre(req));
    const ins = db.prepare('INSERT INTO orden_aprobacion_items (orden_id, servicio_id, servicio_numero, snapshot) VALUES (?,?,?,?)');
    items.forEach(it => ins.run(id, it.servicioId, it.servicioNumero || it.servicioId, JSON.stringify(it)));
  });
  tx();
  res.status(201).json(ordenAprobacionConItems(db.prepare('SELECT * FROM ordenes_aprobacion WHERE id=?').get(id)));
});

app.get('/api/liquidacion/ordenes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM ordenes_aprobacion ORDER BY creado_en DESC').all();
  const conteo = db.prepare('SELECT id FROM ordenes_aprobacion').all().length
    ? db.prepare(`SELECT orden_id, estado, COUNT(*) n FROM orden_aprobacion_items GROUP BY orden_id, estado`).all()
    : [];
  res.json(rows.map(o => {
    const c = { Pendiente: 0, Aprobado: 0, Devuelto: 0, Autorizado: 0 };
    conteo.filter(x => x.orden_id === o.id).forEach(x => { c[x.estado] = x.n; });
    return { ...o, totales: o.totales ? JSON.parse(o.totales) : null, conteoItems: c };
  }));
});
app.get('/api/liquidacion/ordenes/:id', requireAuth, (req, res) => {
  const orden = db.prepare('SELECT * FROM ordenes_aprobacion WHERE id=?').get(req.params.id);
  if (!orden) return res.status(404).json({ error: 'No encontrada' });
  res.json(ordenAprobacionConItems(orden));
});

// El Director de Operaciones decide, ítem por ítem: lo que aprueba pasa a integrar (o crea) la
// orden de pago de Contabilidad; lo que devuelve queda marcado con el motivo para que la logística
// que envió la orden lo vea y corrija — el resto de la orden sigue su curso normalmente.
app.put('/api/liquidacion/ordenes/:id/decidir', requireRole('admin', 'director_operaciones'), (req, res) => {
  const orden = db.prepare('SELECT * FROM ordenes_aprobacion WHERE id=?').get(req.params.id);
  if (!orden) return res.status(404).json({ error: 'No encontrada' });
  const aprobarItems = Array.isArray(req.body?.aprobarItems) ? req.body.aprobarItems : [];
  const devolverItems = Array.isArray(req.body?.devolverItems) ? req.body.devolverItems : [];
  if (!aprobarItems.length && !devolverItems.length) return res.status(400).json({ error: 'No se marcó ningún ítem para aprobar o devolver' });
  const actor = actorNombre(req);
  const tx = db.transaction(() => {
    aprobarItems.forEach(itemId => {
      db.prepare("UPDATE orden_aprobacion_items SET estado='Aprobado' WHERE id=? AND orden_id=? AND estado='Pendiente'").run(itemId, orden.id);
    });
    devolverItems.forEach(({ id: itemId, motivo }) => {
      db.prepare("UPDATE orden_aprobacion_items SET estado='Devuelto', devuelto_por=?, devuelto_etapa='Director', motivo_devolucion=? WHERE id=? AND orden_id=? AND estado='Pendiente'")
        .run(actor, motivo || '', itemId, orden.id);
    });
    const pendientes = db.prepare("SELECT COUNT(*) n FROM orden_aprobacion_items WHERE orden_id=? AND estado='Pendiente'").get(orden.id).n;
    const aprobados = db.prepare("SELECT COUNT(*) n FROM orden_aprobacion_items WHERE orden_id=? AND estado='Aprobado'").get(orden.id).n;
    if (pendientes === 0) {
      const nuevoEstado = aprobados > 0 ? 'Revisada' : 'Devuelta';
      db.prepare('UPDATE ordenes_aprobacion SET estado=?, revisado_por=?, revisado_en=datetime(\'now\') WHERE id=?').run(nuevoEstado, actor, orden.id);
    }
    if (aprobados > 0) {
      const yaExiste = db.prepare('SELECT id FROM ordenes_pago WHERE orden_aprobacion_id=?').get(orden.id);
      if (!yaExiste) {
        const opId = newId('op');
        const numero = `OP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${opId.slice(-4)}`;
        db.prepare('INSERT INTO ordenes_pago (id, numero, orden_aprobacion_id) VALUES (?,?,?)').run(opId, numero, orden.id);
      }
    }
  });
  tx();
  res.json(ordenAprobacionConItems(db.prepare('SELECT * FROM ordenes_aprobacion WHERE id=?').get(orden.id)));
});

app.get('/api/contabilidad/ordenes-pago', requireRole('admin', 'gerente', 'director_operaciones'), (req, res) => {
  const rows = db.prepare(`
    SELECT op.*, oa.numero AS orden_aprobacion_numero, oa.cliente_nombre, oa.fecha_desde, oa.fecha_hasta
    FROM ordenes_pago op JOIN ordenes_aprobacion oa ON oa.id = op.orden_aprobacion_id
    ORDER BY op.creado_en DESC
  `).all();
  const conteo = db.prepare(`
    SELECT oai.orden_id, oai.estado, COUNT(*) n, SUM(json_extract(oai.snapshot,'$.valorProveedor')) total
    FROM orden_aprobacion_items oai
    WHERE oai.estado IN ('Aprobado','Autorizado','Devuelto')
    GROUP BY oai.orden_id, oai.estado
  `).all();
  res.json(rows.map(op => {
    const c = { Aprobado: { n: 0, total: 0 }, Autorizado: { n: 0, total: 0 }, Devuelto: { n: 0, total: 0 } };
    conteo.filter(x => x.orden_id === op.orden_aprobacion_id).forEach(x => { c[x.estado] = { n: x.n, total: x.total || 0 }; });
    return { ...op, conteoItems: c };
  }));
});
app.get('/api/contabilidad/ordenes-pago/:id', requireRole('admin', 'gerente', 'director_operaciones'), (req, res) => {
  const op = db.prepare(`
    SELECT op.*, oa.numero AS orden_aprobacion_numero, oa.cliente_nombre, oa.fecha_desde, oa.fecha_hasta
    FROM ordenes_pago op JOIN ordenes_aprobacion oa ON oa.id = op.orden_aprobacion_id
    WHERE op.id=?
  `).get(req.params.id);
  if (!op) return res.status(404).json({ error: 'No encontrada' });
  res.json(ordenPagoConItems(op));
});
// Gerencia da (o niega) el V°B° final: lo que no se devuelve queda "Autorizado" — listo para que
// Contabilidad descargue el archivo plano de pago — y lo que se devuelve va con motivo a la
// logística que armó la orden original, sin descartar el resto de la orden de pago.
app.put('/api/contabilidad/ordenes-pago/:id/decidir', requireRole('admin', 'gerente'), (req, res) => {
  const op = db.prepare('SELECT * FROM ordenes_pago WHERE id=?').get(req.params.id);
  if (!op) return res.status(404).json({ error: 'No encontrada' });
  if (op.estado !== 'Pdte. V°B° Gerencia') return res.status(400).json({ error: 'Esta orden de pago ya fue decidida' });
  const devolverItems = Array.isArray(req.body?.devolverItems) ? req.body.devolverItems : [];
  const actor = actorNombre(req);
  const tx = db.transaction(() => {
    devolverItems.forEach(({ id: itemId, motivo }) => {
      db.prepare("UPDATE orden_aprobacion_items SET estado='Devuelto', devuelto_por=?, devuelto_etapa='Gerencia', motivo_devolucion=? WHERE id=? AND orden_id=? AND estado='Aprobado'")
        .run(actor, motivo || '', itemId, op.orden_aprobacion_id);
    });
    db.prepare("UPDATE orden_aprobacion_items SET estado='Autorizado' WHERE orden_id=? AND estado='Aprobado'").run(op.orden_aprobacion_id);
    const autorizados = db.prepare("SELECT COUNT(*) n FROM orden_aprobacion_items WHERE orden_id=? AND estado='Autorizado'").get(op.orden_aprobacion_id).n;
    const nuevoEstado = autorizados > 0 ? 'Aprobada' : 'Devuelta';
    db.prepare('UPDATE ordenes_pago SET estado=?, aprobado_por=?, aprobado_en=datetime(\'now\') WHERE id=?').run(nuevoEstado, actor, op.id);
  });
  tx();
  const opActualizada = db.prepare(`
    SELECT op.*, oa.numero AS orden_aprobacion_numero, oa.cliente_nombre, oa.fecha_desde, oa.fecha_hasta
    FROM ordenes_pago op JOIN ordenes_aprobacion oa ON oa.id = op.orden_aprobacion_id
    WHERE op.id=?
  `).get(op.id);
  res.json(ordenPagoConItems(opActualizada));
});

// Genera el extracto de un servicio puntual ya ejecutado/asignado, sin pedir datos adicionales —
// todo (vehículo, conductor, ruta, fecha) sale del propio servicio. Pensado para que lo dispare
// quien esté a cargo del servicio (ej. el conductor) con un solo clic. Solo aplica a servicios de
// clientes reales de Comercial (con contrato aprobado y tarifario) — ver docs/BACKEND_DESIGN.md §9/§10.
app.post('/api/servicios/:id/generar-extracto', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servicios WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Servicio no encontrado' });
  if (s.extracto_id) return res.status(422).json({ error: 'Este servicio ya tiene un extracto generado' });
  if (!s.vehiculo_id || !s.conductor_id) return res.status(422).json({ error: 'El servicio no tiene vehículo y conductor asignados' });
  const opContrato = s.contrato_id && db.prepare('SELECT * FROM contratos WHERE id=?').get(s.contrato_id);
  if (!opContrato || !opContrato.extracto_cliente_id) {
    return res.status(422).json({ error: 'Este servicio no está vinculado a un cliente de Comercial' });
  }
  const contrato = db.prepare("SELECT * FROM extracto_contratos WHERE cliente_id=? AND estado='APROBADO' ORDER BY created_at DESC").get(opContrato.extracto_cliente_id);
  if (!contrato) return res.status(422).json({ error: 'Cliente no autorizado' });
  const tarifarioItem = db.prepare(
    'SELECT * FROM tarifario_items WHERE cliente_id=? AND tipo_servicio=? AND IFNULL(origen,\'\')=IFNULL(?,\'\') AND IFNULL(destino,\'\')=IFNULL(?,\'\')'
  ).get(opContrato.extracto_cliente_id, s.producto, s.origen, s.destino);
  if (!tarifarioItem) return res.status(422).json({ error: 'Ruta no autorizada' });
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  const result = crearExtracto({
    contratoId: contrato.id, vehiculoId: s.vehiculo_id, conductorIds: [s.conductor_id],
    tarifarioItemId: tarifarioItem.id, fechaInicio: s.fecha, fechaFin: s.fecha,
    generadoPorTipo: 'AFILIADO', usuario, viaServicio: true,
  });
  if (result.error) return res.status(422).json({ error: result.error });
  db.prepare('UPDATE servicios SET extracto_id=? WHERE id=?').run(result.id, s.id);
  res.status(201).json(extractoConDetalle(db.prepare('SELECT * FROM extractos WHERE id=?').get(result.id)));
});

// ───────────────────────── Extractos (FUEC) — Resolución 6652/2019 Mintransporte ─────────────────────────
// Ver docs/BACKEND_DESIGN.md §8 para el detalle normativo completo.

function generarNumeroFuec(numeroContrato, numeroExtracto) {
  const cfg = db.prepare('SELECT * FROM extracto_config WHERE id = 1').get();
  const anioExtracto = String(new Date().getFullYear());
  const pad = (v, n) => String(v).padStart(n, '0').slice(-n);
  return (
    pad(cfg.codigo_territorial, 3) +
    pad(cfg.numero_resolucion_habilitacion, 4) +
    pad(cfg.anio_habilitacion, 2) +
    anioExtracto +
    pad(numeroContrato, 4) +
    pad(numeroExtracto, 4)
  );
}

function docVigenteEn(doc, fecha) {
  if (!doc || !doc.ven) return false;
  return doc.ven >= fecha;
}

// Devuelve null si puede generarse, o el mensaje de bloqueo específico (nunca genérico,
// tal como exige el documento de proceso) si no.
function validarGeneracionExtracto({ contrato, cliente, tarifarioItem, vehiculo, conductores, fechaInicio, fechaFin, generadoPorTipo, viaServicio }) {
  if (!contrato) return 'Contrato vencido';
  if (contrato.estado !== 'APROBADO') return 'Cliente no autorizado';
  if (fechaInicio < contrato.fecha_inicio || fechaFin > contrato.fecha_fin) return 'Contrato vencido';
  if (contrato.requiere_convenio && !contrato.convenio_colaboracion) return 'Convenio inexistente';
  // La ruta/tipo de servicio la valida el tarifario del cliente (Comercial), no el contrato: un
  // contrato puede tener cualquier cantidad de rutas tarifadas — ver docs/BACKEND_DESIGN.md §9.
  if (!tarifarioItem) return 'Ruta no autorizada';

  if (generadoPorTipo === 'AFILIADO') {
    // Un afiliado generando manualmente no puede tocar clientes ICBF/corporativos — pero generar
    // el extracto de un servicio puntual ya asignado y tarifado por la empresa (viaServicio) es
    // completar el papeleo de una operación que la empresa ya autorizó, no lo mismo.
    if (!viaServicio && (cliente.es_icbf || cliente.es_corporativo)) return 'Cliente no autorizado';
    // La mora sí bloquea siempre que el canal sea el afiliado, sin importar el tipo de cliente:
    // si no ha pagado administración, no puede generar extractos aunque todo lo demás esté aprobado.
    const cartera = db.prepare('SELECT saldo FROM cartera WHERE vehiculo_id = ?').get(vehiculo.id);
    if (cartera && cartera.saldo > 0) return 'Mora del afiliado';
  }

  const docsVeh = { soat: 'SOAT vencido', rtm: 'Revisión técnico-mecánica vencida', to: 'Tarjeta de operación vencida' };
  for (const [tipo, msg] of Object.entries(docsVeh)) {
    if (!docVigenteEn(vehiculo.documentos[tipo], fechaFin)) return msg;
  }

  const docsCond = { licencia: 'Licencia de conducción vencida', examenMedico: 'Examen médico vencido', segSocial: 'Seguridad social vencida' };
  const cfg = db.prepare('SELECT tolerancia_mant_defensivo_dias FROM extracto_config WHERE id=1').get();
  for (const cond of conductores) {
    for (const [tipo, msg] of Object.entries(docsCond)) {
      if (!docVigenteEn(cond.docs[tipo], fechaFin)) return msg;
    }
    const md = cond.docs.mantDefensivo;
    if (!md || !md.ven) return 'Certificado de manejo defensivo vencido';
    const limite = new Date(md.ven + 'T00:00:00');
    limite.setDate(limite.getDate() + (cfg?.tolerancia_mant_defensivo_dias ?? 10));
    if (new Date(fechaFin + 'T00:00:00') > limite) return 'Certificado de manejo defensivo vencido';
  }
  return null;
}

// Config (numeración FUEC)
app.get('/api/extracto-config', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM extracto_config WHERE id = 1').get());
});
app.put('/api/extracto-config', requireRole('admin'), (req, res) => {
  const cols = ['codigo_territorial', 'numero_resolucion_habilitacion', 'anio_habilitacion', 'tolerancia_mant_defensivo_dias'];
  const present = cols.filter((c) => c in req.body);
  if (present.length) {
    db.prepare(`UPDATE extracto_config SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id = 1`).run(req.body);
  }
  res.json(db.prepare('SELECT * FROM extracto_config WHERE id = 1').get());
});

// Clientes
app.get('/api/extractos/clientes', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM extracto_clientes ORDER BY nombre').all());
});
app.post('/api/extractos/clientes', requireRole('admin', 'tramites', 'comercial'), (req, res) => {
  const id = req.body.id || newId('ecl');
  const cols = ['nombre', 'documento', 'direccion', 'telefono', 'email'];
  const row = Object.fromEntries(cols.map((c) => [c, req.body[c] ?? null]));
  row.id = id;
  row.es_icbf = req.body.es_icbf ? 1 : 0;
  row.es_corporativo = req.body.es_corporativo ? 1 : 0;
  db.prepare(`INSERT INTO extracto_clientes (id, ${cols.join(',')}, es_icbf, es_corporativo) VALUES (@id, ${cols.map((c) => '@' + c).join(',')}, @es_icbf, @es_corporativo)`).run(row);
  res.status(201).json(db.prepare('SELECT * FROM extracto_clientes WHERE id=?').get(id));
});
app.put('/api/extractos/clientes/:id', requireRole('admin', 'tramites', 'comercial'), (req, res) => {
  const cols = ['nombre', 'documento', 'direccion', 'telefono', 'email'];
  const present = cols.filter((c) => c in req.body);
  const body = { ...req.body, id: req.params.id };
  if ('es_icbf' in req.body) { present.push('es_icbf'); body.es_icbf = req.body.es_icbf ? 1 : 0; }
  if ('es_corporativo' in req.body) { present.push('es_corporativo'); body.es_corporativo = req.body.es_corporativo ? 1 : 0; }
  if (present.length) db.prepare(`UPDATE extracto_clientes SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run(body);
  const c = db.prepare('SELECT * FROM extracto_clientes WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrado' });
  res.json(c);
});

// Tarifario comercial de un cliente (tipo de servicio + tipo de vehículo -> valor cobrado / pago al afiliado)
app.get('/api/extractos/clientes/:id/tarifario', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tarifario_items WHERE cliente_id=? ORDER BY orden').all(req.params.id));
});
app.put('/api/extractos/clientes/:id/tarifario', requireRole('admin', 'tramites', 'comercial'), (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tarifario_items WHERE cliente_id=?').run(req.params.id);
    const ins = db.prepare(`INSERT INTO tarifario_items
      (cliente_id, tipo_servicio, tipo_vehiculo, descripcion, origen, destino, valor_servicio, pago_afiliado, orden)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    items.forEach((it, i) => ins.run(req.params.id, it.tipoServicio, it.tipoVehiculo, it.descripcion || null, it.origen || null, it.destino || null, +it.valorServicio || 0, +it.pagoAfiliado || 0, i));
  });
  tx();
  res.json(db.prepare('SELECT * FROM tarifario_items WHERE cliente_id=? ORDER BY orden').all(req.params.id));
});

// Contratos (flujo de aprobación)
function contratoConDetalle(k) {
  const cliente = db.prepare('SELECT * FROM extracto_clientes WHERE id=?').get(k.cliente_id);
  const historial = db.prepare('SELECT * FROM extracto_contrato_historial WHERE contrato_id=? ORDER BY id').all(k.id);
  return { ...k, cliente, historial };
}
app.get('/api/extractos/contratos', requireAuth, (req, res) => {
  let sql = 'SELECT * FROM extracto_contratos';
  const params = [];
  if (req.query.clienteId) { sql += ' WHERE cliente_id = ?'; params.push(req.query.clienteId); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params).map(contratoConDetalle));
});
app.post('/api/extractos/contratos', requireRole('admin', 'tramites', 'operaciones', 'comercial'), (req, res) => {
  const cliente = db.prepare('SELECT * FROM extracto_clientes WHERE id=?').get(req.body.clienteId);
  if (!cliente) return res.status(400).json({ error: 'Cliente no encontrado' });
  // Restricciones de creación según el tipo de cliente (Área de Trámites para ICBF; Trámites/Operaciones/Comercial para corporativos)
  if (cliente.es_icbf && !['admin', 'tramites'].includes(req.session.rol)) {
    return res.status(403).json({ error: 'Solo el Área de Trámites puede crear contratos ICBF' });
  }
  if (req.body.fechaInicio && req.body.fechaFin) {
    const unAnioDespues = new Date(req.body.fechaInicio + 'T00:00:00');
    unAnioDespues.setFullYear(unAnioDespues.getFullYear() + 1);
    if (new Date(req.body.fechaFin + 'T00:00:00') > unAnioDespues) {
      return res.status(400).json({ error: 'La vigencia del contrato no puede superar 1 año' });
    }
  }
  const id = newId('ekt');
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  // Si ya se adjunta el contrato firmado al crearlo (ej. módulo Comercial), se salta el paso de
  // "pendiente de firma" y queda directamente pendiente de validación por Trámites.
  const estadoInicial = req.body.archivoFirmadoUrl ? 'PENDIENTE_VALIDACION' : 'PENDIENTE_FIRMA';
  const tx = db.transaction(() => {
    const numero = (db.prepare('SELECT COALESCE(MAX(numero),0) n FROM extracto_contratos').get().n) + 1;
    db.prepare(`INSERT INTO extracto_contratos
      (id, numero, cliente_id, modalidad, objeto, origen, destino, fecha_inicio, fecha_fin, requiere_convenio, convenio_colaboracion, estado, archivo_firmado_url, creado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, numero, req.body.clienteId, req.body.modalidad, req.body.objeto || null, req.body.origen || null, req.body.destino || null,
        req.body.fechaInicio || null, req.body.fechaFin || null, req.body.requiereConvenio ? 1 : 0, req.body.convenioColaboracion || null,
        estadoInicial, req.body.archivoFirmadoUrl || null, usuario);
    const accionInicial = estadoInicial === 'PENDIENTE_VALIDACION' ? 'Contrato creado con firma adjunta — solicitud de verificación enviada a Trámites' : 'Contrato creado';
    db.prepare("INSERT INTO extracto_contrato_historial (contrato_id, usuario, accion) VALUES (?,?,?)").run(id, usuario, accionInicial);
  });
  tx();
  res.status(201).json(contratoConDetalle(db.prepare('SELECT * FROM extracto_contratos WHERE id=?').get(id)));
});
const CONTRATO_ESTADO_LABEL = {
  PENDIENTE_FIRMA: 'Pendiente de firma', PENDIENTE_VALIDACION: 'Pendiente validación',
  APROBADO: 'Aprobado', DEVUELTO: 'Devuelto', RECHAZADO: 'Rechazado',
};
app.put('/api/extractos/contratos/:id', requireRole('admin', 'tramites', 'operaciones', 'comercial'), (req, res) => {
  const contrato = db.prepare('SELECT * FROM extracto_contratos WHERE id=?').get(req.params.id);
  if (!contrato) return res.status(404).json({ error: 'No encontrado' });
  const cols = ['objeto', 'origen', 'destino', 'fecha_inicio', 'fecha_fin', 'convenio_colaboracion', 'archivo_firmado_url'];
  const present = cols.filter((c) => c in req.body);
  const actor = db.prepare('SELECT nombre, firma_url FROM users WHERE id=?').get(req.session.userId);
  const usuario = actor?.nombre;
  const body = { ...req.body, id: req.params.id };
  const tx = db.transaction(() => {
    if (present.length) db.prepare(`UPDATE extracto_contratos SET ${present.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run(body);
    if (req.body.archivo_firmado_url && contrato.estado === 'PENDIENTE_FIRMA') {
      db.prepare("INSERT INTO extracto_contrato_historial (contrato_id, usuario, accion) VALUES (?,?,'Contrato firmado cargado')").run(req.params.id, usuario);
    }
    if (req.body.estado) {
      const validas = ['PENDIENTE_FIRMA', 'PENDIENTE_VALIDACION', 'APROBADO', 'DEVUELTO', 'RECHAZADO'];
      if (!validas.includes(req.body.estado)) throw Object.assign(new Error('Estado inválido'), { status: 400 });
      if (req.body.estado === 'PENDIENTE_VALIDACION' && contrato.estado === 'PENDIENTE_FIRMA'
        && !(req.body.archivo_firmado_url || contrato.archivo_firmado_url)) {
        throw Object.assign(new Error('Debes cargar el contrato firmado antes de solicitar la validación de Trámites'), { status: 400 });
      }
      const validadoPor = ['APROBADO', 'DEVUELTO', 'RECHAZADO'].includes(req.body.estado) ? usuario : contrato.validado_por;
      db.prepare('UPDATE extracto_contratos SET estado=?, motivo_devolucion=?, validado_por=? WHERE id=?')
        .run(req.body.estado, req.body.motivoDevolucion || null, validadoPor, req.params.id);
      db.prepare("INSERT INTO extracto_contrato_historial (contrato_id, usuario, accion, nota, firma_url) VALUES (?,?,?,?,?)")
        .run(req.params.id, usuario, `Cambió estado a: ${CONTRATO_ESTADO_LABEL[req.body.estado] || req.body.estado}`, req.body.motivoDevolucion || '', actor?.firma_url || null);
      // Al aprobar, habilita al cliente para Operaciones: crea (o reactiva) su contrato vinculado
      // en /api/contratos, para que consuma el mismo tarifario del cliente y pueda diseñar/usar
      // el formulario de servicios (contrato_campos) — ver docs/BACKEND_DESIGN.md §9.
      if (req.body.estado === 'APROBADO') {
        const cliente = db.prepare('SELECT * FROM extracto_clientes WHERE id=?').get(contrato.cliente_id);
        const opId = 'com-' + contrato.cliente_id;
        const opContrato = db.prepare('SELECT id FROM contratos WHERE id=?').get(opId);
        if (opContrato) {
          db.prepare("UPDATE contratos SET nombre=?, estado='Activo' WHERE id=?").run(cliente.nombre, opId);
        } else {
          db.prepare('INSERT INTO contratos (id, nombre, nit, tipo, estado, extracto_cliente_id) VALUES (?,?,?,?,?,?)')
            .run(opId, cliente.nombre, cliente.documento || null, 'Corporativo', 'Activo', contrato.cliente_id);
        }
      }
    }
  });
  try { tx(); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  res.json(contratoConDetalle(db.prepare('SELECT * FROM extracto_contratos WHERE id=?').get(req.params.id)));
});

// Extractos
function extractoConDetalle(e) {
  const conductores = db.prepare(`SELECT c.* FROM extracto_conductores ec JOIN conductores c ON c.id = ec.conductor_id WHERE ec.extracto_id=? ORDER BY ec.orden`).all(e.id);
  const historial = db.prepare('SELECT * FROM extracto_historial WHERE extracto_id=? ORDER BY id').all(e.id);
  const vehiculo = db.prepare('SELECT id, placa, clase, marca, linea, modelo, interno FROM vehiculos WHERE id=?').get(e.vehiculo_id);
  const contrato = contratoConDetalle(db.prepare('SELECT * FROM extracto_contratos WHERE id=?').get(e.contrato_id));
  return { ...e, conductores: conductores.map(conductorConDetalle), historial, vehiculo, contrato };
}

app.get('/api/extractos', requireAuth, (req, res) => {
  let sql = 'SELECT * FROM extractos';
  const clauses = [];
  const params = [];
  if (req.query.vehiculoId) { clauses.push('vehiculo_id = ?'); params.push(req.query.vehiculoId); }
  if (req.query.contratoId) { clauses.push('contrato_id = ?'); params.push(req.query.contratoId); }
  if (req.query.estado) { clauses.push('estado = ?'); params.push(req.query.estado); }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params).map(extractoConDetalle));
});

app.get('/api/extractos/dashboard', requireAuth, (req, res) => {
  const hoy = new Date().toISOString().slice(0, 10);
  const en15 = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
  res.json({
    total: db.prepare('SELECT COUNT(*) n FROM extractos').get().n,
    vigentes: db.prepare("SELECT COUNT(*) n FROM extractos WHERE estado='VIGENTE' AND fecha_fin >= ?").get(hoy).n,
    proximosAVencer: db.prepare("SELECT COUNT(*) n FROM extractos WHERE estado='VIGENTE' AND fecha_fin >= ? AND fecha_fin <= ?").get(hoy, en15).n,
    vencidos: db.prepare("SELECT COUNT(*) n FROM extractos WHERE estado='VIGENTE' AND fecha_fin < ?").get(hoy).n,
    anulados: db.prepare("SELECT COUNT(*) n FROM extractos WHERE estado='ANULADO'").get().n,
    porTipo: db.prepare("SELECT generado_por_tipo, COUNT(*) n FROM extractos GROUP BY generado_por_tipo").all(),
    porModalidad: db.prepare(`SELECT ec.modalidad, COUNT(*) n FROM extractos e JOIN extracto_contratos ec ON ec.id = e.contrato_id GROUP BY ec.modalidad`).all(),
    vehiculosSinExtractoVigente: db.prepare(`
      SELECT v.id, v.placa FROM vehiculos v
      WHERE v.estado = 'Activo' AND NOT EXISTS (
        SELECT 1 FROM extractos e WHERE e.vehiculo_id = v.id AND e.estado = 'VIGENTE' AND e.fecha_fin >= ?
      )`).all(hoy),
  });
});

// Consulta pública de validación (QR) — sin autenticación, solo datos no sensibles
app.get('/api/public/extractos/:qrToken', (req, res) => {
  const e = db.prepare('SELECT * FROM extractos WHERE qr_token = ?').get(req.params.qrToken);
  if (!e) return res.status(404).json({ error: 'Extracto no encontrado' });
  const vehiculo = db.prepare('SELECT placa, marca, linea, clase FROM vehiculos WHERE id=?').get(e.vehiculo_id);
  const conductores = db.prepare(`SELECT c.nombre, c.cedula FROM extracto_conductores ec JOIN conductores c ON c.id=ec.conductor_id WHERE ec.extracto_id=? ORDER BY ec.orden`).all(e.id);
  const contrato = db.prepare('SELECT * FROM extracto_contratos WHERE id=?').get(e.contrato_id);
  const cliente = db.prepare('SELECT nombre FROM extracto_clientes WHERE id=?').get(contrato.cliente_id);
  const hoy = new Date().toISOString().slice(0, 10);
  const estadoReal = e.estado === 'VIGENTE' && e.fecha_fin < hoy ? 'VENCIDO' : e.estado;
  res.json({
    numeroFuec: e.numero_fuec, estado: estadoReal, vehiculo, conductores,
    cliente: cliente?.nombre, fechaInicio: e.fecha_inicio, fechaFin: e.fecha_fin, fechaGeneracion: e.created_at,
  });
});

app.get('/api/extractos/:id', requireAuth, (req, res) => {
  const e = db.prepare('SELECT * FROM extractos WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  res.json(extractoConDetalle(e));
});

function crearExtracto({ contratoId, vehiculoId, conductorIds, tarifarioItemId, fechaInicio, fechaFin, generadoPorTipo, usuario, duplicadoDeId, viaServicio }) {
  const contrato = db.prepare('SELECT * FROM extracto_contratos WHERE id=?').get(contratoId);
  const cliente = contrato && db.prepare('SELECT * FROM extracto_clientes WHERE id=?').get(contrato.cliente_id);
  const tarifarioItem = contrato && tarifarioItemId
    ? db.prepare('SELECT * FROM tarifario_items WHERE id=? AND cliente_id=?').get(tarifarioItemId, contrato.cliente_id)
    : null;
  const vehiculo = vehiculoId && vehiculoConDetalle(db.prepare('SELECT * FROM vehiculos WHERE id=?').get(vehiculoId));
  if (!vehiculo) return { error: 'Vehículo no encontrado' };
  const conductores = (conductorIds || []).map((id) => conductorConDetalle(db.prepare('SELECT * FROM conductores WHERE id=?').get(id))).filter(Boolean);
  if (!conductores.length) return { error: 'Debe indicar al menos un conductor' };

  const errorValidacion = validarGeneracionExtracto({ contrato, cliente, tarifarioItem, vehiculo, conductores, fechaInicio, fechaFin, generadoPorTipo, viaServicio });
  if (errorValidacion) return { error: errorValidacion };

  const id = newId('ext');
  const qrToken = crypto.randomBytes(16).toString('hex');
  const tx = db.transaction(() => {
    const numeroExtracto = (db.prepare('SELECT COUNT(*) n FROM extractos WHERE contrato_id=?').get(contratoId).n) + 1;
    const numeroFuec = generarNumeroFuec(contrato.numero, numeroExtracto);
    db.prepare(`INSERT INTO extractos
      (id, numero_fuec, contrato_id, vehiculo_id, tarifario_item_id, origen, destino, fecha_inicio, fecha_fin, generado_por_tipo, generado_por, declaracion_aceptada_en, duplicado_de_id, qr_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?)`)
      .run(id, numeroFuec, contratoId, vehiculoId, tarifarioItem.id, tarifarioItem.origen, tarifarioItem.destino, fechaInicio, fechaFin, generadoPorTipo, usuario, duplicadoDeId || null, qrToken);
    conductores.forEach((c, i) => db.prepare('INSERT INTO extracto_conductores (extracto_id, conductor_id, orden) VALUES (?,?,?)').run(id, c.id, i + 1));
    db.prepare("INSERT INTO extracto_historial (extracto_id, usuario, accion, nota) VALUES (?,?,?,?)")
      .run(id, usuario, duplicadoDeId ? 'Extracto duplicado' : 'Extracto generado', '');
  });
  tx();
  return { id };
}

app.post('/api/extractos', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.aceptaDeclaracion) return res.status(400).json({ error: 'Debes aceptar la declaración de responsabilidad para generar el extracto' });
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  const generadoPorTipo = b.generadoPorTipo === 'AFILIADO' ? 'AFILIADO' : 'EMPRESA';
  const result = crearExtracto({ ...b, usuario, generadoPorTipo });
  if (result.error) return res.status(422).json({ error: result.error });
  res.status(201).json(extractoConDetalle(db.prepare('SELECT * FROM extractos WHERE id=?').get(result.id)));
});

app.post('/api/extractos/:id/duplicar', requireAuth, (req, res) => {
  const original = db.prepare('SELECT * FROM extractos WHERE id=?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'No encontrado' });
  const b = req.body || {};
  if (!b.aceptaDeclaracion) return res.status(400).json({ error: 'Debes aceptar la declaración de responsabilidad para generar el extracto' });
  const conductorIds = db.prepare('SELECT conductor_id FROM extracto_conductores WHERE extracto_id=? ORDER BY orden').all(original.id).map((r) => r.conductor_id);
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  const result = crearExtracto({
    contratoId: original.contrato_id, vehiculoId: b.vehiculoId || original.vehiculo_id, conductorIds,
    tarifarioItemId: original.tarifario_item_id,
    fechaInicio: b.fechaInicio, fechaFin: b.fechaFin,
    generadoPorTipo: original.generado_por_tipo, usuario, duplicadoDeId: original.id,
  });
  if (result.error) return res.status(422).json({ error: result.error });
  res.status(201).json(extractoConDetalle(db.prepare('SELECT * FROM extractos WHERE id=?').get(result.id)));
});

app.put('/api/extractos/:id/anular', requireRole('admin', 'tramites'), (req, res) => {
  const e = db.prepare('SELECT * FROM extractos WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  const usuario = db.prepare('SELECT nombre FROM users WHERE id=?').get(req.session.userId)?.nombre;
  const tx = db.transaction(() => {
    db.prepare("UPDATE extractos SET estado='ANULADO' WHERE id=?").run(req.params.id);
    db.prepare("INSERT INTO extracto_historial (extracto_id, usuario, accion, nota) VALUES (?,?,'Extracto anulado',?)")
      .run(req.params.id, usuario, req.body?.nota || '');
  });
  tx();
  res.json(extractoConDetalle(db.prepare('SELECT * FROM extractos WHERE id=?').get(req.params.id)));
});

// SPA: cualquier ruta no encontrada devuelve el index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PIG — Trámites disponible en http://localhost:${PORT}`);
});
