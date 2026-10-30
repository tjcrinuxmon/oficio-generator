// =====================================================
// lib/documentos.js — Reglas compartidas para generar documentos numerados
// (oficios, opiniones, dictámenes, certificaciones y oficios CVIC).
// Las usan la generación individual (POST /api/oficios/generar) y la carga
// masiva desde Excel, para que ambas validen y numeren exactamente igual.
// =====================================================
const db = require('../database');

// Oficios CVIC: solo la Comisión de Verificación de Integridad en Candidaturas
// (usuarios con esta área asignada) o un administrador pueden crearlos o verlos.
const CVIC_AREA = 'Comisión de Verificación de Integridad en Candidaturas';
const puedeCvic = (user) => user.rol === 'admin' || user.area === CVIC_AREA;

const TIPOS_GENERABLES = ['oficio', 'opinion', 'dictamen', 'certificacion', 'cvic'];
const MODALIDADES_CVIC = ['presidencia', 'secretaria_tecnica'];
const JUSTIFICACION_SAI_CVIC = 'No aplica a oficios de la Comisión de Verificación de Integridad en Candidaturas.';

// Unidades responsables que pueden solicitar opiniones técnicas y dictámenes (mismo catálogo que el front).
const URS = [
  'Dirección Ejecutiva del Registro Federal de Electores (DERFE)',
  'Dirección Ejecutiva de Prerrogativas y Partidos Políticos (DEPPP)',
  'Dirección Ejecutiva de Organización Electoral (DEOE)',
  'Dirección Ejecutiva del Servicio Profesional Electoral Nacional (DESPEN)',
  'Dirección Ejecutiva de Capacitación Electoral y Educación Cívica (DECEyEC)',
  'Dirección Ejecutiva de Administración (DEA)',
  'Dirección Ejecutiva de Asuntos Jurídicos (DEAJ)',
  'Presidencia del Consejo General',
  'Secretaría Ejecutiva',
  'Coordinación Nacional de Comunicación Social (CNCS)',
  'Coordinación de Asuntos Internacionales (CAI)',
  'Unidad Técnica de Servicios de Informática (UTSI)',
  'Dirección del Secretariado',
  'Unidad Técnica de Igualdad de Género y No Discriminación (UTIGyND)',
  'Unidad Técnica de lo Contencioso Electoral (UTCE)',
  'Unidad Técnica de Vinculación con los Organismos Públicos Locales (UTVOPL)',
  'Unidad Técnica de Fiscalización (UTF)',
  'Unidad Técnica de Transparencia y Protección de Datos Personales (UTTyPDP)',
];

function buildOficioNumero(correlativo, anio, tipo, modalidadCvic) {
  const num = String(correlativo).padStart(3, '0');
  if (tipo === 'opinion')       return `INE/DEAJ/OTJ/${num}/${anio}`;
  if (tipo === 'dictamen')      return `INE/DEAJ/DTJ/${num}/${anio}`;
  if (tipo === 'certificacion') return `DEAJ-${num}-${anio}`;
  if (tipo === 'acuerdo')       return `INE/CVIC/${correlativo}/${anio}`; // acuerdos: sin ceros a la izquierda
  if (tipo === 'cvic')          return modalidadCvic === 'secretaria_tecnica' ? `INE/CVIC/ST/${num}/${anio}` : `INE/CVIC/${num}/${anio}`;
  return `INE/DEAJ/${num}/${anio}`;
}

// Columna del contador en anios_config para cada serie.
function columnaContador(tipo, modalidadCvic) {
  if (tipo === 'dictamen')      return 'correlativo_dictamen_actual';
  if (tipo === 'opinion')       return 'correlativo_opinion_actual';
  if (tipo === 'certificacion') return 'correlativo_certificacion_actual';
  if (tipo === 'cvic')          return modalidadCvic === 'secretaria_tecnica' ? 'correlativo_cvic_st_actual' : 'correlativo_cvic_actual';
  return 'correlativo_actual';
}

const esFalso = (v) => v === false || v === 0 || v === '0' || v === 'false';
const texto = (v) => (v === undefined || v === null ? '' : String(v).trim());

