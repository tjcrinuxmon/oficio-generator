#!/usr/bin/env bash
#
# Despliegue de "oficios" (oficio-generator) en producción — POR TAG.
# Se ejecuta EN EL SERVIDOR, dentro del directorio del repo:
#     ./deploy.sh            # despliega el tag más reciente (vX.Y.Z)
#     ./deploy.sh v1.5.0     # despliega un tag específico
#
# Deja producción fijada a una versión estable (tag), no a la rama de
# desarrollo. NO toca la base de datos (oficio_db.sqlite) ni el .env; las
# migraciones de esquema corren solas al arrancar (database.js).

set -euo pipefail

APP_NAME="oficios"
cd "$(dirname "$0")"

command -v git >/dev/null || { echo "✖ git no está instalado"; exit 1; }
command -v pm2 >/dev/null || { echo "✖ pm2 no está instalado"; exit 1; }

echo "==> Protegiendo datos de producción..."
for f in oficio_db.sqlite .env; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    git update-index --skip-worktree "$f" 2>/dev/null || true
    echo "    · protegido: $f"
  fi
done

echo "==> Trayendo tags del remoto..."
git fetch origin --tags --prune --force

TAG="${1:-$(git tag -l 'v*' --sort=-v:refname | head -n1)}"
[ -n "$TAG" ] || { echo "✖ No se encontró ningún tag vX.Y.Z"; exit 1; }

BEFORE="$(git rev-parse HEAD)"
echo "==> Desplegando tag: $TAG"
git checkout -q "$TAG"
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "==> Ya estaba en ${AFTER:0:7} ($TAG)."
else
  echo "==> ${BEFORE:0:7} -> ${AFTER:0:7}  ($TAG)"
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

echo "✅ Despliegue de oficios ($TAG) completado."
