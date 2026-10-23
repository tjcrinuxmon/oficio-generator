# Integración externa — Generación de oficios (API)

Guía para que **otro sistema** genere oficios del SiCoDEAJ (DEAJ) de forma
programática (server-to-server) a través del gateway.

## Resumen

| Paso | Método | Endpoint (vía gateway) | Auth |
|------|--------|------------------------|------|
| 1. Login | `POST` | `/api/of/auth/login` | — (email/password) |
| 2. Listar firmantes | `GET` | `/api/firmantes` | Bearer |
| 3. Generar oficio | `POST` | `/api/oficios/generar` | Bearer |
| 4. Descargar .docx | `GET` | `/api/exportar/docx/:id` | Bearer |

- **Base URL:** `https://<dominio-del-gateway>` (HTTPS obligatorio).
- **Auth:** JWT *Bearer* obtenido en el login. Vigencia **8 horas** → cachéalo y
  vuelve a hacer login solo cuando expire (o ante un `401`).
- **Cuenta de servicio:** la provee el equipo DEAJ (email + contraseña). Guárdala
  en tu **gestor de secretos**, nunca en el código ni en el repositorio.

---

## 1. Login (obtener token)

```bash
curl -X POST https://<gateway>/api/of/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sistema-x@deaj","password":"<la-clave>"}'
```

Respuesta:
```json
{ "token": "eyJhbGciOi...", "user": { "id": 42, "rol": "usuario" } }
```

Usa `token` en las siguientes llamadas: `Authorization: Bearer <token>`.

> El login está limitado a 10 intentos / 15 min por IP. Con tokens de 8h basta
> con ~3 logins al día; cachea el token.

---

## 2. Elegir firmante

```bash
curl https://<gateway>/api/firmantes -H "Authorization: Bearer <token>"
```

Devuelve la lista de firmantes activos. Toma el `id` del firmante que corresponda
(lo necesitas como `firmante_id` al generar).

---

## 3. Generar el oficio

```bash
curl -X POST https://<gateway>/api/oficios/generar \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "oficio",
    "fecha": "2026-06-19",
    "destinatario": "Lic. Juan Pérez",
    "cargo_destinatario": "Director General",
    "asunto": "Solicitud de información",
    "cuerpo": "Texto del oficio...",
    "solicita": "Nombre de quien solicita",
    "area": "Dirección de Servicios Legales",
    "sintesis": "Resumen breve",
    "firmante_id": 3,
    "id_sai": "12345"
  }'
```

Respuesta (201):
```json
{ "id": 987, "numero_oficio": "INE/DEAJ/045/2026", "tipo": "oficio", ... }
```

### Campos del body

**Obligatorios siempre:** `fecha` (YYYY-MM-DD), `asunto`, `solicita`, `area`, `firmante_id`.

| `tipo` | Campos extra obligatorios |
|--------|---------------------------|
| `oficio` (default) / `certificacion` | `destinatario`, `cargo_destinatario` |
| `opinion` / `dictamen` | `url_solicitante` |

**Opcionales:** `cuerpo`, `sintesis`, `institucion`, `id_sai` (numérico, máx 10 díg.),
`justificacion_sai`, `razon`, `ambito` (`interno`/`externo`), etc.

Notas:
- `id_sai` y `justificacion_sai` son **mutuamente excluyentes**.
- Si el firmante **no es titular**, `justificacion_firmante` es obligatorio.
- Debe existir un **año activo** configurado en el sistema (lo gestiona DEAJ).
- ⚠️ Cada generación **consume un número de oficio** (correlativo). Si reintentas
  por timeout, podrías duplicar. Genera una sola vez y, ante error de red, primero
  verifica con `GET /api/oficios` antes de reintentar.

---

## 4. Descargar el documento (.docx)

```bash
curl -L https://<gateway>/api/exportar/docx/987 \
  -H "Authorization: Bearer <token>" \
  -o oficio.docx
```

La cuenta de servicio solo puede descargar los oficios que **ella misma** generó.

---

## Seguridad / operación

- **HTTPS** siempre (la base URL del gateway debe ser TLS).
- **Revocación inmediata:** si la credencial se compromete, DEAJ ejecuta
  `UPDATE usuarios SET activo = 0 WHERE email = '<cuenta>'` y los tokens dejan de
  funcionar al instante (se valida `activo` en cada request).
- **Rotación:** cambia la contraseña de la cuenta periódicamente.
- **Errores comunes:** `401` token vencido/ inválido (vuelve a hacer login);
  `400` faltan campos obligatorios; `500` no hay año activo configurado.

---

## Despliegue (lado DEAJ)

1. Crear la cuenta de servicio en el servidor de oficios:
   ```bash
   node scripts/crear-usuario-servicio.js sistema-x@deaj '<clave-larga-aleatoria>' "Sistema X" usuario
   ```
2. Confirmar que el gateway publica las rutas `/api/of/auth/login`, `/api/firmantes`,
   `/api/oficios` y `/api/exportar` sobre **HTTPS**.
3. Entregar al equipo externo: base URL, email y contraseña (por canal seguro).