// Valida los datos de un documento y los normaliza. No escribe nada.
// Devuelve { error, status } o { datos } listo para insertarDocumento().
function validarDocumento(body, user) {
  const tipo = TIPOS_GENERABLES.includes(body.tipo) ? body.tipo : 'oficio';
  const isOpinion = tipo === 'opinion', isDictamen = tipo === 'dictamen', isCvic = tipo === 'cvic';
  const fallo = (error, status = 400) => ({ error, status });

  if (isCvic && !puedeCvic(user)) {
    return fallo('Solo la Comisión de Verificación de Integridad en Candidaturas o un administrador pueden generar oficios CVIC', 403);
  }
  // Modalidad CVIC: 'presidencia' (INE/CVIC/###/año) o 'secretaria_tecnica' (INE/CVIC/ST/###/año).
  const modalidadCvic = isCvic ? (body.modalidad_cvic === 'secretaria_tecnica' ? 'secretaria_tecnica' : 'presidencia') : null;
  const ambito = body.ambito === 'externo' ? 'externo' : 'interno';
  // Tabla Validó/Revisó/Elaboró: en interno siempre va; en externo es opcional.
  const incluirVre = ambito === 'externo' && esFalso(body.incluir_vre) ? 0 : 1;

  const d = {
    tipo, modalidadCvic, ambito, incluirVre,
    fecha: texto(body.fecha), asunto: texto(body.asunto), solicita: texto(body.solicita), area: texto(body.area),
    destinatario: texto(body.destinatario), cargo_destinatario: texto(body.cargo_destinatario),
    institucion: texto(body.institucion), url_solicitante: texto(body.url_solicitante),
    cuerpo: texto(body.cuerpo), sintesis: texto(body.sintesis), razon: texto(body.razon),
    justificacion_firmante: texto(body.justificacion_firmante),
    reviso_nombre: texto(body.reviso_nombre), reviso_puesto: texto(body.reviso_puesto),
    elaboro_nombre: texto(body.elaboro_nombre), elaboro_puesto: texto(body.elaboro_puesto),
    firmante_id: parseInt(body.firmante_id),
  };

  if (!d.fecha || !d.asunto || !d.firmante_id || !d.solicita || !d.area) return fallo('Todos los campos obligatorios son requeridos');
  const idSai = texto(body.id_sai);
  if (idSai && (!/^\d+$/.test(idSai) || idSai.length > 10)) return fallo('El ID SAI debe ser numérico y tener máximo 10 dígitos');
  // ID SAI y justificación son mutuamente excluyentes; si no hay ninguno, el oficio queda "pendiente de SAI".
  d.id_sai = idSai || null;
  d.justificacion_sai = idSai ? null : (texto(body.justificacion_sai) || null);
  if (!isOpinion && !isDictamen && !d.destinatario) return fallo('Todos los campos obligatorios son requeridos');
  // El cargo del destinatario es obligatorio salvo en CVIC (el destinatario va como bloque único).
  if (!isOpinion && !isDictamen && !isCvic && !d.cargo_destinatario) return fallo('Todos los campos obligatorios son requeridos');
  if ((isOpinion || isDictamen) && !d.url_solicitante) return fallo('Todos los campos obligatorios son requeridos');

  const firmante = db.prepare(`SELECT es_titular, cvic_rol, ambito FROM firmantes WHERE id = ? AND activo = 1`).get(d.firmante_id);
  if (!firmante) return fallo('Firmante no válido');
  // El firmante debe corresponder a la modalidad CVIC elegida (Presidencia firma INE/CVIC/, Secretaría Técnica firma INE/CVIC/ST/).
  if (isCvic && firmante.cvic_rol !== modalidadCvic) return fallo('El firmante seleccionado no corresponde a la modalidad CVIC elegida');
  // Los instrumentos DEAJ solo los firma quien tiene ámbito DEAJ (o ambos).
  if (!isCvic && firmante.ambito === 'cvic') return fallo('El firmante seleccionado solo firma oficios de la Comisión');
  // CVIC lo firma el Presidente o la Secretaría Técnica de la Comisión: no aplica la justificación de "no titular DEAJ".
  d.requiereJustificacion = isCvic ? false : !firmante.es_titular;
  if (d.requiereJustificacion && !d.justificacion_firmante) return fallo('La justificación es obligatoria cuando no firma el titular');

  return { datos: d };
}

// Asigna el siguiente número de la serie e inserta el documento. Debe llamarse dentro de
// db.transaction(): lee el contador ahí mismo para no repetir números con peticiones simultáneas.
function insertarDocumento(d, userId) {
  const row = db.prepare(`SELECT * FROM anios_config WHERE activo = 1 LIMIT 1`).get();
  if (!row) { const e = new Error('No hay año activo configurado'); e.status = 500; throw e; }

  // MAX real de la tabla como respaldo por si el contador quedó desfasado.
  // CVIC tiene dos series independientes (Presidencia / Secretaría Técnica): se distingue por modalidad_cvic.
  const maxReal = d.tipo === 'cvic'
    ? db.prepare(`SELECT COALESCE(MAX(correlativo), 0) as max FROM oficios WHERE anio = ? AND tipo = 'cvic' AND COALESCE(modalidad_cvic, 'presidencia') = ?`).get(row.anio, d.modalidadCvic).max
    : db.prepare(`SELECT COALESCE(MAX(correlativo), 0) as max FROM oficios WHERE anio = ? AND tipo = ?`).get(row.anio, d.tipo).max;
  const columna = columnaContador(d.tipo, d.modalidadCvic);
  const correlativo = Math.max(row[columna] || 0, maxReal) + 1;
  const numero = buildOficioNumero(correlativo, row.anio, d.tipo, d.modalidadCvic);

  db.prepare(`UPDATE anios_config SET ${columna} = ? WHERE id = ?`).run(correlativo, row.id);
  const r = db.prepare(`INSERT INTO oficios (numero_oficio, correlativo, anio, tipo, modalidad_cvic, fecha, destinatario, cargo_destinatario, institucion, asunto, cuerpo, id_sai, justificacion_sai, sintesis, firmante_id, requiere_justificacion, justificacion_firmante, razon, solicita, area, url_solicitante, reviso_nombre, reviso_puesto, elaboro_nombre, elaboro_puesto, creado_por, ambito, incluir_vre) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(numero, correlativo, row.anio, d.tipo, d.modalidadCvic, d.fecha,
         d.destinatario, d.cargo_destinatario, d.institucion || null,
         d.asunto, d.cuerpo || null, d.id_sai, d.justificacion_sai, d.sintesis || null,
         d.firmante_id, d.requiereJustificacion ? 1 : 0,
         d.justificacion_firmante || null, d.razon || null, d.solicita, d.area,
         d.url_solicitante || null,
         d.reviso_nombre || null, d.reviso_puesto || null,
         d.elaboro_nombre || null, d.elaboro_puesto || null,
         userId, d.ambito, d.incluirVre);
  return { id: r.lastInsertRowid, numero };
}

module.exports = {
  CVIC_AREA, puedeCvic, TIPOS_GENERABLES, MODALIDADES_CVIC, JUSTIFICACION_SAI_CVIC, URS,
  buildOficioNumero, validarDocumento, insertarDocumento,
};
