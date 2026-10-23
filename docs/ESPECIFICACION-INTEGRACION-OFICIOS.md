# Especificación de integración — Generación de oficios (SiCoDEAJ / DEAJ)

**Destinatario:** equipo del sistema externo
**Objetivo:** que su sistema pueda **generar un oficio** en el SiCoDEAJ de la DEAJ de forma
programática y reciba a cambio el **número de oficio** asignado.
**Estado:** propuesta para validación. *Antes de implementar nada, confirmen por favor que
disponen de los datos listados en la sección 3 y respondan las preguntas de la sección 7.*

---

## 1. Alcance

- El sistema externo envía los datos de un oficio mediante una llamada HTTPS.
- El SiCoDEAJ valida, registra el oficio y **devuelve el número de oficio** (p. ej. `INE/DEAJ/045/2026`).
- La integración es **servidor a servidor** (no requiere interfaz de usuario).

---

## 2. Flujo de la integración

| Paso | Método | Endpoint | Auth |
|------|--------|----------|------|
| 1. Autenticación | `POST` | `/api/of/auth/login` | email + contraseña (cuenta de servicio) |
| 2. Generar oficio | `POST` | `/api/oficios/generar` | Bearer token |

- **Base URL:** la proporciona DEAJ (gateway sobre **HTTPS**).
- **Token:** el login devuelve un JWT válido **8 horas**. Se reutiliza en cada llamada
  como cabecera `Authorization: Bearer <token>` y se renueva al expirar.

---

## 3. Datos que el sistema externo debe enviar (al generar)

### 3.1 Obligatorios SIEMPRE

| Campo | Tipo | Descripción | Ejemplo |
|-------|------|-------------|---------|
| `fecha` | texto `YYYY-MM-DD` | Fecha del oficio | `2026-06-19` |
| `asunto` | texto | Asunto del oficio | `Solicitud de información` |
| `solicita` | texto | Nombre de quien solicita | `Mtra. Ana Ruiz` |
| `area` | texto | Área que genera el oficio | `Dirección de Servicios Legales` |
| `firmante` | (ver sección 7) | Quién firma el oficio | — |

### 3.2 Obligatorios SEGÚN el tipo de documento

El campo `tipo` puede ser `oficio` (por defecto), `certificacion`, `opinion` o `dictamen`.

| `tipo` | Campos adicionales obligatorios |
|--------|--------------------------------|
| `oficio` / `certificacion` | `destinatario` (texto), `cargo_destinatario` (texto) |
| `opinion` / `dictamen` | `url_solicitante` (texto: unidad/área solicitante) |

### 3.3 Condicional

| Campo | Cuándo es obligatorio |
|-------|-----------------------|
| `justificacion_firmante` | Solo si el firmante **no** es el titular (ver sección 7). |

### 3.4 Opcionales

| Campo | Tipo | Nota |
|-------|------|------|
| `cuerpo` | texto | Cuerpo del documento |
| `sintesis` | texto | Resumen breve |
| `institucion` | texto | Institución del destinatario |
| `id_sai` | texto numérico | Máx. 10 dígitos. Excluyente con `justificacion_sai` |
| `justificacion_sai` | texto | Solo si no hay `id_sai` |
| `ambito` | `interno` / `externo` | Por defecto `interno` |

> **Precondición del lado DEAJ (no es dato del sistema externo):** debe existir un
> "año activo" configurado en el SiCoDEAJ. Lo administra DEAJ.

---

## 4. Respuesta

Generación correcta → **HTTP 201** con el número de oficio:

```json
{ "numero_oficio": "INE/DEAJ/045/2026" }
```

> El formato del número depende del tipo: oficio `INE/DEAJ/NNN/AAAA`,
> opinión `INE/DEAJ/OTJ/NNN/AAAA`, dictamen `INE/DEAJ/DTJ/NNN/AAAA`,
> certificación `DEAJ-NNN-AAAA`.

Errores posibles: `400` faltan campos obligatorios o formato inválido;
`401` token ausente/expirado; `500` configuración del servidor (p. ej. sin año activo).

---

## 5. Autenticación y credenciales

- DEAJ creará una **cuenta de servicio** (email + contraseña) exclusiva para este sistema.
- La contraseña debe guardarse en el **gestor de secretos** del sistema externo, nunca en
  el código ni en repositorios.
- El acceso se puede **revocar de inmediato** del lado DEAJ si fuera necesario.

---

## 6. Requisitos técnicos del lado del sistema externo

- Cliente HTTP con **TLS/HTTPS**.
- Capacidad de **almacenar y reutilizar** el token (8 h) y renovarlo ante un `401`.
- **No reintentar a ciegas** una generación fallida por timeout: cada generación
  **consume un número de oficio** y un reintento podría duplicar. Ante error de red,
  confirmar primero si el oficio se creó.
- (Deseable) **IP de salida fija**, para poder restringir el acceso por IP en el gateway.

---

## 7. Preguntas para el equipo externo (confirmar antes de implementar)

1. **Campos:** ¿disponen de todos los campos obligatorios de la sección 3.1 y los del
   `tipo` que vayan a usar (3.2)?
2. **Tipo(s) de documento:** ¿qué tipos generarán? (`oficio`, `certificacion`, `opinion`,
   `dictamen`).
3. **Firmante:** ¿pueden indicar el firmante, o prefieren que **siempre firme el titular**
   por defecto? *(Si lo eligen ustedes, DEAJ les entregará el catálogo de firmantes con sus
   identificadores; si es siempre el titular, no necesitan enviar nada de firmante ni
   justificación.)*
4. **Volumen:** ¿cuántos oficios por día/hora esperan generar? (para dimensionar límites).
5. **Origen:** ¿desde qué IP(s) saldrán las peticiones? ¿es fija?
6. **Documento:** ¿les basta con el **número de oficio**, o también necesitarán descargar
   el documento (.docx) generado?

---

## 8. Ejemplo de extremo a extremo

```bash
# 1) Login (token de 8h)
TOKEN=$(curl -s -X POST https://<gateway>/api/of/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sistema-x@deaj","password":"<clave>"}' | jq -r .token)

# 2) Generar oficio (devuelve el número)
curl -s -X POST https://<gateway>/api/oficios/generar \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "oficio",
    "fecha": "2026-06-19",
    "destinatario": "Lic. Juan Pérez",
    "cargo_destinatario": "Director General",
    "asunto": "Solicitud de información",
    "solicita": "Mtra. Ana Ruiz",
    "area": "Dirección de Servicios Legales"
  }'
# → { "numero_oficio": "INE/DEAJ/045/2026" }
```

*(El ejemplo asume firmante por titular; ver sección 7, pregunta 3.)*

---

> **Nota de implementación (interna DEAJ, no enviar necesariamente):** la respuesta
> "solo número de oficio" y el firmante-titular-por-defecto requieren un endpoint
> dedicado o un pequeño ajuste; hoy `/api/oficios/generar` exige `firmante_id` y
> devuelve el objeto completo. Esto se define según las respuestas de la sección 7.
