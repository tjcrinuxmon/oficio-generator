#!/usr/bin/env bash
#
# Despliegue de "oficios" (oficio-generator) en producción.
# Se ejecuta EN EL SERVIDOR, dentro del directorio del repo:
#     ./deploy.sh
#
# Actualiza el código desde origin/<rama>, reinstala dependencias solo si
# cambiaron, y reinicia el proceso de PM2. NO toca la base de datos de
# producción (oficio_db.sqlite) ni el archivo .env; las migraciones de esquema
# corren solas al arrancar (database.js), preservando los datos.

set -euo pipefail

# --- Configuración (ajusta si tu proceso/rama son distintos) ----------------
APP_NAME="oficios"
BRANCH="v2-desarrollo"
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

command -v git >/dev/null || { echo "✖ git no está instalado"; exit 1; }
command -v pm2 >/dev/null || { echo "✖ pm2 no está instalado"; exit 1; }

echo "==> Protegiendo datos de producción (git ignora cambios locales en estos archivos)..."
for f in oficio_db.sqlite .env; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    git update-index --skip-worktree "$f" 2>/dev/null || true
    echo "    · protegido: $f"
  fi
done

echo "==> Descargando cambios de origin/$BRANCH..."
git fetch origin "$BRANCH"

BEFORE="$(git rev-parse HEAD)"
git merge --ff-only "origin/$BRANCH"
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "==> Sin cambios nuevos (ya estaba en ${AFTER:0:7})."
else
  echo "==> Código actualizado: ${BEFORE:0:7} -> ${AFTER:0:7}"
  echo "    Archivos:"
  git diff --name-only "$BEFORE" "$AFTER" | sed 's/^/      /'
fi

# Reinstalar dependencias solo si cambió package.json o package-lock.json
if [ "$BEFORE" != "$AFTER" ] && \
   git diff --name-only "$BEFORE" "$AFTER" | grep -qE 'package(-lock)?\.json'; then
  echo "==> Cambiaron dependencias, instalando..."
  npm ci --omit=dev || npm install --omit=dev
else
  echo "==> Sin cambios en dependencias, se omite npm install."
fi

echo "==> Reiniciando PM2 ($APP_NAME)..."
pm2 restart "$APP_NAME" --update-env

echo "==> Últimas líneas de log:"
pm2 logs "$APP_NAME" --lines 15 --nostream || true

echo "✅ Despliegue de oficios completado."
