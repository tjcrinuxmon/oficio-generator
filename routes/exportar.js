const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const ESTATUSES = { borrador: 'Borrador', enviado: 'Enviado', recibido: 'Recibido', archivado: 'Archivado' };

function getOficios(db, query) {
  const { estatus, area, firmante_id, fecha_inicio, fecha_fin, q } = query;
  let where = ['1=1'];
  if (estatus) where.push(`o.estatus = '${estatus.replace(/'/g, "''")}'`);
  if (area) where.push(`o.area LIKE '%${area.replace(/'/g, "''")}%'`);
  if (firmante_id) where.push(`o.firmante_id = ${parseInt(firmante_id)}`);
  if (fecha_inicio) where.push(`o.fecha >= '${fecha_inicio}'`);
  if (fecha_fin) where.push(`o.fecha <= '${fecha_fin}'`);
  if (q) {
    const sq = q.replace(/'/g, "''");
    where.push(`(o.numero_oficio LIKE '%${sq}%' OR o.destinatario LIKE '%${sq}%' OR o.asunto LIKE '%${sq}%')`);
  }
  const sql = `
    SELECT o.numero_oficio, o.fecha, o.destinatario, o.cargo_destinatario, o.asunto,
           f.nombre as firmante_nombre, o.razon, o.solicita, o.area, o.estatus,
           o.creado_en, u.nombre as creado_por_nombre,
           CASE WHEN o.acuse_path IS NOT NULL AND o.acuse_path != '' THEN 'Sí' ELSE 'No' END as tiene_acuse
    FROM oficios o
    LEFT JOIN firmantes f ON o.firmante_id = f.id
    LEFT JOIN usuarios u ON o.creado_por = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY o.correlativo DESC
  `;
  const result = db.exec(sql);
  if (!result.length) return { columns: [], rows: [] };
  return { columns: result[0].columns, rows: result[0].values };
}

// GET /api/exportar/excel
router.get('/excel', async (req, res) => {
  const db = getDb();
  const { columns, rows } = getOficios(db, req.query);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sistema DEAJ-INE';
  const sheet = workbook.addWorksheet('Oficios', { views: [{ state: 'frozen', ySplit: 2 }] });

  // Logo / título
  sheet.mergeCells('A1:M1');
  sheet.getCell('A1').value = 'REGISTRO DE OFICIOS — INE/DEAJ';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A2240' } };
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 30;

  const headers = ['Número de Oficio', 'Fecha', 'Destinatario', 'Cargo Destinatario', 'Asunto',
    'Firmante', 'Razón', 'Solicita', 'Área', 'Estatus', 'Registrado', 'Registrado por', 'Acuse'];
  const headerRow = sheet.addRow(headers);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC9963A' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
  });
  sheet.getRow(2).height = 22;

  rows.forEach((row, idx) => {
    const dataRow = sheet.addRow(row.map((v, i) => {
      if (columns[i] === 'estatus') return ESTATUSES[v] || v;
      return v;
    }));
    dataRow.eachCell(cell => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (idx % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F7FA' } };
    });
  });

  const colWidths = [22, 12, 25, 22, 35, 25, 30, 20, 20, 12, 18, 20, 8];
  sheet.columns.forEach((col, i) => { col.width = colWidths[i] || 15; });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Oficios_DEAJ.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// GET /api/exportar/pdf
router.get('/pdf', (req, res) => {
  const db = getDb();
  const { columns, rows } = getOficios(db, req.query);

  const doc = new PDFDocument({ margin: 40, size: 'LETTER', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Oficios_DEAJ.pdf"');
  doc.pipe(res);

  // Header
  doc.rect(0, 0, doc.page.width, 60).fill('#0A2240');
  doc.fillColor('white').fontSize(16).font('Helvetica-Bold')
    .text('REGISTRO DE OFICIOS — INE/DEAJ', 40, 20, { align: 'center' });
  doc.fillColor('white').fontSize(10).font('Helvetica')
    .text(`Generado: ${new Date().toLocaleString('es-MX')}`, 40, 42, { align: 'center' });

  doc.moveDown(2);

  // Table headers
  const colWidths2 = [120, 60, 110, 100, 150, 110, 65, 65];
  const headers2 = ['Número Oficio', 'Fecha', 'Destinatario', 'Cargo', 'Asunto', 'Firmante', 'Área', 'Estatus'];
  const colIdxs = [0, 1, 2, 3, 4, 5, 8, 9];
  let x = 40;
  let y = doc.y;

  // Header row
  doc.rect(x, y, colWidths2.reduce((a, b) => a + b, 0), 20).fill('#C9963A');
  headers2.forEach((h, i) => {
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
      .text(h, x + colWidths2.slice(0, i).reduce((a, b) => a + b, 0) + 2, y + 5, { width: colWidths2[i] - 4 });
  });
  y += 20;

  rows.forEach((row, rowIdx) => {
    const rowH = 18;
    if (y + rowH > doc.page.height - 40) {
      doc.addPage({ margin: 40, size: 'LETTER', layout: 'landscape' });
      y = 40;
    }
    if (rowIdx % 2 === 0) doc.rect(x, y, colWidths2.reduce((a, b) => a + b, 0), rowH).fill('#F5F7FA');
    colIdxs.forEach((ci, i) => {
      let val = String(row[ci] || '');
      if (columns[ci] === 'estatus') val = ESTATUSES[val] || val;
      doc.fillColor('#1a1a2e').fontSize(7).font('Helvetica')
        .text(val, x + colWidths2.slice(0, i).reduce((a, b) => a + b, 0) + 2, y + 4, {
          width: colWidths2[i] - 4, ellipsis: true, lineBreak: false
        });
    });
    doc.rect(x, y, colWidths2.reduce((a, b) => a + b, 0), rowH).stroke('#E0E0E0');
    y += rowH;
  });

  doc.end();
});

module.exports = router;
