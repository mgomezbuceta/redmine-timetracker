#!/usr/bin/env bash
# Crea el lanzador en el menú de aplicaciones y, opcionalmente, el autoarranque.
#   ./install-desktop.sh            -> solo lanzador
#   ./install-desktop.sh --autostart -> lanzador + arranque al iniciar sesión
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$DIR/node_modules/.bin/electron"
[ -x "$ELECTRON" ] || { echo "Ejecuta antes: npm install"; exit 1; }

ENTRY="[Desktop Entry]
Type=Application
Name=Timetracker Redmine
Comment=Control de tiempo por tarea de Redmine
Exec=$ELECTRON $DIR --ozone-platform=x11
Icon=$DIR/assets/tray-on.png
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true"

mkdir -p ~/.local/share/applications
echo "$ENTRY" > ~/.local/share/applications/redmine-timetracker.desktop
echo "Lanzador creado en ~/.local/share/applications/redmine-timetracker.desktop"

if [ "${1:-}" = "--autostart" ]; then
  mkdir -p ~/.config/autostart
  echo "$ENTRY" > ~/.config/autostart/redmine-timetracker.desktop
  echo "Autoarranque activado (~/.config/autostart)."
fi
