const express = require('express');
const ExcelJS = require('exceljs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, BorderStyle, WidthType, Header, Footer, VerticalAlign,
  convertInchesToTwip, FootnoteReferenceRun,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, PageNumber,
} = require('docx');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

const LOGO_PATH = path.join(__dirname, '..', 'ine-logo.png');
function getLogoBuffer() {
  if (fs.existsSync(LOGO_PATH)) return fs.readFileSync(LOGO_PATH);
  const { generateINELogoBuffer } = require('../utils/logo');
  return generateINELogoBuffer();
}

// Escudo Nacional de fondo (oficios externos): cubre toda la hoja como marca de agua.
const ESCUDO_PATH = path.join(__dirname, '..', 'fondo_verde.png');
function getEscudoBuffer() {
  return fs.existsSync(ESCUDO_PATH) ? fs.readFileSync(ESCUDO_PATH) : null;
}

const router = express.Router();
router.use(authMiddleware);

const ESTATUS_LABEL = { borrador: 'Borrador', enviado: 'Enviado', recibido: 'Recibido', archivado: 'Archivado', cancelado: 'Cancelado' };
const TIPO_LABEL    = { oficio: 'Oficio', opinion: 'Opinión Técnica', dictamen: 'Dictamen', certificacion: 'Certificación', cvic: 'Oficio CVIC' };

function getOficios(query, user) {
  const { estatus, tipo, area, firmante_id, fecha_inicio, fecha_fin, q } = query;
  const where = ['1=1'];
  const params = [];
  if (user.rol !== 'admin') { where.push('o.creado_por = ?'); params.push(parseInt(user.id)); }
  if (estatus)      { where.push("o.estatus = ?"); params.push(estatus); }
  if (tipo)         { where.push("COALESCE(o.tipo,'oficio') = ?"); params.push(tipo); }
  if (area)         { where.push("o.area LIKE ?"); params.push(`%${area}%`); }
  if (firmante_id)  { where.push("o.firmante_id = ?"); params.push(parseInt(firmante_id)); }
  if (fecha_inicio) { where.push("o.fecha >= ?"); params.push(fecha_inicio); }
  if (fecha_fin)    { where.push("o.fecha <= ?"); params.push(fecha_fin); }
  if (q) {
    where.push("(o.numero_oficio LIKE ? OR o.destinatario LIKE ? OR o.asunto LIKE ? OR o.url_solicitante LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
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
  return db.prepare(sql).all(...params);
}

function fmtFecha(f) {
  if (!f) return '—';
  const normalized = f.includes('T') ? f : f.replace(' ', 'T');
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return f.slice(0, 10);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function shortArea(a) {
  return (a || '')
    .replace('Dirección Ejecutiva de Asuntos Jurídicos', 'DEAJ')
    .replace(/Coordinaci[oó]n\s+/g, 'Coord. ')
    .replace('Dirección de ', 'Dir. ');
}

// GET /api/exportar/excel
router.get('/excel', async (req, res) => {
  try {
  const rows = getOficios(req.query, req.user);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'SiCoDEAJ';
  const ws = wb.addWorksheet('Documentos', { views: [{ state: 'frozen', ySplit: 3 }] });

  ws.getRow(1).height = 52;

  ws.mergeCells('A1:B1');
  const logoCell = ws.getCell('A1');
  logoCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF582E73' } };
  logoCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 8;

  const logoId = wb.addImage({ buffer: getLogoBuffer(), extension: 'png' });
  ws.addImage(logoId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 1 }, editAs: 'absolute' });

  ws.mergeCells('C1:K1');
  const titleCell = ws.getCell('C1');
  titleCell.value     = 'REGISTRO DE DOCUMENTOS — INE/DEAJ';
  titleCell.font      = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF582E73' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

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
  } catch (e) {
    console.error('[exportar/excel]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error al exportar el Excel: ' + e.message });
  }
});

