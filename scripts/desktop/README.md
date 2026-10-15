# App de escritorio (F7)

Instalar o actualizar (desde tu PowerShell, no desde la app de Claude): `powershell -ExecutionPolicy Bypass -File scripts\desktop\install-desktop.ps1`.
Compila `Launcher.cs` a `%USERPROFILE%\.orquestador-ia\app\OrquestadorIA.exe`, corre su `--self-test`, genera el icono, escribe `launcher.json` (solo si no existe), hace `npm run build:ui` si hace falta y crea los accesos "Orquestador IA" en Escritorio y menú Inicio.
Para actualizar tras un `git pull`: cierra el lanzador (bandeja → Salir) y vuelve a correr el script; `launcher.json` (repo, port, npmDir, edge, notifications) se conserva.
Registros: `%USERPROFILE%\.orquestador-ia\logs\server.log` (servidor, rota a 5 MB) y `launcher.log` (avisos del lanzador).
