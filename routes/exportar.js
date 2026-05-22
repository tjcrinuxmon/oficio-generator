const express = require('express');
const ExcelJS = require('exceljs');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { generateINELogoBuffer } = require('../utils/logo');

const router = express.Router();
router.use(authMiddleware);

const ESTATUS_LABEL = { borrador: 'Borrador', enviado: 'Enviado', recibido: 'Recibido', archivado: 'Archivado', cancelado: 'Cancelado' };
const TIPO_LABEL    = { oficio: 'Oficio', opinion: 'Opinión Técnica', dictamen: 'Dictamen', certificacion: 'Certificación' };

// ── Query helper ──────────────────────────────────────────────────────────────
function getOficios(db, query, user) {
  const { estatus, tipo, area, firmante_id, fecha_inicio, fecha_fin, q } = query;
  const where = ['1=1'];
  // Usuarios no-admin solo ven sus propios documentos
  if (user.rol !== 'admin') where.push(`o.creado_por = ${parseInt(user.id)}`);
  if (estatus)      where.push(`o.estatus = '${estatus.replace(/'/g, "''")}'`);
  if (tipo)         where.push(`(COALESCE(o.tipo,'oficio') = '${tipo.replace(/'/g, "''")}')`);
  if (area)         where.push(`o.area LIKE '%${area.replace(/'/g, "''")}%'`);
  if (firmante_id)  where.push(`o.firmante_id = ${parseInt(firmante_id)}`);
  if (fecha_inicio) where.push(`o.fecha >= '${fecha_inicio}'`);
  if (fecha_fin)    where.push(`o.fecha <= '${fecha_fin}'`);
  if (q) {
    const sq = q.replace(/'/g, "''");
    where.push(`(o.numero_oficio LIKE '%${sq}%' OR o.destinatario LIKE '%${sq}%' OR o.asunto LIKE '%${sq}%' OR o.url_solicitante LIKE '%${sq}%')`);
  }

  const sql = `
    SELECT o.numero_oficio, o.fecha, COALESCE(o.tipo,'oficio') AS tipo,
           o.destinatario, o.cargo_destinatario, o.url_solicitante,
           o.asunto, f.nombre AS firmante_nombre,
           o.area, o.estatus, o.creado_en, u.nombre AS creado_por_nombre,
           CASE WHEN o.acuse_path IS NOT NULL AND o.acuse_path != '' THEN 'Sí' ELSE 'No' END AS tiene_acuse
    FROM oficios o
    LEFT JOIN firmantes f ON o.firmante_id = f.id
    LEFT JOIN usuarios u ON o.creado_por = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY o.correlativo DESC
  `;
  const result = db.exec(sql);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function fmtFecha(f) {
  if (!f) return '—';
  const d = new Date(f.includes('T') ? f : f + 'T12:00:00');
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function shortArea(a) {
  return (a || '')
    .replace('Dirección Ejecutiva de Asuntos Jurídicos', 'DEAJ')
    .replace(/Coordinaci[oó]n\s+/g, 'Coord. ')
    .replace('Dirección de ', 'Dir. ');
}

// ── Excel export ─────────────────────────────────────────────────────────────
router.get('/excel', async (req, res) => {
  const db   = getDb();
  const rows = getOficios(db, req.query, req.user);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema DEAJ-INE';
  const ws = wb.addWorksheet('Documentos', { views: [{ state: 'frozen', ySplit: 3 }] });

  // ── Fila 1: Logo + Título ────────────────────────────────────────────────
  ws.getRow(1).height = 52;

  // Columnas A-B: área del logo (fondo morado, sin texto)
  ws.mergeCells('A1:B1');
  const logoCell = ws.getCell('A1');
  logoCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF582E73' } };
  logoCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 8;

  // Logo PNG incrustado en A1:B1
  const logoId = wb.addImage({ buffer: generateINELogoBuffer(), extension: 'png' });
  ws.addImage(logoId, {
    tl: { col: 0, row: 0 },
    br: { col: 2, row: 1 },
    editAs: 'absolute',
  });

  // Columnas C-K: título institucional
  ws.mergeCells('C1:K1');
  const titleCell = ws.getCell('C1');
  titleCell.value     = 'REGISTRO DE DOCUMENTOS — INE/DEAJ';
  titleCell.font      = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF582E73' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

  // ── Fila 2: Cabeceras de columnas ────────────────────────────────────────
  const headers = ['Número', 'Fecha', 'Tipo', 'Destinatario / UR Solicitante',
    'Asunto', 'Firmante', 'Área', 'Estatus', 'Registrado', 'Registrado por', 'Acuse'];
  const hr = ws.addRow(headers);
  hr.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A1239' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(2).height = 22;

  rows.forEach((row, idx) => {
    const dest = row.tipo === 'opinion' ? (row.url_solicitante || '—') : (row.destinatario || '—');
    const dr = ws.addRow([
      row.numero_oficio,
      fmtFecha(row.fecha),
      TIPO_LABEL[row.tipo] || row.tipo,
      dest,
      row.asunto || '—',
      row.firmante_nombre || '—',
      row.area || '—',
      ESTATUS_LABEL[row.estatus] || row.estatus,
      fmtFecha(row.creado_en),
      row.creado_por_nombre || '—',
      row.tiene_acuse,
    ]);
    dr.eachCell(cell => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (idx % 2 === 0)
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F5FB' } };
    });
  });

  [22, 13, 18, 40, 42, 26, 22, 12, 14, 22, 8].forEach((w, i) => {
    if (ws.columns[i]) ws.columns[i].width = w;
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Documentos_DEAJ.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