// GET /api/exportar/docx/:id
router.get('/docx/:id', async (req, res) => {
  const ownerClause = req.user.rol !== 'admin' ? 'AND o.creado_por = ?' : '';
  const params = req.user.rol !== 'admin' ? [req.params.id, req.user.id] : [req.params.id];
  const o = db.prepare(
    `SELECT o.*, f.nombre AS firmante_nombre, f.cargo AS firmante_cargo, u.nombre AS creado_por_nombre
     FROM oficios o
     LEFT JOIN firmantes f ON o.firmante_id = f.id
     LEFT JOIN usuarios u ON o.creado_por = u.id
     WHERE o.id = ? ${ownerClause}`
  ).get(...params);
  if (!o) return res.status(404).json({ error: 'Oficio no encontrado' });

  try {
    const logoBuffer = getLogoBuffer();
    const FONT = 'Century Gothic';
    const PT12 = 24, PT10 = 20, PT9 = 18, PT8 = 16;

    const NO_B = { style: BorderStyle.NIL, size: 0, color: 'auto' };
    const NO_BORDERS = { top: NO_B, bottom: NO_B, left: NO_B, right: NO_B, insideH: NO_B, insideV: NO_B };
    const CELL_NO_B = { top: NO_B, bottom: NO_B, left: NO_B, right: NO_B };

    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const fd = new Date(((o.fecha || '') + 'T12:00:00').replace('T12:00:00T12:00:00', 'T12:00:00'));
    const fechaLarga = `${MESES[fd.getMonth()]} ${fd.getDate()}, ${fd.getFullYear()}, Ciudad de México.`;

    const isOpinionOrDictamen = o.tipo === 'opinion' || o.tipo === 'dictamen';
    const recipientName  = isOpinionOrDictamen ? (o.url_solicitante || '') : (o.destinatario || '');
    const recipientCargo = isOpinionOrDictamen ? '' : (o.cargo_destinatario || '');

    function run(text, opts = {}) {
      return new TextRun({
        text,
        bold: opts.bold,
        underline: opts.underline ? {} : undefined,
        font: FONT,
        size: opts.size || PT12,
        color: opts.color,
      });
    }

    function p(runs, alignment = AlignmentType.LEFT, after = 160) {
      const children = typeof runs === 'string'
        ? [run(runs)]
        : runs.map(r => run(r.text || '', r));
      return new Paragraph({ alignment, spacing: { after }, children });
    }

    function empty(after = 160) {
      return new Paragraph({ spacing: { after }, children: [] });
    }

    const cuerpoText = o.cuerpo || '';
    const cuerpoParas = cuerpoText.trim()
      ? cuerpoText.split(/\r?\n/).map(line => p([{ text: line }], AlignmentType.BOTH))
      : [empty(160)];

    // ══════════════════════════════════════════════════════════════════════
    // CVIC — Comisión de Verificación de Integridad en Candidaturas
    // Plantilla propia: encabezado de la Comisión, escudo de fondo, firma del
    // Presidente centrada y C.c.e.p. específico.
    // ══════════════════════════════════════════════════════════════════════
    if (o.tipo === 'cvic') {
      const escudoCvic = getEscudoBuffer();
      const fechaCvic = `Ciudad de México, ${fd.getDate()} de ${MESES[fd.getMonth()].toLowerCase()} de ${fd.getFullYear()}.`;
      const NOTA_CVIC = 'De conformidad con el Acuerdo del Consejo General del Instituto Nacional Electoral INE/CG482/2026.';

      // Fuente Arial Narrow y espaciado posterior 0 pto en todo el documento CVIC.
      const FC = 'Arial Narrow';
      const rc = (text, op = {}) => new TextRun({
        text, bold: op.bold, italics: op.italics,
        underline: op.underline ? {} : undefined,
        font: FC, size: op.size || PT12, color: op.color,
      });
      const pc = (children, alignment = AlignmentType.LEFT, line) =>
        new Paragraph({ alignment, spacing: { after: 0, ...(line ? { line } : {}) }, children });
      const emptyC = () => new Paragraph({ spacing: { after: 0 }, children: [] });

      const cuerpoParasC = (o.cuerpo || '').trim()
        ? o.cuerpo.split(/\r?\n/).map(l => pc([rc(l)], AlignmentType.BOTH))
        : [emptyC()];

      // Encabezado (se repite): escudo de fondo + nombre de la Comisión.
      // El número de oficio y la fecha ya NO van aquí (van en el cuerpo).
      const cvicHeaderChildren = [
        ...(escudoCvic ? [new Paragraph({ children: [
          new ImageRun({
            data: escudoCvic,
            transformation: { width: 816, height: 1056 },
            type: 'png',
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
              verticalPosition:   { relative: VerticalPositionRelativeFrom.PAGE,   offset: 0 },
              behindDocument: true, allowOverlap: true,
            },
          }),
        ]})] : []),
        new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 500, after: 0, line: 264 }, children: [rc('COMISIÓN DE VERIFICACIÓN DE INTEGRIDAD EN CANDIDATURAS.', { bold: true, size: PT10 })] }),
      ];

      // C.c.e.p. en tabla de dos columnas, fuente 8.
      const ccCell = (children, pct) => new TableCell({
        width: { size: pct, type: WidthType.PERCENTAGE }, borders: CELL_NO_B,
        margins: { top: 0, bottom: 0, left: 0, right: 60 }, verticalAlign: VerticalAlign.TOP, children,
      });
      const ccRow = (label, runs) => new TableRow({ children: [
        ccCell([new Paragraph({ spacing: { after: 0 }, children: label ? [rc(label, { bold: true, size: PT8 })] : [] })], 11),
        ccCell([new Paragraph({ spacing: { after: 0 }, children: runs })], 89),
      ]});
      const ccepTable = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE }, borders: NO_BORDERS,
        rows: [
          ccRow('C.c.e.p.', [rc('Lic. Guadalupe Taddei Zavala.', { bold: true, size: PT8 }), rc(' Consejera Presidenta del Consejo General del Instituto Nacional Electoral.- Presente.', { size: PT8 })]),
          ccRow('', [rc('Consejerías Electorales del Consejo General del Instituto Nacional Electoral', { bold: true, size: PT8 }), rc('. – Presentes.', { size: PT8 })]),
          ccRow('', [rc('Dra. Claudia Arlett Espino.', { bold: true, size: PT8 }), rc(' – Secretaria Ejecutiva del Instituto Nacional Electoral. - Presente.', { size: PT8 })]),
          ccRow('', [rc('Mtra. Anahí Silva Tosca.', { bold: true, size: PT8 }), rc(' Directora Ejecutiva de Asuntos Jurídicos y Secretaría Técnica de la Comisión de Verificación de Integridad en Candidaturas. - Presente.', { size: PT8 })]),
        ],
      });

      const cvicDoc = new Document({
        footnotes: { 1: { children: [ new Paragraph({ spacing: { after: 0 }, children: [
          new TextRun({ text: NOTA_CVIC, font: FC, size: PT8 }),
        ]}) ] } },
        sections: [{
          properties: {
            page: {
              size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
              margin: {
                top: convertInchesToTwip(1.3), bottom: convertInchesToTwip(1),
                left: 1134, right: 1134,
                header: convertInchesToTwip(0.25), footer: convertInchesToTwip(0.4),
              },
            },
          },
          headers: { default: new Header({ children: cvicHeaderChildren }) },
          footers: { default: new Footer({ children: [
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [
              new TextRun({ children: [PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], font: FC, size: PT9 }),
            ]}),
          ] }) },
          children: [
            // ── Número de oficio y fecha (fuera del encabezado, solo en la 1ª página) ──
            pc([rc(`Oficio. ${o.numero_oficio}.`, { size: PT10, color: '6B5F78' })], AlignmentType.RIGHT, 264),
            pc([rc(fechaCvic, { bold: true, size: PT10 })], AlignmentType.RIGHT, 264),

            emptyC(), emptyC(),

            // ── Destinatario ──
            pc([rc(o.destinatario || '', { bold: true })], AlignmentType.LEFT, 276),
            ...(o.cargo_destinatario ? [pc([rc(o.cargo_destinatario, { bold: true })], AlignmentType.LEFT, 276)] : []),

            emptyC(),

            // ── Cuerpo ──
            ...cuerpoParasC,

            emptyC(), emptyC(), emptyC(),

            // ── Firma: Presidente de la Comisión (centrado) ──
            pc([rc(o.firmante_cargo || 'Presidente de la Comisión de Verificación de Integridad en Candidaturas', { bold: true }), new FootnoteReferenceRun(1)], AlignmentType.CENTER),
            emptyC(),
            pc([rc(o.firmante_nombre || '', { bold: true })], AlignmentType.CENTER),
            pc([rc('Firmado electrónicamente en términos de los artículos 10, 12 y 22 del Reglamento para el Uso y Operación de la Firma Electrónica Avanzada en el Instituto Nacional Electoral.', { size: PT8, italics: true })], AlignmentType.CENTER),

            emptyC(),

            // ── C.c.e.p. (tabla de 2 columnas, fuente 8) ──
            ccepTable,
          ],
        }],
      });

      const bufferCvic = await Packer.toBuffer(cvicDoc);
      const safeNameCvic = (o.numero_oficio || `oficio_${o.id}`).replace(/[/\s]/g, '_');
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.set('Content-Disposition', `attachment; filename="${safeNameCvic}.docx"`);
      res.set('Content-Length', bufferCvic.length);
      return res.send(bufferCvic);
    }

    const VRE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' };
    const VRE_CELL_B = { top: VRE_BORDER, bottom: VRE_BORDER, left: VRE_BORDER, right: VRE_BORDER };

    function vreRow(label, nombre, cargo) {
      const cell = (children, pct) => new TableCell({
        width: { size: pct, type: WidthType.PERCENTAGE },
        borders: VRE_CELL_B,
        margins: { top: 20, bottom: 20, left: 40, right: 20 },
        verticalAlign: VerticalAlign.TOP,
        children,
      });
      return new TableRow({ children: [
        cell([new Paragraph({ spacing: { after: 0 }, children: [run(label, { size: PT9 })] })], 13),
        cell([new Paragraph({ spacing: { after: 0 }, children: [run(nombre || '', { size: PT9 })] })], 43),
        cell([new Paragraph({ spacing: { after: 0 }, children: [run(cargo || '', { size: PT9 })] })], 44),
      ]});
    }

    const headerTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: NO_BORDERS,
      rows: [new TableRow({ children: [
        new TableCell({
          width: { size: 32, type: WidthType.PERCENTAGE },
          borders: CELL_NO_B,
          margins: { top: 300, bottom: 0, left: 0, right: 0 },
          children: [new Paragraph({ spacing: { after: 0 }, children: [
            new ImageRun({ data: logoBuffer, transformation: { width: 186, height: 60 }, type: 'png' }),
          ]})],
        }),
        new TableCell({
          width: { size: 68, type: WidthType.PERCENTAGE },
          borders: CELL_NO_B,
          verticalAlign: VerticalAlign.BOTTOM,
          children: [
            new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 360 }, children: [run('Dirección Ejecutiva de Asuntos Jurídicos', { bold: true })] }),
            new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 360 }, children: [run(`Oficio ${o.numero_oficio}`, { bold: true })] }),
          ],
        }),
      ]})],
    });

    // ── Oficio EXTERNO: sin logo, con el Escudo Nacional de fondo a toda la hoja ──
    const esExterno = o.ambito === 'externo';
    const escudoBuffer = esExterno ? getEscudoBuffer() : null;
    // Tabla Validó/Revisó/Elaboró: en interno siempre; en externo solo si se eligió incluirla.
    const mostrarVre = !esExterno || o.incluir_vre != 0;
    // Footer del externo: solo el número de página (sin la tablita de oficialía de partes).
    const footerExterno = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 0 },
        children: [new TextRun({ children: [PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], font: FONT, size: PT9 })],
      }),
    ];
    const headerExterno = [
      ...(escudoBuffer ? [new Paragraph({ children: [
        new ImageRun({
          data: escudoBuffer,
          transformation: { width: 816, height: 1056 }, // carta 8.5"×11" @96dpi (cubre la hoja)
          type: 'png',
          floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
            verticalPosition:   { relative: VerticalPositionRelativeFrom.PAGE,   offset: 0 },
            behindDocument: true,
            allowOverlap: true,
          },
        }),
      ]})] : []),
      new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 300, after: 0, line: 360 }, children: [run('Dirección Ejecutiva de Asuntos Jurídicos', { bold: true })] }),
      new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 360 }, children: [run(`Oficio ${o.numero_oficio}`, { bold: true })] }),
    ];
    const headerChildren = esExterno ? headerExterno : [headerTable];

    const NOTA_FUNDAMENTO = 'Con fundamento en el artículo 45, numeral 1, inciso p) de la Ley General de Instituciones y Procedimientos Electorales y de conformidad con el oficio INE/PC/193/2026';
    const esTitular = !o.requiere_justificacion;

    const doc = new Document({
      ...(esTitular ? {
        footnotes: {
          1: {
            children: [
              new Paragraph({
                spacing: { after: 0 },
                children: [new TextRun({ text: NOTA_FUNDAMENTO, font: FONT, size: PT8 })],
              }),
            ],
          },
        },
      } : {}),
      sections: [{
        properties: {
          page: {
            size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
            margin: {
              top: convertInchesToTwip(1.3),
              bottom: convertInchesToTwip(1),
              left: 1134,   // 2 cm
              right: 1134,  // 2 cm
              header: convertInchesToTwip(0.25),
              footer: convertInchesToTwip(0.4),
            },
          },
        },
        headers: {
          default: new Header({ children: headerChildren }),
        },
        footers: {
          default: new Footer({ children: esExterno ? footerExterno : [
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: NO_BORDERS,
              rows: [new TableRow({ children: [
                new TableCell({
                  width: { size: 79, type: WidthType.PERCENTAGE },
                  borders: CELL_NO_B,
                  verticalAlign: VerticalAlign.BOTTOM,
                  children: [new Paragraph({ spacing: { after: 0 }, children: [run('1 de 1', { size: PT9 })] })],
                }),
                new TableCell({
                  width: { size: 21, type: WidthType.PERCENTAGE },
                  borders: { top: NO_B, bottom: NO_B, left: { style: BorderStyle.SINGLE, size: 12, color: 'E4007B' }, right: NO_B },
                  margins: { top: 20, bottom: 20, left: 120, right: 20 },
                  verticalAlign: VerticalAlign.TOP,
                  children: [
                    new Paragraph({ spacing: { after: 0, line: 200 }, children: [new TextRun({ text: 'Oficina de partes:', font: 'Myriad Pro Cond', size: PT8, bold: true })] }),
                    new Paragraph({ spacing: { after: 0, line: 200 }, children: [new TextRun({ text: 'Viaducto Tlalpan 100,', font: 'Myriad Pro Cond', size: PT8 })] }),
                    new Paragraph({ spacing: { after: 0, line: 200 }, children: [new TextRun({ text: 'Edificio C, Planta Baja', font: 'Myriad Pro Cond', size: PT8 })] }),
                    new Paragraph({ spacing: { after: 0, line: 200 }, children: [new TextRun({ text: 'Colonia Arenal Tepepan,', font: 'Myriad Pro Cond', size: PT8 })] }),
                    new Paragraph({ spacing: { after: 0, line: 200 }, children: [new TextRun({ text: 'C.P. 14610, Tlalpan, CDMX', font: 'Myriad Pro Cond', size: PT8 })] }),
                    new Paragraph({ spacing: { after: 0, line: 200 }, children: [new TextRun({ text: 'Teléfono 5556284200', font: 'Myriad Pro Cond', size: PT8 })] }),
                    new Paragraph({ spacing: { after: 0, line: 200 }, children: [new TextRun({ text: 'ext. 344981', font: 'Myriad Pro Cond', size: PT8 })] }),
                  ],
                }),
              ]})],
            }),
          ]}),
        },
        children: [
          // ── Fecha ──
          p([{ text: fechaLarga }], AlignmentType.RIGHT),

          // ── Asunto ──
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { after: 160 },
            children: [run('Asunto: ', { bold: true }), run(o.asunto + '.')],
          }),

          empty(),

          // ── Destinatario ──
          new Paragraph({ spacing: { after: 0, line: 240 }, children: [run(recipientName, { bold: true })] }),
          ...(recipientCargo ? [new Paragraph({ spacing: { after: o.institucion ? 0 : 160, line: 240 }, children: [run(recipientCargo)] })] : []),
          ...(o.institucion   ? [new Paragraph({ spacing: { after: 160, line: 240 }, children: [run(o.institucion)] })] : []),
          ...(!recipientCargo && !o.institucion ? [new Paragraph({ spacing: { after: 160 }, children: [] })] : []),

          empty(),

          // ── Cuerpo ──
          ...cuerpoParas,

          empty(240), empty(240), empty(240),

          // ── Firmante ──
          p([{ text: o.firmante_nombre || '', bold: true }], AlignmentType.LEFT, 0),
          new Paragraph({
            spacing: { after: 160 },
            children: [
              run(o.firmante_cargo || ''),
              ...(esTitular ? [new FootnoteReferenceRun(1)] : []),
            ],
          }),

          empty(),

          // ── Nota firma electrónica ──
          new Paragraph({
            spacing: { after: 80 },
            children: [run(
              'Este documento ha sido firmado electrónicamente de conformidad con el artículo 22 del Reglamento para el uso y operación de la Firma Electrónica Avanzada en el INE.',
              { size: PT8, color: '555555' }
            )],
          }),

          empty(80),

          // ── C.c.p. ──
          new Paragraph({
            spacing: { after: 0 },
            children: [
              new TextRun({ text: 'C.c.p.\t', font: FONT, size: PT9, bold: true }),
              new TextRun({ text: 'Guadalupe Taddei Zavala.', font: FONT, size: PT9, bold: true }),
              new TextRun({ text: ' Consejera Presidenta del Instituto Nacional Electoral. Para su conocimiento.', font: FONT, size: PT9 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 160 },
            children: [
              new TextRun({ text: '\t', font: FONT, size: PT9 }),
              new TextRun({ text: 'Claudia Arlett Espino,', font: FONT, size: PT9, bold: true }),
              new TextRun({ text: ' Secretaria Ejecutiva del Instituto Nacional Electoral. Para su conocimiento.', font: FONT, size: PT9 }),
            ],
          }),

          empty(80),

          // ── Anexo(s) ──
          new Paragraph({
            spacing: { after: 80 },
            children: [
              new TextRun({ text: 'Anexo(s):', font: FONT, size: PT10, bold: true }),
              new TextRun({ text: ' S/A  |  ', font: FONT, size: PT10 }),
              new TextRun({ text: 'ID SAI:', font: FONT, size: PT10, bold: true }),
              new TextRun({ text: ` ${o.id_sai || '—'}`, font: FONT, size: PT10 }),
            ],
          }),

          // ── Tabla Validó/Revisó/Elaboró (interno siempre; externo solo si se eligió) ──
          ...(mostrarVre ? [
            empty(80),
            new Table({
              width: { size: 85, type: WidthType.PERCENTAGE },
              rows: [
                vreRow('Validó',  o.firmante_nombre, o.firmante_cargo),
                vreRow('Revisó',  o.reviso_nombre  || o.firmante_nombre, o.reviso_puesto  || o.firmante_cargo),
                vreRow('Elaboró', o.elaboro_nombre || o.solicita,        o.elaboro_puesto || o.area),
              ],
            }),
          ] : []),


        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const safeName = (o.numero_oficio || `oficio_${o.id}`).replace(/[/\s]/g, '_');
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.set('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Error generando DOCX:', err);
    res.status(500).json({ error: 'Error al generar el documento Word' });
  }
});

module.exports = router;
