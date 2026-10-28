# Novaroute — Prototyp

Ein klickbarer Frontend-Prototyp, der das Kernprinzip der App erlebbar macht:
eine Karte mit persönlichem "befahren / unbefahren"-Netz, ein Regler für den
gewünschten Neuland-Anteil und ein Routengenerator, der eine Runde passend
zu Ziel-km / Ziel-Höhenmetern vorschlägt und dabei bevorzugt unbekannte Wege
einbaut — an einem frei wählbaren Standort weltweit.

## Ausprobieren

**Wichtig:** Die App lädt beim Start Straßendaten von OpenStreetMap nach —
das funktioniert aus Sicherheitsgründen nur, wenn die Seite über einen
lokalen Server läuft (`http://localhost`), **nicht** wenn `index.html` direkt
per Doppelklick geöffnet wird (`file://`). Browser blockieren bei `file://`
grundsätzlich Anfragen an fremde Server (Meldung: „origin 'null'"/CORS) —
das ist eine Sicherheitsregel des Browsers selbst und lässt sich nicht durch
Code in der App umgehen.

**Einfachster Weg (Windows):** Doppelklick auf `start-server.bat` im Ordner.
Das startet automatisch einen lokalen Server (versucht zuerst Python, dann
Node.js/npx) und öffnet den Browser unter `http://localhost:8000`. Das dabei
aufgehende schwarze Fenster muss offen bleiben, solange du die App nutzt.

Falls weder Python noch Node.js installiert sind, zeigt das Fenster
Download-Links an. **Wichtiger Windows-Stolperstein:** Ohne echte Installation
zeigt der Befehl `python` bei vielen Windows-Rechnern nur einen Verweis auf
den Microsoft Store, tut aber nichts. Falls das auch nach einer echten
Python-Installation weiter passiert: Windows-Einstellungen → Apps →
Erweiterte App-Einstellungen → App-Ausführungsaliase → "python.exe" und
"python3.exe" ausschalten.

**Manuell (jedes Betriebssystem):**
1. Terminal öffnen, mit `cd` in den Ordner mit `index.html` wechseln
2. `python -m http.server 8000` ausführen (Fenster offen lassen)
3. Im Browser `http://localhost:8000` öffnen

## Was jetzt schon echt ist

- **Frei wählbarer Standort, weltweit**: Ortssuche (Geocoding über die
  öffentliche Nominatim-API von OpenStreetMap), ein "Meinen Standort
  verwenden"-Button (Browser-Geolocation) und Klick auf die Karte setzen
  jeweils einen neuen Standort. Bautzen ist nur der Startwert beim ersten
  Laden, keine feste Vorgabe mehr.
- **Echtes Straßennetz**: Für den jeweils aktuellen Standort lädt die App live
  Straßendaten von OpenStreetMap (über die öffentliche Overpass-API) für
  einen Umkreis von ca. 11 km. Der Routengenerator läuft auf diesem echten
  Straßengraphen — die Route folgt also tatsächlichen Straßen, nicht einem
  künstlichen Gitter.
- **Routing**: kein Zufalls-Walk mehr, sondern ein Wegpunkt-Kreis-Ansatz —
  mehrere Punkte werden grob auf einem Kreis um den Start verteilt (immer in
  eine Drehrichtung) und per kostenoptimiertem kürzestem Pfad verbunden. Das
  Kostenmodell gewichtet dabei: Neuland-Bias (Regler), Wiederholungs-Strafe
  für schon benutzte Straßen, Sackgassen-Vermeidung, sowie eine Strafe für
  bereits besuchte Kreuzungen (minimiert Selbstüberschneidungen der Route).
  Zusätzlich gibt es einen Umweg-Deckel: der Neuland-Bias darf einen
  Abschnitt höchstens ~35 % länger machen als den direkten Weg, sonst wird
  der direktere Weg genommen — verhindert wildes Zickzack durch
  Nebenstraßen. Mehrere Zufallsvarianten werden parallel durchgerechnet, die
  mit den wenigsten Kreuzungen gewinnt.

## Was weiterhin simuliert ist (wichtig!)

- **Keine echte Strava-Anbindung** — "schon gefahren" wird weiterhin per
  Zufall vergeben (pro ganzer Straße, gewichtet nach Nähe zum Startpunkt),
  nicht aus echten Aktivitätsdaten.
- **Höhenmeter sind weiterhin zufällig** pro Straße, nicht aus echten
  Höhendaten berechnet.
- **Ladegebiet ist fix ca. 11 km**, unabhängig vom gewählten km-Ziel —
  bei sehr großen Zieldistanzen (Richtung 90 km) kann die Route deshalb an
  den Rand des geladenen Gebiets stoßen; die App weist dann per Hinweistext
  darauf hin, statt es zu verschweigen.

## Was für eine echte Version noch fehlt

1. **Echte Strava-Anbindung**
   Strava-OAuth kann nicht rein im Browser laufen, weil das Client-Secret
   dabei nicht öffentlich sichtbar sein darf. Dafür braucht es einen kleinen
   Backend-Dienst (z. B. Node/Express oder Cloudflare Worker), der den
   OAuth-Handshake macht und die Aktivitäts-GPS-Daten von Strava abruft.

2. **Map-Matching (GPS-Track → Straßensegment)**
   Die vom Nutzer gefahrenen GPS-Tracks müssen den tatsächlichen OSM-Wegen
   zugeordnet werden ("dieser Track ist genau diese Straße"). Dafür gibt es
   fertige Bibliotheken (z. B. Valhalla Meili, OSRM Match-Service).

3. **Persönliche Coverage-Datenbank**
   Ergebnis von Schritt 2 pro Nutzer speichern: welche OSM-Wege wurden schon
   wie oft gefahren. Das ist die Datenbasis, auf der der echte Neuland-Score
   aufbaut — aktuell übernimmt das noch der Zufallsgenerator.

4. **Dynamisches Ladegebiet**
   Der Radius für die Straßennetz-Abfrage sollte sich an die gewählte
   Zieldistanz anpassen, statt fix bei ca. 11 km zu bleiben.

5. **Echte Höhendaten**
   Digitales Geländemodell (z. B. SRTM oder nationale Höhendaten), um reale
   Höhenmeter statt Zufallswerte zu berechnen.

6. **Geocoding-Dienst für echten Betrieb**
   Nominatim (aktuell genutzt) ist kostenlos, aber für Prototyping gedacht —
   die Nutzungsbedingungen verlangen moderate Anfragehäufigkeit. Bei
   nennenswertem Traffic besser auf einen dedizierten Geocoding-Dienst
   wechseln (z. B. Mapbox, MapTiler, Google Geocoding API).

## Dateien

```
index.html        Struktur & UI
style.css          Papier-Karten-Look (Design-Token siehe unten)
app.js             Straßennetz + Routengenerator + Kartenlogik + Standortwahl
start-server.bat   Lokalen Server bequem starten (Windows)
```

## Design-Idee

Angelehnt an klassische Rad-/Wanderkarten: Papierton-Hintergrund, Tinte-Blau
für Bekanntes, Signalorange für Neuland — bewusst kein Standard-Dark-Mode,
weil das Produkt inhaltlich näher an einer physischen Karte ist als an einer
Fitness-Tracking-App.
