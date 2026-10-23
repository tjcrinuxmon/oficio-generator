# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Oficios (gestión documental) de SiCoDEAJ: numeración y generación de oficios, opiniones, dictámenes, certificaciones y oficios de la CVIC, con exportación a Word, PDF y Excel. El mapa de módulos y el SSO están en `../CLAUDE.md`.

## Comandos

```bash
npm install
npm start          # :3003; requiere PORTAL_SSO_SECRET (y JWT_SECRET) en .env
```

Sin build (el front es `public/`) y sin pruebas. `scripts/crear-usuario-servicio.js` crea cuentas de servicio para integraciones.

**Despliegue por tag**, no por rama: se desarrolla en `v2-desarrollo`, se crea un tag anotado `vX.Y.Z` y en el servidor se corre `./deploy.sh vX.Y.Z` (sin argumento, el tag más reciente). El script protege `oficio_db.sqlite` y `.env` con `skip-worktree`, solo hace `npm ci` si cambió el lock y reinicia `oficios-staging` o `oficios` según si la carpeta está bajo `staging/` (hasta v1.9.0 reiniciaba siempre `oficios`, o sea prod).

## Arquitectura

- CommonJS. `server.js` monta `routes/` (`auth`, `usuarios`, `oficios`, `firmantes`, `anios`, `exportar`); `database.js` crea y migra el esquema al cargarse (`usuarios`, `firmantes`, `anios_config`, `oficios`, `oficio_adjuntos`).
- **Numeración**: `anios_config` guarda el año activo y un correlativo por tipo de documento (oficio, opinión, dictamen, certificación, CVIC presidencia / secretaría técnica); `routes/oficios.js` (`buildOficioNumero`) arma el número tomando el mayor entre lo configurado y lo ya usado. Incluye carga masiva desde Excel con un Excel de acuse.
- **Exportación** (`routes/exportar.js`): Word con la librería `docx` (logo incrustado `ine-logo.png`; `utils/logo.js` es solo un respaldo), PDF con `pdfkit`, Excel con `exceljs`.
- El front llama a `/api/of/*`; sin gateway, `server.js` hace la misma reescritura y sirve `public/` también bajo `/oficios/` (el HTML trae `<base href="/oficios/">`).
- **Acuerdos CVIC**: tipo de documento `acuerdo` en la tabla `oficios` (tarjeta en "Nuevo Documento", pestaña en Historial, panel en el Dashboard). Se registran ya aprobados con `POST /api/oficios/acuerdo` (multipart): no generan Word ni llevan destinatario/SAI; `asunto` guarda la síntesis o título, el área es siempre la CVIC y `firmante_id` apunta a la Presidencia solo porque la columna es obligatoria (no se muestra). Adjuntos en `oficio_adjuntos`, hasta 10, PDF o Word. Número `INE/CVIC/<n>/<año>` sin ceros, serie propia (`correlativo_acuerdo_*` en `anios_config`, donde "inicio" es el último número ya usado); se parece al de los oficios de Presidencia (`INE/CVIC/001/año`), a propósito. Cualquier usuario del área CVIC ve y edita todos los acuerdos, no solo los propios. Las actas, cuando lleguen, serían otro tipo con su propio consecutivo.
- Acceso por SSO del portal (`GET /api/auth/sso?sso_token=`) o por login propio (cuentas de servicio). Los oficios CVIC están restringidos a la Comisión (por área) y a administradores.
- `docs/INTEGRACION-EXTERNA.md` y `docs/ESPECIFICACION-INTEGRACION-OFICIOS.md` describen la API para sistemas externos (login → firmantes → generar → descargar).
- El tema verde de los dictámenes es funcional (tipo de documento), no color de marca.
