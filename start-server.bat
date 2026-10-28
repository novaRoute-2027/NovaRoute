@echo off
cd /d "%~dp0"
echo Starte lokalen Server fuer Novaroute ...
echo.
echo Sobald unten "Serving HTTP" oder "Accepting connections" steht,
echo im Browser diese Adresse oeffnen (falls sie sich nicht von selbst oeffnet):
echo   http://localhost:8000
echo.
echo Dieses Fenster muss waehrend der Nutzung geoeffnet bleiben.
echo Zum Beenden: dieses Fenster schliessen oder Strg+C druecken.
echo.

start "" "http://localhost:8000"

python -m http.server 8000 2>nul
if not errorlevel 1 goto :eof

echo.
echo Python wurde nicht gefunden (oder ist nur die Windows-Store-Verknuepfung).
echo Versuche es stattdessen mit Node.js ...
echo.

call npx --yes serve -l 8000
if not errorlevel 1 goto :eof

echo.
echo ============================================================
echo Weder Python noch Node.js konnten einen Server starten.
echo Bitte eines von beiden installieren, dann dieses Fenster neu starten:
echo.
echo   Python:  https://www.python.org/downloads/
echo            (WICHTIG: bei der Installation "Add python.exe to PATH" ankreuzen)
echo.
echo   Node.js: https://nodejs.org/
echo            (LTS-Version reicht, danach npx ist automatisch verfuegbar)
echo.
echo Falls "python" bei dir trotz Installation weiter die Store-Seite oeffnet:
echo Windows-Einstellungen - Apps - Erweiterte App-Einstellungen -
echo App-Ausfuehrungsaliase - "python.exe" und "python3.exe" AUS-schalten.
echo ============================================================
echo.
pause
