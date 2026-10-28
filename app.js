/**
 * NOVAROUTE — Prototyp (v3: frei wählbarer Standort weltweit)
 * ------------------------------------------------------------
 * Was jetzt ECHT ist:
 *   - Das Straßennetz kommt live von OpenStreetMap (über die
 *     öffentliche Overpass-API), keine erfundenen Gitterlinien mehr.
 *   - Der Routengenerator läuft auf diesem echten Straßengraphen.
 *   - Der Standort ist frei wählbar: Suche (Nominatim-Geocoding),
 *     Browser-Standort oder Klick auf die Karte — nicht mehr fest
 *     auf einen Ort verdrahtet.
 *
 * Der Routengenerator legt Wegpunkte auf einem groben Kreis um den Start
 * (immer in eine Drehrichtung) und verbindet sie per kostenoptimiertem
 * kürzestem Pfad — das ergibt echte Rundkurse statt Zufalls-Zickzack.
 *
 * Was WEITERHIN simuliert ist (siehe README.md):
 *   - "Schon gefahren" wird nach wie vor per Zufall vergeben
 *     (gewichtet nach Nähe zum Startpunkt) statt aus echten
 *     Strava-Daten — das ist der nächste Ausbauschritt.
 *   - Höhenmeter sind weiterhin zufällig pro Straße,
 *     nicht aus echten Höhendaten (SRTM o. ä.).
 * ------------------------------------------------------------
 */

// Startpunkt — nur ein Vorgabewert, bis der Nutzer einen eigenen Ort wählt
// (Suchfeld, "Mein Standort" oder Klick auf die Karte). CENTER ist bewusst
// "let", nicht "const": die ganze App arbeitet mit dem jeweils aktuellen Ort.
let CENTER = { lat: 51.1801, lng: 14.4335 }; // Bautzen als Startvorgabe
const RADIUS_KM = 11; // Muss groß genug sein, damit auch 90-km-Routen genug Straßennetz haben

// ---- 1. Kartenaufbau -------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView([CENTER.lat, CENTER.lng], 13);

// Verschiedene Kartenlayer
const osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap-Mitwirkende',
  maxZoom: 19,
  className: 'map-layer-osm',
});

const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri, DigitalGlobe, Earthstar Geographics',
  maxZoom: 19,
  className: 'map-layer-satellite',
});

const terrainLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri, HERE, Garmin, FAO, NOAA, USGS',
  maxZoom: 19,
  className: 'map-layer-terrain',
});
console.log('✅ Alle Layer definiert: OSM, Satellit, Gelände');

const startMarker = L.circleMarker([CENTER.lat, CENTER.lng], {
  radius: 7, color: '#9ca3af', weight: 2, fillColor: '#ffffff', fillOpacity: 1,
}).addTo(map).bindTooltip('Start / Ziel', { permanent: false });

// ---- 2. Hilfsfunktionen -------------------------------------------------

function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ---- Echte Höhendaten (ersetzt die Zufalls-Simulation der Steigung) ------

let nodeElevations = new Map(); // nodeId -> Höhe in Metern (leer = noch nicht geladen)
const ELEVATION_BATCH_SIZE = 100; // Open-Meteo erlaubt bis zu 100 Koordinaten pro Request
const ELEVATION_CONCURRENCY = 6;  // so viele Batches gleichzeitig, nicht alle auf einmal

// Lädt echte Höhendaten (Copernicus DEM, 90m Auflösung) für alle übergebenen
// Knoten-Koordinaten. Läuft in mehreren parallelen Batches, da die API pro
// Request maximal 100 Koordinaten akzeptiert.
async function fetchElevations(nodeCoordsMap, onProgress = () => {}) {
  const entries = Array.from(nodeCoordsMap.entries()); // [nodeId, {lat,lng}]
  const batches = [];
  for (let i = 0; i < entries.length; i += ELEVATION_BATCH_SIZE) {
    batches.push(entries.slice(i, i + ELEVATION_BATCH_SIZE));
  }

  const elevations = new Map();
  let done = 0;

  async function fetchBatch(batch) {
    const lats = batch.map(([, c]) => c.lat.toFixed(5)).join(',');
    const lngs = batch.map(([, c]) => c.lng.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.elevation)) {
        batch.forEach(([nodeId], i) => {
          if (typeof data.elevation[i] === 'number') elevations.set(nodeId, data.elevation[i]);
        });
      }
    } catch (err) {
      console.warn('⚠️ Höhendaten-Batch fehlgeschlagen:', err.message);
    }
    done++;
    onProgress(done, batches.length);
  }

  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const idx = cursor++;
      await fetchBatch(batches[idx]);
    }
  }
  const workerCount = Math.min(ELEVATION_CONCURRENCY, batches.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, worker));

  console.log(`✅ Höhendaten geladen: ${elevations.size}/${entries.length} Knoten`);
  return elevations;
}



// ---- Echte Fahrhistorie aus GPX-Dateien (ersetzt die Zufalls-Simulation) --

const RIDDEN_STORAGE_KEY = 'novaroute_ridden_track_points_v1';
const RIDDEN_MATCH_THRESHOLD_KM = 0.035; // Kante gilt als "gefahren", wenn ein Trackpunkt näher als das dran liegt
const RIDDEN_GRID_CELL_DEG = 0.002; // ~220m Rastergröße für den räumlichen Index

let riddenTrackPoints = []; // [{ lat, lng }] — aus allen importierten GPX-Dateien, downgesampelt
let riddenSpatialIndex = null; // { grid: Map<string, points[]> } — für schnelles Nachschlagen

function loadRiddenPointsFromStorage() {
  try {
    const raw = localStorage.getItem(RIDDEN_STORAGE_KEY);
    if (!raw) return;
    riddenTrackPoints = JSON.parse(raw);
    riddenSpatialIndex = buildRiddenSpatialIndex(riddenTrackPoints);
    console.log('💾 Fahrhistorie aus lokalem Speicher geladen:', riddenTrackPoints.length, 'Punkte');
  } catch (err) {
    console.warn('⚠️ Konnte gespeicherte Fahrhistorie nicht laden:', err.message);
  }
}

function saveRiddenPointsToStorage() {
  try {
    localStorage.setItem(RIDDEN_STORAGE_KEY, JSON.stringify(riddenTrackPoints));
  } catch (err) {
    console.warn('⚠️ Konnte Fahrhistorie nicht speichern (evtl. zu groß für localStorage):', err.message);
  }
}

function buildRiddenSpatialIndex(points) {
  const grid = new Map();
  points.forEach(p => {
    const key = `${Math.round(p.lat / RIDDEN_GRID_CELL_DEG)}_${Math.round(p.lng / RIDDEN_GRID_CELL_DEG)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  });
  return { grid };
}

// Prüft, ob an einer Position (lat/lng) ein importierter Trackpunkt in der Nähe liegt
function isNearRiddenTrack(lat, lng) {
  if (!riddenSpatialIndex || !riddenSpatialIndex.grid.size) return null; // null = keine Daten vorhanden
  const cellLat = Math.round(lat / RIDDEN_GRID_CELL_DEG);
  const cellLng = Math.round(lng / RIDDEN_GRID_CELL_DEG);
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const pts = riddenSpatialIndex.grid.get(`${cellLat + dLat}_${cellLng + dLng}`);
      if (!pts) continue;
      for (const p of pts) {
        if (haversine({ lat, lng }, p) < RIDDEN_MATCH_THRESHOLD_KM) return true;
      }
    }
  }
  return false;
}

// Parst eine GPX-Datei (reines XML) und gibt alle Track-Punkte zurück,
// leicht ausgedünnt (jeder 3. Punkt reicht für das Map-Matching völlig).
function parseGpxFile(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length > 0) throw new Error('Ungültiges GPX-Format');
  const trkpts = Array.from(xml.getElementsByTagName('trkpt'));
  const points = [];
  for (let i = 0; i < trkpts.length; i += 3) {
    const el = trkpts[i];
    const lat = parseFloat(el.getAttribute('lat'));
    const lng = parseFloat(el.getAttribute('lon'));
    if (!isNaN(lat) && !isNaN(lng)) points.push({ lat, lng });
  }
  return points;
}

// Entpackt eine .gz-komprimierte Datei mit der browsereigenen
// DecompressionStream-API (keine Zusatzbibliothek nötig, unterstützt in
// aktuellen Versionen von Edge/Chrome/Firefox/Safari).
async function decompressGzip(arrayBuffer) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(ds);
  const blob = await new Response(stream).blob();
  return blob.arrayBuffer();
}

// Minimaler FIT-Binärparser (Garmin-Format). Liest nur, was wir brauchen:
// GPS-Positionen aus "record"-Nachrichten (globale Message-Nr. 20). Der
// vollständige FIT-Standard hat noch viele weitere Nachrichtentypen, die
// hier bewusst ignoriert werden — für den Zweck des Map-Matchings reichen
// die reinen Positionsdaten.
function parseFit(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 12) throw new Error('Datei zu klein für gültiges FIT-Format');

  const headerSize = view.getUint8(0);
  const dataSize = view.getUint32(4, true);
  let offset = headerSize;
  const dataEnd = Math.min(headerSize + dataSize, arrayBuffer.byteLength);

  const localDefs = {};
  const points = [];

  function readDataMessage(localType, off) {
    const def = localDefs[localType];
    if (!def) return null; // unbekannter lokaler Typ — Datei nicht sauber parsebar ab hier
    let lat = null, lng = null;
    for (const f of def.fields) {
      if (f.defNum === 0 && f.size === 4) lat = view.getInt32(off, def.littleEndian);
      else if (f.defNum === 1 && f.size === 4) lng = view.getInt32(off, def.littleEndian);
      off += f.size;
    }
    for (const df of def.devFields) off += df.size;

    if (def.globalMesgNum === 20 && lat !== null && lng !== null && lat !== 0x7fffffff && lng !== 0x7fffffff) {
      points.push({
        lat: lat * (180 / 2 ** 31),
        lng: lng * (180 / 2 ** 31),
      });
    }
    return off;
  }

  let safety = 0;
  while (offset < dataEnd && safety < 2_000_000) {
    safety++;
    const recordHeader = view.getUint8(offset); offset += 1;
    const isCompressedTimestamp = (recordHeader & 0x80) !== 0;

    if (isCompressedTimestamp) {
      const localType = (recordHeader >> 5) & 0x03;
      const next = readDataMessage(localType, offset);
      if (next === null) break; // Definition fehlt — Datei sauber abbrechen statt kaputt weiterzulesen
      offset = next;
      continue;
    }

    const isDefinition = (recordHeader & 0x40) !== 0;
    const localType = recordHeader & 0x0f;

    if (isDefinition) {
      offset += 1; // reserviertes Byte
      const arch = view.getUint8(offset); offset += 1;
      const littleEndian = arch === 0;
      const globalMesgNum = view.getUint16(offset, littleEndian); offset += 2;
      const numFields = view.getUint8(offset); offset += 1;
      const fields = [];
      for (let i = 0; i < numFields; i++) {
        const defNum = view.getUint8(offset); offset += 1;
        const size = view.getUint8(offset); offset += 1;
        const baseType = view.getUint8(offset); offset += 1;
        fields.push({ defNum, size, baseType });
      }
      const devFields = [];
      if (recordHeader & 0x20) { // Definition enthält Developer-Felder
        const numDevFields = view.getUint8(offset); offset += 1;
        for (let i = 0; i < numDevFields; i++) {
          const size = view.getUint8(offset + 1); // [fieldNum, size, devDataIndex]
          devFields.push({ size });
          offset += 3;
        }
      }
      localDefs[localType] = { globalMesgNum, fields, littleEndian, devFields };
      continue;
    }

    const next = readDataMessage(localType, offset);
    if (next === null) break;
    offset = next;
  }

  // Auch hier: nur jeden 3. Punkt behalten, reicht für Map-Matching
  return points.filter((_, i) => i % 3 === 0);
}

async function handleGpxFilesSelected(fileList) {
  const files = Array.from(fileList).filter(f => {
    const name = f.name.toLowerCase();
    return name.endsWith('.gpx') || name.endsWith('.fit.gz') || name.endsWith('.fit');
  });
  const statusEl = document.getElementById('gpxImportStatus');
  const resetBtn = document.getElementById('gpxResetBtn');

  if (!files.length) {
    statusEl.textContent = '⚠️ Keine unterstützten Dateien ausgewählt (.gpx, .fit oder .fit.gz).';
    return;
  }

  statusEl.textContent = `⏳ Importiere ${files.length} Aktivität(en)…`;

  let newPoints = [];
  let failed = 0;
  for (const file of files) {
    const name = file.name.toLowerCase();
    try {
      let pts;
      if (name.endsWith('.gpx')) {
        const text = await file.text();
        pts = parseGpxFile(text);
      } else if (name.endsWith('.fit.gz')) {
        const compressed = await file.arrayBuffer();
        const raw = await decompressGzip(compressed);
        pts = parseFit(raw);
      } else { // .fit unkomprimiert
        const raw = await file.arrayBuffer();
        pts = parseFit(raw);
      }
      newPoints = newPoints.concat(pts);
    } catch (err) {
      console.warn('⚠️ Fehler beim Parsen von', file.name, ':', err.message);
      failed++;
    }
  }

  riddenTrackPoints = riddenTrackPoints.concat(newPoints);
  riddenSpatialIndex = buildRiddenSpatialIndex(riddenTrackPoints);
  saveRiddenPointsToStorage();

  const okCount = files.length - failed;
  let rebuildNote = ' Route neu erkunden, um die Änderung zu sehen.';

  // Falls schon ein Straßennetz geladen ist, sofort neu bauen statt auf
  // einen erneuten Standort-Fetch zu warten.
  if (lastOsmData && typeof graph !== 'undefined') {
    graph = buildGraphFromOsm(lastOsmData, nodeElevations);
    if (startLocation) startNodeId = findNearestNode(graph.nodeCoords, startLocation);
    drawNetwork(graph);
    rebuildNote = ' Straßennetz aktualisiert — bereit für eine neue Route.';
    console.log('🔗 Graph nach GPX-Import neu gebaut');
  }

  statusEl.textContent = `✅ ${okCount} Aktivität(en) importiert, ${riddenTrackPoints.length} Streckenpunkte insgesamt.` +
    (failed ? ` (${failed} fehlgeschlagen)` : '') +
    rebuildNote;
  resetBtn.style.display = 'block';

  console.log('✅ Import fertig:', okCount, 'Dateien,', riddenTrackPoints.length, 'Punkte gesamt');
}

function resetRiddenHistory() {
  riddenTrackPoints = [];
  riddenSpatialIndex = null;
  try { localStorage.removeItem(RIDDEN_STORAGE_KEY); } catch (err) { /* ignorieren */ }
  const statusEl = document.getElementById('gpxImportStatus');
  const resetBtn = document.getElementById('gpxResetBtn');
  statusEl.textContent = 'Noch keine Fahrhistorie importiert — "Neuland" wird simuliert.';
  resetBtn.style.display = 'none';
  console.log('🗑️ Fahrhistorie zurückgesetzt');
}

// ---- Gespeicherte Schnelladressen (Zuhause + 2 weitere) -------------------

const QUICK_LOCATIONS_STORAGE_KEY = 'novaroute_quick_locations_v1';
const QUICK_LOCATION_SLOTS = [
  { id: 'home', defaultLabel: '🏠 Zuhause', fixedLabel: true },
  { id: 'slot1', defaultLabel: 'Ort 1', fixedLabel: false },
  { id: 'slot2', defaultLabel: 'Ort 2', fixedLabel: false },
];

function loadQuickLocations() {
  try {
    const raw = localStorage.getItem(QUICK_LOCATIONS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn('⚠️ Konnte gespeicherte Adressen nicht laden:', err.message);
    return {};
  }
}

function saveQuickLocations(data) {
  try {
    localStorage.setItem(QUICK_LOCATIONS_STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.warn('⚠️ Konnte gespeicherte Adressen nicht speichern:', err.message);
  }
}

// Trägt eine gespeicherte Adresse in das Feld ein, das der Nutzer zuletzt
// benutzt hat (Start oder Ziel) — nicht immer fest ins Start-Feld.
function applyQuickLocation(entry) {
  if (activeLocationField === 'end') {
    setEndLocation({ lat: entry.lat, lng: entry.lng }, entry.label);
  } else {
    setStartLocation({ lat: entry.lat, lng: entry.lng }, entry.label);
  }
}

function saveCurrentAsQuickLocation(slot) {
  const isEnd = activeLocationField === 'end';
  const currentLoc = isEnd ? endLocation : startLocation;
  const hasLoc = isEnd ? !!endLocation : startLocationSetByUser;
  if (!hasLoc) {
    alert('Bitte zuerst einen Ort in das aktive Feld eingeben, dann hier speichern.');
    return;
  }
  let label = slot.defaultLabel;
  if (!slot.fixedLabel) {
    const input = prompt('Name für diese Adresse:', slot.defaultLabel);
    if (input === null) return; // abgebrochen
    if (input.trim()) label = input.trim();
  }
  const data = loadQuickLocations();
  data[slot.id] = { label, lat: currentLoc.lat, lng: currentLoc.lng };
  saveQuickLocations(data);
  renderQuickLocations();
}

// Baut die Schnelladressen-Buttons jedes Mal komplett neu aus dem
// gespeicherten Zustand auf. Jeder Button bekommt seinen eigenen Klick-
// Handler mit der jeweils EIGENEN, bereits aufgelösten `entry`/`slot` im
// Funktionsabschluss (kein Nachschlagen per ID beim Klick nötig) — dadurch
// ist ausgeschlossen, dass ein Klick auf "Ort 2" versehentlich "Zuhause"
// auslöst.
function renderQuickLocations() {
  const container = document.getElementById('quickLocations');
  if (!container) return;
  const saved = loadQuickLocations();
  container.innerHTML = '';

  QUICK_LOCATION_SLOTS.forEach(slot => {
    const entry = saved[slot.id];
    const wrapper = document.createElement('span');
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';

    if (entry) {
      const btn = document.createElement('button');
      btn.className = 'quick-loc-btn';
      btn.textContent = entry.label;
      btn.title = `In aktives Adressfeld übernehmen: ${entry.label}`;
      btn.addEventListener('click', () => applyQuickLocation(entry));
      wrapper.appendChild(btn);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'quick-loc-clear';
      clearBtn.textContent = '✕';
      clearBtn.title = `${entry.label} entfernen`;
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const data = loadQuickLocations();
        delete data[slot.id];
        saveQuickLocations(data);
        renderQuickLocations();
      });
      wrapper.appendChild(clearBtn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'quick-loc-btn quick-loc-btn--empty';
      btn.textContent = `+ ${slot.defaultLabel} speichern`;
      btn.title = 'Ort des aktiven Adressfeldes hier speichern';
      btn.addEventListener('click', () => saveCurrentAsQuickLocation(slot));
      wrapper.appendChild(btn);
    }

    container.appendChild(wrapper);
  });
}

// Aktuelles Windfeld: mehrere Live-Messpunkte, aus denen an jeder beliebigen
// Position auf der Karte per Inverse-Distanz-Gewichtung interpoliert wird.
let windFieldPoints = []; // [{ lat, lng, u, v, speed }]  u/v = Wind-Vektorkomponenten (m/s)
let windFieldAbortController = null;
let windFieldLastFetchAt = 0;
let windFieldLastKey = '';

// Baut ein n×n Gitter, das GENAU den übergebenen Kartenausschnitt (bounds)
// abdeckt — dadurch passt sich das Windfeld beim Zoomen/Verschieben immer
// an das an, was gerade sichtbar ist, statt an einem festen Radius um den
// ursprünglichen Startpunkt festzuhalten.
function buildWindGridForBounds(bounds, n = 4) {
  const points = [];
  // Etwas Rand über den sichtbaren Ausschnitt hinaus, damit auch die
  // Kartenränder beim Verschieben nicht sofort ohne Daten dastehen.
  const padLat = (bounds.north - bounds.south) * 0.15;
  const padLng = (bounds.east - bounds.west) * 0.15;
  const south = bounds.south - padLat, north = bounds.north + padLat;
  const west = bounds.west - padLng, east = bounds.east + padLng;

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      points.push({
        lat: south + (row / (n - 1)) * (north - south),
        lng: west + (col / (n - 1)) * (east - west),
      });
    }
  }
  return points;
}

// Lädt Live-Wind an einem Gitter aus Messpunkten, das den aktuell sichtbaren
// Kartenausschnitt abdeckt (ein einziger API-Request mit kommagetrennten
// Koordinaten) und speichert sie als Vektorfeld für die Partikel-Animation.
async function loadWindField(bounds) {
  // Leichtes Throttling + Cache-Key, damit nicht bei jedem kleinen Ruckler
  // während des Zoomens ein neuer Request rausgeht.
  const key = `${bounds.south.toFixed(2)}_${bounds.north.toFixed(2)}_${bounds.west.toFixed(2)}_${bounds.east.toFixed(2)}`;
  const now = Date.now();
  if (key === windFieldLastKey && now - windFieldLastFetchAt < 4000) return;
  windFieldLastKey = key;
  windFieldLastFetchAt = now;

  if (windFieldAbortController) windFieldAbortController.abort();
  windFieldAbortController = new AbortController();

  const gridPoints = buildWindGridForBounds(bounds, 4); // 4×4 = 16 Punkte, über den ganzen sichtbaren Bereich verteilt
  const lats = gridPoints.map(p => p.lat.toFixed(4)).join(',');
  const lngs = gridPoints.map(p => p.lng.toFixed(4)).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&current=wind_speed_10m,wind_direction_10m&timezone=auto`;

  try {
    const timeoutId = setTimeout(() => windFieldAbortController.abort(), 8000);
    const res = await fetch(url, { signal: windFieldAbortController.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const results = Array.isArray(data) ? data : [data];

    windFieldPoints = results.map((r, i) => {
      if (!r || !r.current || !gridPoints[i]) return null;
      const speed = r.current.wind_speed_10m;
      const dirFromDeg = r.current.wind_direction_10m; // "kommt aus" Richtung
      const towardRad = (dirFromDeg + 180) * Math.PI / 180; // wohin der Wind weht
      return {
        lat: gridPoints[i].lat,
        lng: gridPoints[i].lng,
        speed,
        u: speed * Math.sin(towardRad), // Ost-Komponente
        v: speed * Math.cos(towardRad), // Nord-Komponente
      };
    }).filter(Boolean);

    console.log('✅ Windfeld aktualisiert:', windFieldPoints.length, 'Messpunkte für sichtbaren Ausschnitt');
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn('⚠️ Windfeld konnte nicht geladen werden:', err.message);
  }
}

// Interpoliert Windgeschwindigkeit/-richtung an einer beliebigen Position
// per Inverse-Distanz-Gewichtung über die geladenen Messpunkte.
function interpolateWind(lat, lng) {
  if (!windFieldPoints.length) return null;
  let sumW = 0, sumU = 0, sumV = 0;
  for (const pt of windFieldPoints) {
    const d = haversine({ lat, lng }, { lat: pt.lat, lng: pt.lng }) + 0.05;
    const w = 1 / (d * d);
    sumW += w;
    sumU += pt.u * w;
    sumV += pt.v * w;
  }
  const u = sumU / sumW, v = sumV / sumW;
  return { speed: Math.hypot(u, v), towardRad: Math.atan2(u, v) };
}

// ---- Animierte Windkarte im Stil von Apple Wetter / Windy —---------------
// Fließende, leicht verblassende Partikel-Linien statt statischer Pfeile.
// Läuft nur, während der Layer eingeschaltet ist (spart Akku/CPU).

const WIND_PARTICLE_COUNT = 200;
const WIND_TRAIL_FADE = 0.92;   // näher an 1 = längere Schweife
const WIND_MAX_AGE = 110;       // Frames bis ein Partikel neu gestartet wird

const WindFlowLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'wind-flow-canvas');
    const pane = map.getPane('overlayPane');
    pane.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    this._onMove = () => this._reposition();
    this._onMoveEnd = () => {
      this._resize();
      this._resetParticles();
      this._refreshWindField(); // Windfeld an neu sichtbaren Ausschnitt anpassen (Zoom/Verschieben)
    };
    this._onResize = () => { this._resize(); this._resetParticles(); };

    map.on('move', this._onMove);
    map.on('moveend', this._onMoveEnd);
    map.on('resize', this._onResize);

    this._resize();
    this._reposition();
    this._resetParticles();
    this._running = true;
    this._tick();

    // Aktuelles Wind-Vektorfeld für den sichtbaren Kartenausschnitt laden
    this._refreshWindField();
  },

  _refreshWindField() {
    const b = this._map.getBounds();
    loadWindField({
      south: b.getSouth(), north: b.getNorth(),
      west: b.getWest(), east: b.getEast(),
    });
  },

  onRemove(map) {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    map.off('move', this._onMove);
    map.off('moveend', this._onMoveEnd);
    map.off('resize', this._onResize);
    L.DomUtil.remove(this._canvas);
  },

  _resize() {
    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
  },

  _reposition() {
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
  },

  _spawnParticle(size) {
    return {
      x: Math.random() * size.x,
      y: Math.random() * size.y,
      age: Math.floor(Math.random() * WIND_MAX_AGE),
    };
  },

  _resetParticles() {
    const size = this._map.getSize();
    this._particles = [];
    for (let i = 0; i < WIND_PARTICLE_COUNT; i++) {
      this._particles.push(this._spawnParticle(size));
    }
  },

  _tick() {
    if (!this._running) return;
    this._draw();
    this._rafId = requestAnimationFrame(() => this._tick());
  },

  _draw() {
    const ctx = this._ctx;
    const size = this._map.getSize();
    if (!ctx || size.x === 0 || size.y === 0) return;

    // Bisherige Spuren leicht ausbleichen lassen statt komplett löschen —
    // dadurch entstehen die typischen fließenden Schweife.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${WIND_TRAIL_FADE})`;
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = 'source-over';

    if (!windFieldPoints.length || !this._particles) return;

    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';

    this._particles.forEach(p => {
      const latlng = this._map.containerPointToLatLng([p.x, p.y]);
      const vec = interpolateWind(latlng.lat, latlng.lng);
      if (!vec) return;

      const speedPx = Math.max(0.4, Math.min(3.2, vec.speed * 0.18));
      const nx = p.x + Math.sin(vec.towardRad) * speedPx;
      const ny = p.y - Math.cos(vec.towardRad) * speedPx;

      const kmh = vec.speed * 3.6;
      const alpha = Math.min(0.95, 0.55 + kmh / 45);
      ctx.strokeStyle = `rgba(13, 42, 148, ${alpha})`; // sattes Dunkelblau

      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      p.x = nx; p.y = ny; p.age++;

      if (p.age > WIND_MAX_AGE || p.x < 0 || p.x > size.x || p.y < 0 || p.y > size.y) {
        Object.assign(p, this._spawnParticle(size));
      }
    });
  },
});

const windFlowLayer = new WindFlowLayer();

// OSM als Standard setzen
osmLayer.addTo(map);

// Layer-Schalter hinzufügen
const layerControl = L.control.layers(
  {
    '🗺️ Grafisch': osmLayer,
    '🛰️ Satellit': satelliteLayer,
    '🏔️ Gelände': terrainLayer,
  },
  {
    '💨 Live-Windkarte': windFlowLayer,
  },
  { position: 'topright', collapsed: false }
);
layerControl.addTo(map);
console.log('✅ LayerControl hinzugefügt mit 3 Basis-Layer + animierter Wind-Overlay');


function bboxAround(center, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos(center.lat * Math.PI / 180));
  return {
    south: center.lat - dLat, north: center.lat + dLat,
    west: center.lng - dLng, east: center.lng + dLng,
  };
}

// ---- 3. Echtes Straßennetz von OpenStreetMap laden -----------------------

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
const OVERPASS_ATTEMPT_TIMEOUT_MS = 30000; // pro Server und Versuch
const OVERPASS_ROUNDS = 2;                 // so oft wird die komplette Serverliste durchprobiert
// Nur wichtige Straßentypen — keine Tracks, Parkplätze, Fußwege
const HIGHWAY_TYPES = 'primary|secondary|tertiary|unclassified|residential|living_street|cycleway|track';

function buildOverpassQuery(bbox) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  // Timeout auf 10 Sekunden reduziert, nur Straßen (keine Relationen)
  return `[out:json][timeout:30];
    way["highway"~"^(${HIGHWAY_TYPES})$"](${bboxStr});
    out body;
    >;
    out skel qt;`;
}

// Netzwerk-Cache
const networkCache = new Map();

async function fetchRoadNetwork(location = startLocation, onProgress = () => {}) {
  const cacheKey = `${Math.round(location.lat * 100)}_${Math.round(location.lng * 100)}`;
  
  // Prüfe Cache zuerst
  if (networkCache.has(cacheKey)) {
    console.log('💾 Nutze gecachtes Straßennetz für', cacheKey);
    return networkCache.get(cacheKey);
  }
  
  console.log('🌍 Lade Straßennetz von Overpass (parallel)…');
  const bbox = bboxAround(location, RADIUS_KM);
  const query = buildOverpassQuery(bbox);
  onProgress('Frage Kartenserver an…');

  // Alle Server GLEICHZEITIG anfragen — der erste, der antwortet, gewinnt.
  // Die öffentlichen Overpass-Server sind oft überlastet (HTTP 502/504 oder
  // sehr langsam). Deshalb: mehrere Spiegelserver, großzügigeres Timeout und
  // eine zweite Runde nach kurzer Pause, bevor ein Fehler gemeldet wird.
  async function tryAllServersOnce() {
    const controllers = [];
    const attempts = OVERPASS_URLS.map(async (url, idx) => {
      const controller = new AbortController();
      controllers.push(controller);
      const timeoutId = setTimeout(() => controller.abort(), OVERPASS_ATTEMPT_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: query,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} (Server ${idx + 1})`);
        const data = await res.json();
        clearTimeout(timeoutId);
        if (!data.elements) throw new Error(`Leere Antwort (Server ${idx + 1})`);
        return data;
      } catch (err) {
        clearTimeout(timeoutId);
        throw new Error(`Server ${idx + 1}: ${err.message}`);
      }
    });
    try {
      const data = await Promise.any(attempts);
      controllers.forEach(c => c.abort()); // langsamere Anfragen abbrechen, Gewinner steht fest
      return data;
    } catch (aggregateErr) {
      if (aggregateErr.errors) aggregateErr.errors.forEach(e => console.error('  →', e.message));
      throw aggregateErr;
    }
  }

  for (let round = 1; round <= OVERPASS_ROUNDS; round++) {
    try {
      const data = await tryAllServersOnce();
      networkCache.set(cacheKey, data);
      console.log('✅ Straßennetz geladen & gecacht:', data.elements.length, 'Elemente');
      return data;
    } catch (err) {
      console.error(`❌ Runde ${round}/${OVERPASS_ROUNDS}: alle Overpass-Server fehlgeschlagen`);
      if (round < OVERPASS_ROUNDS) {
        onProgress('Kartenserver überlastet — neuer Versuch…');
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw new Error('Die Kartenserver sind gerade überlastet. In ein paar Minuten erneut versuchen.');
}

// Baut aus den rohen OSM-Elementen einen Graphen aus Knoten/Kanten.
// "ridden" wird pro Straße (Way) einmal gewürfelt, nicht pro Segment,
// damit eine ganze Straße konsistent als bekannt/unbekannt gilt.
// `elevations` (optional): Map<nodeId, Höhe in Metern> — wenn übergeben,
// wird die Steigung pro Kante RICHTUNGSABHÄNGIG aus echten Höhendaten
// berechnet (nur der tatsächliche Anstieg zählt), statt zufällig simuliert.
function buildGraphFromOsm(osmData, elevations) {
  const nodeCoords = new Map();
  const ways = [];

  osmData.elements.forEach(el => {
    if (el.type === 'node') {
      nodeCoords.set(el.id, { lat: el.lat, lng: el.lon });
    } else if (el.type === 'way' && el.nodes && el.nodes.length > 1) {
      ways.push(el);
    }
  });

  const edges = [];
  const adjacency = new Map();
  const hasRealElevation = !!(elevations && elevations.size);

  function addEdge(edge) {
    edges.push(edge);
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, []);
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, []);

    let hmGainAB, hmGainBA;
    if (hasRealElevation && elevations.has(edge.a) && elevations.has(edge.b)) {
      const elevA = elevations.get(edge.a), elevB = elevations.get(edge.b);
      hmGainAB = Math.max(0, elevB - elevA); // Anstieg beim Fahren von a nach b
      hmGainBA = Math.max(0, elevA - elevB); // Anstieg beim Fahren von b nach a
    } else {
      // Fallback ohne echte Höhendaten: symmetrische Zufalls-Simulation
      hmGainAB = hmGainBA = edge.hmGainFallback;
    }

    adjacency.get(edge.a).push({ edgeId: edge.id, to: edge.b, dist: edge.dist, ridden: edge.ridden, hmGain: hmGainAB, mainRoad: edge.mainRoad });
    adjacency.get(edge.b).push({ edgeId: edge.id, to: edge.a, dist: edge.dist, ridden: edge.ridden, hmGain: hmGainBA, mainRoad: edge.mainRoad });
  }

  ways.forEach(way => {
    const coords = way.nodes.map(id => nodeCoords.get(id)).filter(Boolean);
    if (coords.length < 2) return;

    // Bevorzugt: echter Abgleich mit importierter Fahrhistorie (GPX).
    // isNearRiddenTrack gibt `null` zurück, wenn noch gar keine Historie
    // importiert wurde — dann fällt die Straße auf die alte Zufalls-
    // Simulation zurück, damit die App auch ohne Import nutzbar bleibt.
    const midpoint = coords[Math.floor(coords.length / 2)];
    const matched = isNearRiddenTrack(midpoint.lat, midpoint.lng);
    let ridden;
    if (matched !== null) {
      ridden = matched;
    } else {
      const distFromHome = haversine(CENTER, midpoint);
      const rideProb = Math.max(0.08, 0.8 - distFromHome * 0.12);
      ridden = Math.random() < rideProb;
    }
    const slope = Math.random() * 35; // Fallback-Hm/km, nur genutzt ohne echte Höhendaten

    // Große, verkehrsreiche Straßen (für den "Hauptstraßen meiden"-Regler)
    const highwayType = way.tags && way.tags.highway;
    const isMainRoad = highwayType === 'primary' || highwayType === 'trunk' || highwayType === 'secondary';

    for (let i = 0; i < way.nodes.length - 1; i++) {
      const aId = way.nodes[i], bId = way.nodes[i + 1];
      const a = nodeCoords.get(aId), b = nodeCoords.get(bId);
      if (!a || !b) continue;
      const dist = haversine(a, b);
      if (dist === 0) continue;
      addEdge({
        id: `${way.id}_${i}`,
        a: aId, b: bId,
        aCoord: a, bCoord: b,
        dist,
        ridden,
        hmGainFallback: dist * slope,
        mainRoad: isMainRoad,
      });
    }
  });

  return { nodeCoords, edges, adjacency, hasRealElevation };
}

function findNearestNode(nodeCoords, target) {
  let best = null, bestDist = Infinity;
  nodeCoords.forEach((coord, id) => {
    const d = haversine(coord, target);
    if (d < bestDist) { bestDist = d; best = id; }
  });
  return best;
}

// ---- 4. Netz zeichnen (zwei Multi-Polylines für Performance) -------------

// Layer-Gruppe fürs Straßennetz — wird bei jedem Standortwechsel geleert und
// neu befüllt, statt das alte Netz einfach liegen zu lassen.
const networkLayerGroup = L.layerGroup().addTo(map);

function drawNetwork(graph) {
  networkLayerGroup.clearLayers();
  const riddenSegments = [];
  const unriddenSegments = [];
  graph.edges.forEach(e => {
    const seg = [[e.aCoord.lat, e.aCoord.lng], [e.bCoord.lat, e.bCoord.lng]];
    (e.ridden ? riddenSegments : unriddenSegments).push(seg);
  });

  // Weiße "Umrandung" unter den eigentlichen Linien — dadurch bleiben die
  // Straßen auch auf Satellit/Gelände-Untergrund gut sichtbar, statt in
  // ähnlich-farbigem Kartenhintergrund unterzugehen.
  L.polyline(riddenSegments, { color: '#ffffff', weight: 5.5, opacity: 0.8 }).addTo(networkLayerGroup);
  L.polyline(unriddenSegments, { color: '#ffffff', weight: 5.5, opacity: 0.8 }).addTo(networkLayerGroup);

  L.polyline(riddenSegments, { color: '#b91c1c', weight: 3.5, opacity: 1 }).addTo(networkLayerGroup);
  L.polyline(unriddenSegments, { color: '#047857', weight: 3.5, opacity: 1 }).addTo(networkLayerGroup);
}

// ---- 5. Routengenerator (läuft jetzt auf dem echten Graphen) -------------
//
// Ansatz: statt eines Zufalls-Spaziergangs mit anschließendem separaten
// Rückweg (der zwangsläufig viele Kreuzungen/Überschneidungen mit sich
// selbst produziert), werden mehrere Wegpunkte grob auf einem Kreis um den
// Startpunkt verteilt — immer in dieselbe Drehrichtung fortlaufend. Start
// und Wegpunkte werden per kostenoptimiertem kürzestem Pfad verbunden.
// Das ergibt von sich aus eine echte Rundform statt eines Kreuz-und-quer-
// Musters, und Sackgassen/unnötige Wiederholungen werden im Kostenmodell
// aktiv bestraft statt zufällig in Kauf genommen.

let routeLayer = null;
let routeHaloLayer = null; // helle Umrandung unter der Routenlinie, für Sichtbarkeit auf dunklen Kartenuntergründen
let routeArrowLayers = [];
let endMarker = null;
let currentRouteLatLngs = null; // [[lat,lng], ...] der zuletzt gezeichneten Route, für GPX-Export
let currentRouteInfo = null;    // { distKm, hm } der zuletzt gezeichneten Route

// --- Neu: Alternativen-Auswahl, Neuland-Einfärbung, Höhenprofil, Teilen, Umkehren ---
let currentRouteEdges = null;      // Edges der zuletzt gezeichneten (echten) Route, für Höhenprofil & Neuland-Einfärbung
let currentGraphRef = null;        // Graph-Referenz der zuletzt gezeichneten Route
let currentStartNodeIdRef = null;  // Start-Knoten der zuletzt gezeichneten Route
let currentAlternatives = [];      // Bis zu 3 generierte Routen-Varianten zur Auswahl
let selectedAlternativeIndex = 0;
let neulandOverlayLayers = [];     // Segmentweise Einfärbung bekannt/Neuland auf der aktuellen Route
let neulandOverlayActive = true;   // standardmäßig immer an, nicht erst nach Klick auf die Checkbox
let currentIsAB = false;
let isSharedRouteView = false;     // true, wenn die Route per Teilen-Link geladen wurde (kein Graph verfügbar)

// Kleiner Min-Heap für eine performante Dijkstra-Variante (statt linearer
// Suche nach dem nächsten Knoten bei jedem Schritt).
class MinHeap {
  constructor() { this.arr = []; }
  size() { return this.arr.length; }
  push(item) {
    this.arr.push(item);
    let i = this.arr.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.arr[p].key <= this.arr[i].key) break;
      [this.arr[p], this.arr[i]] = [this.arr[i], this.arr[p]];
      i = p;
    }
  }
  pop() {
    const top = this.arr[0];
    const last = this.arr.pop();
    if (this.arr.length) {
      this.arr[0] = last;
      let i = 0;
      const n = this.arr.length;
      while (true) {
        let l = 2 * i + 1, r = 2 * i + 2, smallest = i;
        if (l < n && this.arr[l].key < this.arr[smallest].key) smallest = l;
        if (r < n && this.arr[r].key < this.arr[smallest].key) smallest = r;
        if (smallest === i) break;
        [this.arr[smallest], this.arr[i]] = [this.arr[i], this.arr[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

// Grad jedes Knotens (Anzahl abgehender Kanten) — Knoten mit Grad 1 sind
// echte Sackgassen-Enden im Straßennetz.
function computeDegrees(graph) {
  const degree = new Map();
  graph.adjacency.forEach((list, id) => degree.set(id, list.length));
  return degree;
}

// Kostenoptimierter kürzester Pfad zwischen zwei Knoten. Anders als reine
// Distanz-Minimierung fließen hier fünf Dinge in die Kosten jeder Kante ein:
//  - Neuland-Bias: unbefahrene Straßen werden günstiger, bekannte teurer,
//    je nach Regler-Stellung.
//  - Wiederholungs-Strafe: Kanten, die in dieser Route schon benutzt wurden,
//    werden bei jeder weiteren Nutzung deutlich unattraktiver.
//  - Sackgassen-Strafe: Knoten mit nur einer abgehenden Kante werden
//    stark gemieden, außer sie sind genau das Ziel dieses Abschnitts.
//  - Kreuzungs-Strafe: Knoten, die die Route an früherer Stelle schon einmal
//    besucht hat, werden stark gemieden — das ist der Haupthebel gegen
//    Selbstüberschneidungen der Strecke.
//  - Hauptstraßen-Strafe: große/verkehrsreiche Straßen werden je nach
//    Regler-Stellung teurer, damit die Route sie eher meidet.
function leastCostPath(graph, fromId, toId, { neulandBias = 0, usedCount, degree, visitedNodes, windAvoidance = 50, avoidMainRoads = 0, hmBias = 0 }) {
  if (fromId === toId) return [];
  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const settled = new Set();
  const heap = new MinHeap();
  heap.push({ key: 0, id: fromId });

  // windAvoidance: 0 = Gegenwind stark meiden, 100 = Wind ist egal
  // Nur aktiv, wenn Live-Wind-Daten vorhanden sind
  const windActive = currentWindData && windAvoidance > 0;
  const windDirRad = windActive ? currentWindData.windDirection * Math.PI / 180 : 0;
  // Wie stark Gegenwind-Kanten bestraft werden: bei 0% maximal, bei 100% gar nicht
  // windAvoidance: 0 = Wind komplett egal, 100 = Gegenwind so stark wie möglich meiden
  const windStrength = windActive ? (windAvoidance / 100) * 1.8 : 0;

  // avoidMainRoads: 0 = egal, 100 = Hauptstraßen so stark wie möglich meiden
  const mainRoadStrength = (avoidMainRoads / 100) * 2.5;

  function edgeCost(e, fromNodeId) {
    let cost = e.dist;
    // neulandBias > 0: unbekannte Straßen bevorzugen · < 0: bekannte bevorzugen · 0: neutral
    if (neulandBias >= 0) {
      cost *= e.ridden ? (1 + neulandBias * 2.2) : (1 - neulandBias * 0.55);
    } else {
      cost *= e.ridden ? (1 + neulandBias * 0.55) : (1 - neulandBias * 2.2);
    }
    const used = usedCount.get(e.edgeId) || 0;
    if (used > 0) cost *= 1 + used * 2.5;
    const toDeg = degree.get(e.to) || 2;
    // Sackgassen werden praktisch komplett gemieden — nur wenn sie wirklich
    // das Ziel des Abschnitts sind, werden sie überhaupt in Betracht gezogen.
    if (toDeg <= 1 && e.to !== toId) cost *= 60;
    if (visitedNodes && visitedNodes.has(e.to)) cost *= 7;

    // Hauptstraßen-Bestrafung
    if (mainRoadStrength > 0 && e.mainRoad) {
      cost *= (1 + mainRoadStrength);
    }

    // Höhenmeter-Steuerung: hmBias > 0 bedeutet "mehr Steigung gesucht"
    // (steile Kanten werden günstiger), hmBias < 0 bedeutet "eher flach
    // gesucht" (steile Kanten werden teurer). |hmBias| ≤ 1.
    if (hmBias !== 0 && e.hmGain > 0) {
      const climbRatePerKm = e.hmGain / Math.max(e.dist, 0.01); // Hm pro km auf dieser Kante
      const normalized = Math.min(1.5, climbRatePerKm / 30); // 0..1.5, 30 Hm/km ≈ steil
      cost *= Math.max(0.25, 1 - hmBias * normalized * 0.5);
    }

    // Wind-Bestrafung: Kante gegen den Wind wird teurer
    if (windStrength > 0) {
      const a = graph.nodeCoords.get(fromNodeId);
      const b = graph.nodeCoords.get(e.to);
      if (a && b) {
        const edgeDirRad = Math.atan2(b.lng - a.lng, b.lat - a.lat);
        // Wind "kommt aus" windDirRad → weht Richtung windDirRad + 180°
        const windBlowsTowardRad = windDirRad + Math.PI;
        let angleDiff = Math.abs(edgeDirRad - windBlowsTowardRad);
        while (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        // Fährt man entgegen der Windrichtung (angleDiff nahe π) → Gegenwind
        const headwindFactor = Math.max(0, Math.cos(angleDiff) * -1); // 0..1, 1 = voller Gegenwind
        cost *= (1 + headwindFactor * windStrength);
      }
    }

    return Math.max(cost, 0.001);
  }

  while (heap.size()) {
    const { key: d, id: cur } = heap.pop();
    if (settled.has(cur)) continue;
    settled.add(cur);
    if (cur === toId) break;

    for (const e of (graph.adjacency.get(cur) || [])) {
      if (settled.has(e.to)) continue;
      const alt = d + edgeCost(e, cur);
      if (alt < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, alt);
        prev.set(e.to, { from: cur, edge: e });
        heap.push({ key: alt, id: e.to });
      }
    }
  }

  if (!prev.has(toId)) return null; // kein Pfad erreichbar
  const edgesOut = [];
  let n = toId;
  while (n !== fromId) {
    const p = prev.get(n);
    if (!p) return null;
    edgesOut.push(p.edge);
    n = p.from;
  }
  return edgesOut.reverse();
}

// Punkt auf der Erdoberfläche in gegebener Peilung/Distanz vom Zentrum —
// dient dazu, die groben Wegpunkte auf dem Kreis zu platzieren.
function pointAtBearing(center, bearingDeg, distKm) {
  const R = 6371;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = center.lat * Math.PI / 180, lng1 = center.lng * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distKm / R) + Math.cos(lat1) * Math.sin(distKm / R) * Math.cos(brng)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(distKm / R) * Math.cos(lat1),
    Math.cos(distKm / R) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: lat2 * 180 / Math.PI, lng: ((lng2 * 180 / Math.PI + 540) % 360) - 180 };
}

// Wie viel länger ein Abschnitt wegen des Neuland-Bias höchstens werden darf
// als der direkte (nicht-verzerrte) Weg — verhindert wildes Zickzack durch
// Nebenstraßen nur um einzelne unbefahrene Segmente mitzunehmen.
const DETOUR_CAP = 1.35;

// Ein einzelner Versuch bei gegebenem Radius: legt numWaypoints Punkte auf
// einem Kreis um den Start (immer in dieselbe Richtung fortlaufend) und
// verbindet Start → Wegpunkt 1 → … → Wegpunkt N → Start jeweils per
// kostenoptimiertem kürzestem Pfad. Zählt dabei mit, wie oft die Route
// einen Knoten mehrfach besucht (= Selbstüberschneidung auf der Karte).
function attemptLoopRoute(graph, degree, startNodeId, neulandPct, radiusKm, numWaypoints, startAngle, clockwise, windAvoidance = 50, avoidMainRoads = 0, targetKm = 0, targetHm = 0) {
  const neulandBias = neulandPct / 100;
  const usedCount = new Map();
  const visitCount = new Map(); // Knoten-ID -> wie oft besucht (Start ausgenommen)
  const visitedNodes = new Set(); // für die Kostenfunktion des Pfadfinders
  const usedEdges = [];
  let distSoFar = 0;
  let hmSoFar = 0;
  let currentId = startNodeId;
  const direction = clockwise ? 1 : -1;

  function pathDist(edges) { return edges.reduce((s, e) => s + e.dist, 0); }

  function addLeg(targetNodeId) {
    // Progressiver Höhenmeter-Bias: Wie weit liegt der bisher gesammelte
    // Anstieg vom Soll-Wert AN DIESER STELLE DER STRECKE entfernt? Das
    // steuert die Pfadsuche aktiv Richtung Ziel, statt nur hinterher zu
    // vergleichen — verhindert vor allem, dass am Streckenende gar keine
    // Chance mehr besteht, den Rückstand aufzuholen.
    let hmBias = 0;
    if (targetHm > 0 && targetKm > 0) {
      const expectedHmSoFar = targetHm * (distSoFar / targetKm);
      const deficit = expectedHmSoFar - hmSoFar; // positiv = liegt hinter dem Soll zurück
      hmBias = Math.max(-1, Math.min(1, deficit / (targetHm * 0.25)));
    }

    const biasedEdges = leastCostPath(graph, currentId, targetNodeId, { neulandBias, usedCount, degree, visitedNodes, windAvoidance, avoidMainRoads, hmBias });
    if (!biasedEdges) return false; // kein Pfad zu diesem Wegpunkt — überspringen

    let legEdges = biasedEdges;
    // Nur wenn der Neuland-Umweg nicht ausufert, ihn auch nehmen — sonst den
    // direkteren Weg (gleiche Sackgassen-/Wiederholungs-Regeln, aber ohne
    // Neuland-Bonus), damit die Route eine erkennbare Runde bleibt.
    if (neulandBias !== 0) {
      const directEdges = leastCostPath(graph, currentId, targetNodeId, { neulandBias: 0, usedCount, degree, visitedNodes, windAvoidance, avoidMainRoads, hmBias });
      if (directEdges && pathDist(biasedEdges) > pathDist(directEdges) * DETOUR_CAP) {
        legEdges = directEdges;
      }
    }

    legEdges.forEach(e => {
      usedCount.set(e.edgeId, (usedCount.get(e.edgeId) || 0) + 1);
      usedEdges.push(e);
      distSoFar += e.dist;
      hmSoFar += e.hmGain;
      if (e.to !== startNodeId) {
        visitCount.set(e.to, (visitCount.get(e.to) || 0) + 1);
        visitedNodes.add(e.to);
      }
    });
    currentId = targetNodeId;
    return true;
  }

  for (let i = 1; i <= numWaypoints; i++) {
    const angle = (startAngle + direction * (360 / numWaypoints) * i + 360) % 360;
    const targetPoint = pointAtBearing(CENTER, angle, radiusKm);
    const targetNodeId = findNearestNode(graph.nodeCoords, targetPoint);
    if (targetNodeId !== currentId) addLeg(targetNodeId);
  }
  addLeg(startNodeId); // Runde schließen

  const unriddenDist = usedEdges.filter(e => !e.ridden).reduce((s, e) => s + e.dist, 0);
  const neulandScore = usedEdges.length ? Math.round((unriddenDist / distSoFar) * 100) : 0;

  // Jede weitere Nutzung eines schon besuchten Knotens ist eine Kreuzung.
  let crossings = 0;
  visitCount.forEach(count => { if (count > 1) crossings += count - 1; });

  return {
    edges: usedEdges,
    distKm: distSoFar,
    hm: Math.round(hmSoFar),
    neulandScore,
    crossings,
  };
}

// A-B-Routing mit Varianten: Generiert mehrere Routen mit unterschiedlichen Neuland-Anteilen
// und returned die Varianten sowie die kürzeste Route separat
function generateABRoute(graph, fromNodeId, toNodeId, targetKm, neulandPct, windAvoidance = 50, avoidMainRoads = 0, targetHm = 0) {
  const degree = computeDegrees(graph);

  // Statischer Hm-Bias für A-B-Strecken (keine Etappen wie bei der Rundtour,
  // daher kein progressiver Abgleich möglich — stattdessen: gewünschte
  // Steigungsrate (Hm/km) gegen einen normalen Terrain-Richtwert (15 Hm/km)
  // vergleichen und die Pfadsuche entsprechend Richtung mehr/weniger
  // Steigung lenken.
  let hmBias = 0;
  if (targetHm > 0 && targetKm > 0) {
    const desiredRatePerKm = targetHm / targetKm;
    const baselineRatePerKm = 15; // grober Richtwert für "normales" Terrain
    hmBias = Math.max(-1, Math.min(1, (desiredRatePerKm - baselineRatePerKm) / baselineRatePerKm));
  }
  
  function computeRoute(bias) {
    const usedCount = new Map();
    const visitedNodes = new Set();
    const edges = leastCostPath(graph, fromNodeId, toNodeId, {
      neulandBias: bias,
      usedCount,
      degree,
      visitedNodes,
      windAvoidance,
      avoidMainRoads,
      hmBias,
    });
    
    if (!edges) return null;
    
    let distKm = 0;
    let hm = 0;
    edges.forEach(e => {
      distKm += e.dist;
      hm += e.hmGain;
    });
    
    const unriddenDist = edges.filter(e => !e.ridden).reduce((s, e) => s + e.dist, 0);
    const neulandScore = edges.length ? Math.round((unriddenDist / distKm) * 100) : 0;
    let crossings = 0;
    visitedNodes.forEach(id => {
      const count = (visitedNodes.has(id) ? 1 : 0);
      if (count > 1) crossings++;
    });
    
    return { edges, distKm, hm: Math.round(hm), neulandScore, crossings };
  }
  
  // Generiere mehrere Varianten
  const variants = [];
  const labels = ['Deine Einstellung', 'Direkteste Route', 'Ausgewogener Mittelweg'];

  // Variant 1: Mit aktuellem Neuland-Bias (Nutzer-Einstellung)
  const variant1 = computeRoute(neulandPct / 100);
  if (variant1) variants.push(variant1);

  // Variant 2: 0% Neuland (kürzeste Route) - nur wenn anders als Variant 1
  if (neulandPct !== 0) {
    const variant2 = computeRoute(0);
    if (variant2) variants.push(variant2);
  }

  // Variant 3: 50% Neuland (Mittelweg) - nur wenn anders als beide
  if (neulandPct !== 50 && neulandPct !== 0) {
    const variant3 = computeRoute(0.5);
    if (variant3) variants.push(variant3);
  }

  if (variants.length === 0) return null;

  // Kürzeste Route ist die mit der kleinsten Distanz
  const shortest = variants.reduce((a, b) => a.distKm < b.distKm ? a : b);

  // Jede Variante bekommt Fit-Score, verständliche Begründung, Label und
  // einen Verweis auf die kürzeste Route (für die Vergleichs-Linie auf der Karte) —
  // damit sich A-B-Varianten wie Rundtour-Alternativen als Auswahlkarten anzeigen lassen.
  variants.forEach((v, i) => {
    v.isAB = true;
    v.shortestRoute = shortest;
    v.fitScore = scoreRouteFit(v, targetKm, targetHm, neulandPct).total;
    v.explanation = buildRouteExplanation(v, targetKm, targetHm, neulandPct, windAvoidance, avoidMainRoads, variants.length, v.fitScore);
    v.label = labels[i] || `Variante ${i + 1}`;
  });

  // Return Format: Die Varianten + Info über die kürzeste
  return {
    variants,      // Alle Varianten zur Anzeige
    alternatives: variants,
    shortestIndex: variants.indexOf(shortest),  // Index der kürzesten
  };
}

// ---- Bewertung, wie gut eine Route zu den gewünschten Einstellungen passt --
// (ersetzt den reinen Distanz+Höhenmeter-Vergleich durch eine ganzheitliche
// Bewertung inkl. Neuland-Anteil — das ist die Grundlage für die "Warum
// diese Route"-Erklärung, die dem Nutzer nach der Generierung angezeigt wird)

function scoreRouteFit(attempt, targetKm, targetHm, neulandPct) {
  const kmDeviation = targetKm > 0 ? Math.abs(attempt.distKm - targetKm) / targetKm : 0;
  const kmScore = Math.max(0, 100 - kmDeviation * 250);

  let hmScore = 100;
  if (targetHm > 0) {
    const hmDeviation = Math.abs(attempt.hm - targetHm) / targetHm;
    hmScore = Math.max(0, 100 - hmDeviation * 200);
  }

  const neulandDeviation = Math.abs(attempt.neulandScore - neulandPct);
  const neulandScoreFit = Math.max(0, 100 - neulandDeviation * 1.5);

  const crossingsPenalty = Math.min(40, attempt.crossings * 12);

  const total = Math.max(0, Math.round(
    kmScore * 0.35 + hmScore * 0.35 + neulandScoreFit * 0.3 - crossingsPenalty
  ));

  return { total, kmScore: Math.round(kmScore), hmScore: Math.round(hmScore), neulandScoreFit: Math.round(neulandScoreFit) };
}

// Baut eine kurze, verständliche Begründung, warum genau diese Route unter
// mehreren generierten Kandidaten gewählt wurde.
function buildRouteExplanation(route, targetKm, targetHm, neulandPct, windAvoidance, avoidMainRoads, candidateCount, fitScore) {
  const parts = [];
  const kmPct = targetKm > 0 ? Math.round((route.distKm / targetKm) * 100) : 100;
  parts.push(`📏 ${route.distKm.toFixed(1)} km (${kmPct}% vom Ziel)`);

  let hmPct = 100;
  if (targetHm > 0) {
    hmPct = Math.round((route.hm / targetHm) * 100);
    parts.push(`⛰️ ${route.hm} Hm (${hmPct}% vom Ziel)`);
  }

  parts.push(`🧭 ${route.neulandScore}% Neuland (Ziel: ${neulandPct}%)`);

  if (windAvoidance > 60) parts.push('💨 Gegenwind aktiv gemieden');
  if (avoidMainRoads > 60) parts.push('🛣️ Hauptstraßen gemieden');

  const intro = candidateCount > 1
    ? `Beste von ${candidateCount} geprüften Varianten` + (typeof fitScore === 'number' ? ` (Passgenauigkeit ${fitScore}/100):` : ':')
    : 'Diese Route:';

  // Ehrlicher Hinweis, wenn ein Ziel im vorhandenen Straßennetz nicht sauber erreichbar war
  const caveats = [];
  if (Math.abs(kmPct - 100) > 10) caveats.push('Distanz weicht spürbar vom Ziel ab');
  if (targetHm > 0 && Math.abs(hmPct - 100) > 20) {
    caveats.push(hmPct < 100 ? 'Höhenmeter-Ziel nur teilweise erreichbar (Gelände hier flacher)' : 'Route hat mehr Höhenmeter als gewünscht (Gelände hier hügeliger)');
  }
  if (Math.abs(route.neulandScore - neulandPct) > 25) caveats.push('Neuland-Anteil weicht vom Wunsch ab (zu wenig passende Straßen im Umkreis)');

  return `${intro} ${parts.join(' · ')}` + (caveats.length ? ` — ⚠️ ${caveats.join('; ')}` : '');
}

function generateRoute(graph, startNodeId, targetKm, neulandPct, targetHm = 0, windAvoidance = 50, avoidMainRoads = 0) {
  const degree = computeDegrees(graph);
  const numWaypoints = Math.max(5, Math.min(9, Math.round(targetKm / 11)));
  const kmTolerance = targetKm * 0.08; // ±8%
  const hmTolerance = targetHm > 0 ? targetHm * 0.10 : Infinity; // ±10% für Höhenmeter
  const seedCount = 4;
  const attemptsPerSeed = 6;

  let overallBest = null;
  let overallBestScore = -Infinity;
  let candidateCount = 0;
  const seedBestsList = []; // bester Versuch je Startwinkel, Basis für Alternativen-Auswahl

  for (let s = 0; s < seedCount; s++) {
    const startAngle = Math.random() * 360;
    const clockwise = Math.random() < 0.5;
    let radiusKm = (targetKm / (2 * Math.PI)) * 0.6;

    let seedBest = null;
    let seedBestScore = -Infinity;
    let effectiveNeuland = neulandPct; // wird pro Versuch nachjustiert (kann auch < 0 werden)

    for (let i = 0; i < attemptsPerSeed; i++) {
      const attempt = attemptLoopRoute(graph, degree, startNodeId, effectiveNeuland, radiusKm, numWaypoints, startAngle, clockwise, windAvoidance, avoidMainRoads, targetKm, targetHm);
      candidateCount++;
      const fit = scoreRouteFit(attempt, targetKm, targetHm, neulandPct);

      if (fit.total > seedBestScore) {
        seedBestScore = fit.total;
        seedBest = attempt;
      }

      // Adaptive Radius-Anpassung basierend auf Km UND Hm
      const kmRatio = attempt.distKm > 0 ? targetKm / attempt.distKm : 1.3;
      const hmFactor = targetHm > 0 ? Math.min(2.0, Math.max(0.4, targetHm / (attempt.hm || targetHm))) : 1.0;
      radiusKm = Math.min(targetKm * 0.9, Math.max(0.8, radiusKm * (0.5 + kmRatio * 0.5) * (0.7 + hmFactor * 0.3)));

      // Neuland-Nachjustierung: liegt der erreichte Anteil über/unter dem Wunsch,
      // wird die Neuland-Gewichtung für den nächsten Versuch entsprechend gesenkt/erhöht.
      const neulandError = neulandPct - attempt.neulandScore;
      effectiveNeuland = Math.max(-100, Math.min(100, effectiveNeuland + neulandError * 0.7));

      // Abbruch wenn gut genug (Distanz, Höhenmeter UND Neuland-Anteil im Toleranzbereich)
      const kmDiff = Math.abs(attempt.distKm - targetKm);
      const hmDiff = targetHm > 0 ? Math.abs(attempt.hm - targetHm) : 0;
      if (kmDiff <= kmTolerance && hmDiff <= hmTolerance && Math.abs(neulandError) <= 12 && attempt.crossings <= 2) break;
    }

    if (!seedBest) continue;
    seedBestsList.push(Object.assign({}, seedBest, { fitScore: seedBestScore }));
    if (seedBestScore > overallBestScore) {
      overallBestScore = seedBestScore;
      overallBest = seedBest;
    }
  }

  // Bis zu 3 spürbar unterschiedliche Alternativen auswählen (beste Fit-Scores zuerst,
  // Duplikate mit sehr ähnlicher Distanz/Neuland-Quote werden übersprungen), damit der
  // Nutzer zwischen echten Varianten statt fast identischen Routen wählen kann.
  const sortedCandidates = seedBestsList.sort((a, b) => b.fitScore - a.fitScore);
  const alternatives = [];
  for (const cand of sortedCandidates) {
    const isDup = alternatives.some(a =>
      Math.abs(a.distKm - cand.distKm) < Math.max(1, targetKm * 0.05) &&
      Math.abs(a.neulandScore - cand.neulandScore) < 8
    );
    if (!isDup) alternatives.push(cand);
    if (alternatives.length >= 3) break;
  }
  alternatives.forEach((alt, i) => {
    alt.explanation = buildRouteExplanation(alt, targetKm, targetHm, neulandPct, windAvoidance, avoidMainRoads, candidateCount, Math.round(alt.fitScore));
    alt.label = i === 0 ? 'Beste Passung' : `Variante ${i + 1}`;
  });

  if (overallBest) {
    overallBest.fitScore = overallBestScore;
    overallBest.explanation = alternatives[0] ? alternatives[0].explanation : buildRouteExplanation(overallBest, targetKm, targetHm, neulandPct, windAvoidance, avoidMainRoads, candidateCount, overallBestScore);
    overallBest.alternatives = alternatives.length ? alternatives : [overallBest];
  }

  return overallBest;
}

// Peilung (Bearing) in Grad von Punkt a nach Punkt b, 0° = Norden
function bearing(a, b) {
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const dLng = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function makeFlagIcon(color, label) {
  return L.divIcon({
    className: 'flag-icon',
    html: `<div class="flag-icon__pin" style="background:${color}"><span>${label}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

function makeArrowIcon(deg) {
  return L.divIcon({
    className: 'arrow-icon',
    html: `<div class="arrow-icon__head" style="transform:rotate(${deg}deg)">➤</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// Entfernt eine evtl. vorhandene Route von der Karte — genutzt beim erneuten
// Zeichnen und beim Wechsel des Standorts (alte Route macht an einem neuen
// Ort keinen Sinn mehr).
// ---- Routen dauerhaft speichern (lokal im Browser) ------------------------

const SAVED_ROUTES_STORAGE_KEY = 'novaroute_saved_routes_v1';

function loadSavedRoutes() {
  try {
    const raw = localStorage.getItem(SAVED_ROUTES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn('⚠️ Konnte gespeicherte Routen nicht laden:', err.message);
    return [];
  }
}

function persistSavedRoutes(list) {
  try {
    localStorage.setItem(SAVED_ROUTES_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('⚠️ Konnte gespeicherte Routen nicht speichern (evtl. zu viele/groß):', err.message);
    alert('Route konnte nicht gespeichert werden — evtl. ist der lokale Speicher voll. Alte Routen löschen und erneut versuchen.');
  }
}

function saveCurrentRoute() {
  if (!currentRouteLatLngs || currentRouteLatLngs.length < 2) {
    alert('Es gibt noch keine generierte Route zum Speichern. Erst eine Route erkunden.');
    return;
  }
  const defaultName = `Route ${new Date().toLocaleDateString('de-DE')} – ${currentRouteInfo.distKm.toFixed(1)} km`;
  const name = prompt('Name für diese Route:', defaultName);
  if (name === null) return; // abgebrochen

  const list = loadSavedRoutes();
  list.unshift({
    id: Date.now(),
    name: name.trim() || defaultName,
    distKm: currentRouteInfo.distKm,
    hm: currentRouteInfo.hm,
    neulandScore: currentRouteInfo.neulandScore,
    latlngs: currentRouteLatLngs,
  });
  persistSavedRoutes(list);
  renderSavedRoutes();
}

// Zeichnet eine gespeicherte Route direkt aus den abgelegten Koordinaten neu
// (ohne den Routing-Algorithmus erneut laufen zu lassen) und aktualisiert
// Stats-Anzeige + GPX-Export-Referenz, damit sie sich wie eine frisch
// generierte Route verhält.
function loadSavedRouteOntoMap(entry) {
  clearRoute();
  routeHaloLayer = L.polyline(entry.latlngs, {
    color: '#ffffff', weight: 8, opacity: 0.85, lineCap: 'round',
  }).addTo(map);
  routeLayer = L.polyline(entry.latlngs, {
    color: '#111827', weight: 5, opacity: 1, lineCap: 'round',
  }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });

  currentRouteLatLngs = entry.latlngs;
  currentRouteInfo = { distKm: entry.distKm, hm: entry.hm, neulandScore: entry.neulandScore };

  document.getElementById('resultBlock').hidden = false;
  document.getElementById('scoreNum').textContent = entry.neulandScore ?? '–';
  document.getElementById('statKm').textContent = `${entry.distKm.toFixed(1)} km`;
  document.getElementById('statHm').textContent = `≈ ${entry.hm} Hm`;
  document.getElementById('distWarning').hidden = true;
}

function renderSavedRoutes() {
  const container = document.getElementById('savedRoutesList');
  const emptyMsg = document.getElementById('savedRoutesEmpty');
  if (!container) return;
  const list = loadSavedRoutes();

  container.innerHTML = '';
  if (!list.length) {
    container.appendChild(emptyMsg);
    return;
  }

  list.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'saved-route-card';

    const info = document.createElement('div');
    info.className = 'saved-route-card__info';
    const nameEl = document.createElement('div');
    nameEl.className = 'saved-route-card__name';
    nameEl.textContent = entry.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'saved-route-card__meta';
    metaEl.textContent = `${entry.distKm.toFixed(1)} km · ≈${entry.hm} Hm`;
    info.appendChild(nameEl);
    info.appendChild(metaEl);
    info.title = 'Route auf der Karte anzeigen';
    info.addEventListener('click', () => loadSavedRouteOntoMap(entry));
    card.appendChild(info);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'saved-route-card__delete';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Route löschen';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`"${entry.name}" wirklich löschen?`)) return;
      const updated = loadSavedRoutes().filter(r => r.id !== entry.id);
      persistSavedRoutes(updated);
      renderSavedRoutes();
    });
    card.appendChild(deleteBtn);

    container.appendChild(card);
  });
}

// ---- GPX-Export der generierten Route -------------------------------------

function buildGpxString(latlngs, info) {
  const distLabel = info && typeof info.distKm === 'number' ? info.distKm.toFixed(1) : '?';
  const name = `Novaroute – ${distLabel} km`;
  const points = latlngs
    .map(([lat, lng]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Novaroute" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${name}</name>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

function exportRouteAsGpx() {
  if (!currentRouteLatLngs || currentRouteLatLngs.length < 2) {
    alert('Es gibt noch keine generierte Route zum Exportieren. Erst eine Route erkunden.');
    return;
  }

  const gpxStr = buildGpxString(currentRouteLatLngs, currentRouteInfo);
  const blob = new Blob([gpxStr], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `novaroute_${dateStr}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log('✅ GPX exportiert:', currentRouteLatLngs.length, 'Punkte');
}

function clearRoute() {
  if (routeLayer) map.removeLayer(routeLayer);
  if (routeHaloLayer) map.removeLayer(routeHaloLayer);
  if (endMarker) map.removeLayer(endMarker);
  routeArrowLayers.forEach(l => map.removeLayer(l));
  routeArrowLayers = [];
  routeLayer = null;
  routeHaloLayer = null;
  endMarker = null;
  currentRouteLatLngs = null;
  currentRouteInfo = null;
  currentRouteEdges = null;
  currentGraphRef = null;
  currentStartNodeIdRef = null;
  currentIsAB = false;
  isSharedRouteView = false;
  clearNeulandOverlay();
  const altContainer = document.getElementById('routeAlternatives');
  if (altContainer) { altContainer.innerHTML = ''; altContainer.hidden = true; }
  const reverseHint = document.getElementById('reverseHint');
  if (reverseHint) reverseHint.hidden = true;
  renderElevationProfile(null);
  document.getElementById('routeExplanation').textContent = '';
  document.getElementById('resultBlock').hidden = true;
}

// Zeichnet zwei A-B-Routen: aktuelle (normal) und kürzeste (Vergleichsfarbe)
function drawABRoute(graph, route, shortest, startNodeId) {
  clearRoute();
  
  console.log('drawABRoute: route.edges:', route.edges);
  if (!route.edges || route.edges.length === 0) {
    console.error('❌ drawABRoute: keine Edges in route!', route);
    return;
  }
  
  // Aktuell: normale Route-Farbe - nutze die gleiche Logik wie drawRoute()
  const currentLatlngs = [];
  const startCoord = graph.nodeCoords.get(startNodeId);
  currentLatlngs.push([startCoord.lat, startCoord.lng]);
  
  route.edges.forEach((e, idx) => {
    const coord = graph.nodeCoords.get(e.to);
    if (!coord) {
      console.warn('⚠️ Kein Knoten für e.to:', e.to);
      return;
    }
    currentLatlngs.push([coord.lat, coord.lng]);
  });
  
  console.log('currentLatlngs:', currentLatlngs.length, 'Punkte');
  
  if (currentLatlngs.length > 1) {
    // Helle Umrandung zuerst, damit die Route auch auf dunklem
    // Satellit-/Gelände-Untergrund gut zu erkennen ist.
    routeHaloLayer = L.polyline(currentLatlngs, {
      color: '#ffffff', weight: 8, opacity: 0.85, lineCap: 'round',
    }).addTo(map);
    routeLayer = L.polyline(currentLatlngs, {
      color: '#111827',
      weight: 5,
      opacity: 1,
      lineCap: 'round',
      dashArray: '6,6', // gestrichelt
    }).addTo(map);
    currentRouteLatLngs = currentLatlngs;
    currentRouteInfo = { distKm: route.distKm, hm: route.hm, neulandScore: route.neulandScore };
    currentRouteEdges = route.edges;
    currentGraphRef = graph;
    currentStartNodeIdRef = startNodeId;
    placeDirectionArrows(currentLatlngs);
  }

  // Kürzeste Route: gleicher Ansatz
  const shortestLatlngs = [];
  const shortestStartCoord = graph.nodeCoords.get(startNodeId);
  shortestLatlngs.push([shortestStartCoord.lat, shortestStartCoord.lng]);
  
  shortest.edges.forEach((e, idx) => {
    const coord = graph.nodeCoords.get(e.to);
    if (!coord) {
      console.warn('⚠️ Kein Knoten für e.to:', e.to);
      return;
    }
    shortestLatlngs.push([coord.lat, coord.lng]);
  });
  
  console.log('shortestLatlngs:', shortestLatlngs.length, 'Punkte');
  
  if (shortestLatlngs.length > 1) {
    const shortestHalo = L.polyline(shortestLatlngs, {
      color: '#ffffff', weight: 6, opacity: 0.75, lineCap: 'round',
    }).addTo(map);
    const shortestPolyline = L.polyline(shortestLatlngs, {
      color: '#047857',
      weight: 3.5,
      opacity: 1,
      lineCap: 'round',
    }).addTo(map);
    routeArrowLayers.push(shortestHalo);
    routeArrowLayers.push(shortestPolyline);
  }
  
  // Start-Marker
  startMarker.setLatLng([startCoord.lat, startCoord.lng]);
  
  // End-Marker (Ziel)
  const lastEdge = route.edges[route.edges.length - 1];
  const endCoord = graph.nodeCoords.get(lastEdge.to);
  if (endCoord) {
    endMarker = L.marker([endCoord.lat, endCoord.lng], {
      icon: makeFlagIcon('#3b82f6', '🏁'),
      zIndexOffset: 500,
    }).addTo(map).bindTooltip('Ziel', { permanent: false });
  }
  
  // Zoom
  if (routeLayer && routeLayer.getBounds) {
    try {
      map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });
    } catch (e) {
      console.warn('Konnte nicht zu Route zoomen:', e);
    }
  }

  if (neulandOverlayActive) drawNeulandOverlay(); else clearNeulandOverlay();
}

// ---- Neuland-Einfärbung auf der generierten Route --------------------------
// Färbt die Route selbst segmentweise danach ein, ob die Kante bereits
// bekannt/gefahren (rot) oder Neuland (grün) ist — dieselben Farben wie beim
// Gesamt-Straßennetz, damit die Bedeutung konsistent ist. Jedes Segment
// bekommt zusätzlich eine schwarze Umrandung, damit Rot/Grün auch auf
// hellem Kartenuntergrund klar abgegrenzt zu erkennen sind. Läuft standard-
// mäßig IMMER nach dem Zeichnen einer Route — die Checkbox dient nur noch
// zum optionalen Ausschalten, falls man die reine (einheitliche) Linie sehen will.

function clearNeulandOverlay() {
  neulandOverlayLayers.forEach(l => map.removeLayer(l));
  neulandOverlayLayers = [];
}

function drawNeulandOverlay() {
  clearNeulandOverlay();
  if (!currentGraphRef || !currentRouteEdges || currentStartNodeIdRef == null) return;
  let prevCoord = currentGraphRef.nodeCoords.get(currentStartNodeIdRef);
  currentRouteEdges.forEach(e => {
    const coord = currentGraphRef.nodeCoords.get(e.to);
    if (!coord || !prevCoord) { prevCoord = coord; return; }
    const seg = [[prevCoord.lat, prevCoord.lng], [coord.lat, coord.lng]];
    // Schwarze Umrandung zuerst (etwas breiter), dann die farbige Linie darüber.
    const outline = L.polyline(seg, { color: '#000000', weight: 7, opacity: 0.9, lineCap: 'round' }).addTo(map);
    const color = e.ridden ? '#dc2626' : '#16a34a'; // rot = bekannt/gefahren, grün = Neuland
    const layer = L.polyline(seg, { color, weight: 4, opacity: 1, lineCap: 'round' }).addTo(map);
    neulandOverlayLayers.push(outline, layer);
    prevCoord = coord;
  });
}

// ---- Höhenprofil (Feature 5) ----------------------------------------------
// Baut ein {km, ele}-Profil entlang der Route aus den echten Höhendaten
// (nodeElevations). Ohne echte Höhendaten (nur simulierte Hm) lässt sich
// kein verlässliches Profil zeichnen — dann bleibt der Bereich ausgeblendet.

function buildElevationProfile(edges, startId, graphRef) {
  if (!graphRef || !edges || !edges.length || startId == null) return null;
  if (!nodeElevations || nodeElevations.size === 0) return null;
  const startEle = nodeElevations.get(startId);
  if (typeof startEle !== 'number') return null;

  let cum = 0;
  let missing = 0;
  const pts = [{ km: 0, ele: startEle }];
  edges.forEach(e => {
    cum += e.dist;
    let ele = nodeElevations.get(e.to);
    if (typeof ele !== 'number') { missing++; ele = pts[pts.length - 1].ele; }
    pts.push({ km: cum, ele });
  });
  if (missing > edges.length * 0.4) return null; // zu lückenhaft für ein sinnvolles Profil
  return pts;
}

function renderElevationProfile(pts) {
  const wrap = document.getElementById('elevationProfileWrap');
  const canvas = document.getElementById('elevationProfileCanvas');
  if (!wrap || !canvas) return;
  if (!pts || pts.length < 2) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 272;
  const cssH = 70;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const eles = pts.map(p => p.ele);
  const minEle = Math.min(...eles), maxEle = Math.max(...eles);
  const range = Math.max(10, maxEle - minEle);
  const totalKm = pts[pts.length - 1].km || 1;
  const padL = 4, padR = 4, padT = 8, padB = 14;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const x = km => padL + (km / totalKm) * plotW;
  const y = ele => padT + plotH - ((ele - minEle) / range) * plotH;

  // Füllfläche unter der Kurve
  ctx.beginPath();
  ctx.moveTo(x(0), y(pts[0].ele));
  pts.forEach(p => ctx.lineTo(x(p.km), y(p.ele)));
  ctx.lineTo(x(totalKm), padT + plotH);
  ctx.lineTo(x(0), padT + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(59,130,246,0.35)');
  grad.addColorStop(1, 'rgba(59,130,246,0.03)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Linie
  ctx.beginPath();
  ctx.moveTo(x(0), y(pts[0].ele));
  pts.forEach(p => ctx.lineTo(x(p.km), y(p.ele)));
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Min/Max-Beschriftung
  ctx.fillStyle = '#6b7280';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(minEle)} m`, padL, cssH - 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(maxEle)} m`, cssW - padR, padT + 8);
  ctx.textAlign = 'left';
}

// ---- Alternativen-Auswahl (Feature 1) --------------------------------------
// Zeigt bis zu 3 generierte Routen-Varianten als Karten an; Klick wählt eine
// aus, zeichnet sie neu und aktualisiert Stats/Erklärung/Höhenprofil/Overlay.

function renderAlternativeCards() {
  const container = document.getElementById('routeAlternatives');
  if (!container) return;
  if (!currentAlternatives || currentAlternatives.length < 2) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = '';
  currentAlternatives.forEach((alt, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'alt-card' + (i === selectedAlternativeIndex ? ' alt-card--active' : '');
    const label = alt.label || `Variante ${i + 1}`;
    card.innerHTML = `
      <span class="alt-card__label">${label}${typeof alt.fitScore === 'number' ? ' · ' + Math.round(alt.fitScore) + '/100' : ''}</span>
      <span class="alt-card__stats">${alt.distKm.toFixed(1)} km · ${alt.hm} Hm · ${alt.neulandScore}% Neuland</span>
    `;
    card.addEventListener('click', () => applySelectedAlternative(i));
    container.appendChild(card);
  });
}

function applySelectedAlternative(idx) {
  if (!currentAlternatives || !currentAlternatives[idx] || !graph) return;
  selectedAlternativeIndex = idx;
  const route = currentAlternatives[idx];

  if (route.isAB) {
    drawABRoute(graph, route, route.shortestRoute || route, startNodeId);
  } else {
    drawRoute(graph, route, startNodeId);
  }
  currentIsAB = !!route.isAB;

  document.getElementById('resultBlock').hidden = false;
  document.getElementById('scoreNum').textContent = route.neulandScore;
  document.getElementById('statKm').textContent = `${route.distKm.toFixed(1)} km`;
  document.getElementById('statHm').textContent = `≈ ${route.hm} Hm`;

  const warningEl = document.getElementById('distWarning');
  const notes = [];
  if (route.crossings > 2) notes.push(`${route.crossings} Kreuzungen.`);
  if (notes.length) {
    warningEl.textContent = `Info: ${notes.join(' ')}`;
    warningEl.hidden = false;
  } else {
    warningEl.hidden = true;
  }

  const explanationEl = document.getElementById('routeExplanation');
  if (explanationEl) explanationEl.textContent = route.explanation ? `🤖 ${route.explanation}` : '';

  renderAlternativeCards();

  if (neulandOverlayActive) drawNeulandOverlay(); else clearNeulandOverlay();
  renderElevationProfile(buildElevationProfile(route.edges, startNodeId, graph));
}

// ---- Route umkehren (Feature 3) --------------------------------------------
// Dreht die gezeichnete Punktfolge um (Start/Ziel tauschen bzw. Rundtour in
// Gegenrichtung) und zeichnet Linie + Pfeile + Marker neu. Distanz und
// Neuland-Quote bleiben unverändert, die Höhenmeter beziehen sich weiter auf
// die ursprüngliche Fahrtrichtung (Hinweis dazu wird eingeblendet).

function reverseCurrentRoute() {
  if (!currentRouteLatLngs || currentRouteLatLngs.length < 2) return;
  const reversed = currentRouteLatLngs.slice().reverse();

  if (routeLayer) map.removeLayer(routeLayer);
  if (routeHaloLayer) map.removeLayer(routeHaloLayer);
  routeArrowLayers.forEach(l => map.removeLayer(l));
  routeArrowLayers = [];
  clearNeulandOverlay();

  routeHaloLayer = L.polyline(reversed, { color: '#ffffff', weight: 8, opacity: 0.85, lineCap: 'round' }).addTo(map);
  routeLayer = L.polyline(reversed, { color: '#111827', weight: 5, opacity: 1, lineCap: 'round' }).addTo(map);
  currentRouteLatLngs = reversed;
  placeDirectionArrows(reversed);

  const newStart = reversed[0], newEnd = reversed[reversed.length - 1];
  if (startMarker) startMarker.setLatLng(newStart);
  if (endMarker) {
    endMarker.setLatLng(newEnd);
  } else {
    endMarker = L.marker(newEnd, { icon: makeFlagIcon('#3b82f6', '🏁'), zIndexOffset: 500 }).addTo(map).bindTooltip('Ziel', { permanent: false });
  }

  // Edge-Zuordnung (für Neuland-Einfärbung & Höhenprofil) passt nach dem
  // Umkehren nicht mehr sicher zur Punktfolge — daher zurücksetzen.
  currentRouteEdges = null;
  currentGraphRef = null;
  currentStartNodeIdRef = null;
  renderElevationProfile(null);

  const reverseHint = document.getElementById('reverseHint');
  if (reverseHint) reverseHint.hidden = false;
}

// ---- Route teilen (Feature 2) ----------------------------------------------
// Ohne eigenen Server (reine statische Seite) gibt es keine Möglichkeit, einen
// ECHTEN Kurz-Link wie bei bit.ly zu erzeugen — dafür bräuchte es eine
// Datenbank, die sich Kürzel->Route merkt. Stattdessen wird die Route so
// kompakt wie möglich direkt in den Link gepackt:
//  - Google-Polyline-Encoding statt roher Koordinaten (siehe encodePolyline)
//  - höchstens ~300 gleichmäßig verteilte Punkte (reicht für eine glatte
//    Linie auf der Karte, auch bei 90-km-Routen mit tausenden Rohpunkten)
// Das macht den Link um ca. 70% kürzer als vorher. Zusätzlich gibt es einen
// QR-Code, damit man den Link gar nicht erst als Text anfassen muss.

// Google-Encoded-Polyline-Algorithmus (Standardformat, u. a. von Google Maps
// genutzt) — kodiert eine Punktfolge extrem kompakt als ASCII-Zeichenkette.
function encodeUnsignedNumber(num) {
  let output = '';
  while (num >= 0x20) {
    output += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
    num >>= 5;
  }
  output += String.fromCharCode(num + 63);
  return output;
}
function encodeSignedNumber(num) {
  let sgn = num << 1;
  if (num < 0) sgn = ~sgn;
  return encodeUnsignedNumber(sgn);
}
function encodePolyline(points, precision = 5) {
  const factor = Math.pow(10, precision);
  let output = '';
  let prevLat = 0, prevLng = 0;
  points.forEach(([lat, lng]) => {
    const lat5 = Math.round(lat * factor);
    const lng5 = Math.round(lng * factor);
    output += encodeSignedNumber(lat5 - prevLat) + encodeSignedNumber(lng5 - prevLng);
    prevLat = lat5; prevLng = lng5;
  });
  return output;
}
function decodePolyline(str, precision = 5) {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

// Dünnt sehr punktreiche Routen für den Link gleichmäßig aus (Anfang/Ende
// bleiben immer erhalten) — die Linie auf der Karte bleibt dabei glatt,
// der Link aber trotzdem kurz, egal wie dicht das OSM-Straßennetz war.
function simplifyForShare(latlngs, maxPoints = 300) {
  if (latlngs.length <= maxPoints) return latlngs;
  const step = (latlngs.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(latlngs[Math.round(i * step)]);
  return out;
}

function buildShareUrl() {
  if (!currentRouteLatLngs || currentRouteLatLngs.length < 2 || !currentRouteInfo) return null;
  try {
    const simplified = simplifyForShare(currentRouteLatLngs);
    const encoded = encodePolyline(simplified);
    const km = Math.round(currentRouteInfo.distKm * 10) / 10;
    const hm = Math.round(currentRouteInfo.hm);
    const n = Math.round(currentRouteInfo.neulandScore);
    const compact = `${encoded}|${km}|${hm}|${n}`;
    return `${location.origin}${location.pathname}#r=${encodeURIComponent(compact)}`;
  } catch (err) {
    console.warn('⚠️ Konnte Teilen-Link nicht bauen:', err.message);
    return null;
  }
}

function drawSharedRoute(points, info) {
  clearRoute();
  isSharedRouteView = true;

  routeHaloLayer = L.polyline(points, { color: '#ffffff', weight: 8, opacity: 0.85, lineCap: 'round' }).addTo(map);
  routeLayer = L.polyline(points, { color: '#111827', weight: 5, opacity: 1, lineCap: 'round' }).addTo(map);
  currentRouteLatLngs = points;
  currentRouteInfo = info;
  placeDirectionArrows(points);

  const start = points[0];
  startMarker.setLatLng(start);
  endMarker = L.marker(points[points.length - 1], {
    icon: makeFlagIcon('#3b82f6', '🏁'),
    zIndexOffset: 500,
  }).addTo(map).bindTooltip('Ziel', { permanent: false });

  try {
    map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });
  } catch (e) { /* ignorieren */ }

  document.getElementById('resultBlock').hidden = false;
  document.getElementById('scoreNum').textContent = info.neulandScore;
  document.getElementById('statKm').textContent = `${info.distKm.toFixed(1)} km`;
  document.getElementById('statHm').textContent = `≈ ${info.hm} Hm`;
  document.getElementById('distWarning').hidden = true;

  const explanationEl = document.getElementById('routeExplanation');
  if (explanationEl) explanationEl.textContent = '🔗 Diese Route wurde über einen Teilen-Link geladen. Zum Weiterbearbeiten links Start/Ziel neu wählen.';
}

function applyShareFromUrlIfPresent() {
  if (!location.hash) return;

  // Neues, kompaktes Format (#r=...): Polyline-kodierte Punkte + Stats
  if (location.hash.startsWith('#r=')) {
    try {
      const raw = decodeURIComponent(location.hash.slice('#r='.length));
      const [encoded, kmStr, hmStr, nStr] = raw.split('|');
      const points = decodePolyline(encoded);
      if (points.length < 2) return;
      drawSharedRoute(points, { distKm: parseFloat(kmStr), hm: parseFloat(hmStr), neulandScore: parseFloat(nStr) });
    } catch (err) {
      console.warn('⚠️ Geteilte Route konnte nicht geladen werden:', err.message);
    }
    return;
  }

  // Altes Format (#route=<base64-JSON>) — bereits verschickte Links bleiben gültig
  if (location.hash.startsWith('#route=')) {
    try {
      const b64 = location.hash.slice('#route='.length);
      const json = decodeURIComponent(escape(atob(b64)));
      const payload = JSON.parse(json);
      if (!Array.isArray(payload.p) || payload.p.length < 2) return;
      drawSharedRoute(payload.p, { distKm: payload.km, hm: payload.hm, neulandScore: payload.n });
    } catch (err) {
      console.warn('⚠️ Geteilte Route konnte nicht geladen werden:', err.message);
    }
  }
}

// aktuellen Knoten explizit, markiert Start/Ziel und setzt Richtungspfeile
// in regelmäßigen Abständen entlang der Strecke.
function drawRoute(graph, route, startId) {
  clearRoute();

  const latlngs = [];
  const startCoord = graph.nodeCoords.get(startId);
  latlngs.push([startCoord.lat, startCoord.lng]);
  route.edges.forEach(e => {
    const c = graph.nodeCoords.get(e.to);
    if (c) latlngs.push([c.lat, c.lng]);
  });

  routeHaloLayer = L.polyline(latlngs, {
    color: '#ffffff', weight: 8, opacity: 0.85, lineCap: 'round',
  }).addTo(map);
  routeLayer = L.polyline(latlngs, {
    color: '#111827', weight: 5, opacity: 1, lineCap: 'round',
  }).addTo(map);
  currentRouteLatLngs = latlngs;
  currentRouteInfo = { distKm: route.distKm, hm: route.hm, neulandScore: route.neulandScore };
  currentRouteEdges = route.edges;
  currentGraphRef = graph;
  currentStartNodeIdRef = startId;

  // Ziel-Marker (Zielflagge) setzen, leicht sichtbar getrennt vom Start-Punkt,
  // da es sich um eine Rundstrecke handelt und Start = Ziel ist
  endMarker = L.marker([startCoord.lat, startCoord.lng], {
    icon: makeFlagIcon('#3b82f6', '🏁'),
    zIndexOffset: 500,
  }).addTo(map).bindTooltip('Start & Ziel (Rundkurs)', { permanent: false });

  placeDirectionArrows(latlngs);

  map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });

  if (neulandOverlayActive) drawNeulandOverlay(); else clearNeulandOverlay();
}

// Setzt rotierte Richtungspfeile alle paar hundert Meter entlang einer
// Punktfolge — ausgelagert aus drawRoute(), damit auch die umgekehrte
// und eine per Teilen-Link geladene Route dieselben Pfeile bekommen.
function placeDirectionArrows(latlngs) {
  if (!latlngs || latlngs.length < 2) return;
  let totalKm = 0;
  for (let i = 0; i < latlngs.length - 1; i++) {
    totalKm += haversine({ lat: latlngs[i][0], lng: latlngs[i][1] }, { lat: latlngs[i + 1][0], lng: latlngs[i + 1][1] });
  }
  if (totalKm === 0) return;
  const arrowCount = Math.max(4, Math.min(14, Math.round(totalKm / 2)));
  const arrowIntervalKm = totalKm / arrowCount;

  let cum = 0;
  let nextArrowAt = arrowIntervalKm / 2;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const a = latlngs[i], b = latlngs[i + 1];
    const segKm = haversine({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
    if (segKm === 0) continue;
    while (nextArrowAt <= cum + segKm) {
      const t = (nextArrowAt - cum) / segKm;
      const lat = a[0] + (b[0] - a[0]) * t;
      const lng = a[1] + (b[1] - a[1]) * t;
      const deg = bearing(a, b);
      const arrow = L.marker([lat, lng], { icon: makeArrowIcon(deg), interactive: false }).addTo(map);
      routeArrowLayers.push(arrow);
      nextArrowAt += arrowIntervalKm;
    }
    cum += segKm;
  }
}

// ---- 6. Standort wählen: Suche, Browser-Standort, Kartenklick -------------
//
// CENTER ist frei veränderbar — die App ist nicht mehr auf einen Ort fest
// verdrahtet. setLocation() ist die zentrale Stelle, die bei jedem
// Standortwechsel Karte, Marker, alte Route und Straßennetz konsistent hält.

function setLocation(newCenter, zoom) {
  CENTER = newCenter;
  map.setView([CENTER.lat, CENTER.lng], zoom || Math.max(map.getZoom(), 12));
  startMarker.setLatLng([CENTER.lat, CENTER.lng]);
  clearRoute();
  loadNetwork();
}

// Geocoding über Nominatim (OpenStreetMap) — kostenlos, kein API-Key nötig.
// Hinweis für den Fall echter Nutzung: Nominatims Nutzungsbedingungen
// verlangen moderate Anfragehäufigkeit; bei viel Traffic besser auf einen
// dedizierten Geocoding-Dienst wechseln.
async function geocodeLocation(query) {
  console.log('🔍 Suche nach:', query);
  
  // Nominatim mit kurzen Timeout
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();
    
    if (!results.length) throw new Error('Ort nicht gefunden');
    
    console.log('✅ Gefunden:', results[0].display_name);
    return {
      center: { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) },
      label: results[0].display_name,
    };
  } catch (err) {
    console.warn('⚠️ Nominatim Fehler:', err.message);
    
    // Fallback: Versuche OSM mit anderen Servern
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const url = `https://maps.openstreetmap.de/nominatim/search.php?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = await res.json();
      
      if (!results.length) throw new Error('Ort nicht gefunden (Fallback)');
      
      console.log('✅ Gefunden (Fallback):', results[0].display_name);
      return {
        center: { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) },
        label: results[0].display_name,
      };
    } catch (err2) {
      console.error('❌ Beide Geocoder fehlgeschlagen:', err2.message);
      throw new Error('Geocoding nicht verfügbar. Versuchen Sie: Berlin, München, Hamburg');
    }
  }
}

// ---- 7. App-Start: Netz laden, dann UI aktivieren -------------------------

const generateBtn = document.getElementById('generateBtn');
const mapStatus = document.createElement('div');
mapStatus.className = 'map-status';
document.querySelector('.map-wrap').appendChild(mapStatus);

let graph = null;
let lastOsmData = null; // zuletzt geladene OSM-Rohdaten, für Rebuild nach GPX-Import
let startNodeId = null;

// Start & Ziel globale Variablen
let startLocation = CENTER; // Initialwert
let startLocationSetByUser = false; // true, sobald der Nutzer wirklich einen Ort gewählt hat
let activeLocationField = 'start'; // 'start' oder 'end' — welches Feld zuletzt fokussiert war
let endLocation = null;      // null = Rundtour

function updateModeHint() {
  if (endLocation) {
    generateBtn.textContent = '🗺️ Strecke erkunden';
  } else {
    generateBtn.textContent = '🔄 Rundtour erkunden';
  }
}

function loadNetwork() {
  console.log('📡 loadNetwork() aufgerufen. startLocation:', startLocation);
  mapStatus.hidden = false;
  mapStatus.classList.remove('map-status--error');
  mapStatus.innerHTML = '⚡ Verbinde mit Kartenserver…';
  generateBtn.disabled = true;
  generateBtn.textContent = '⏳ Lädt…';
  document.getElementById('elevationStatus').textContent = 'Höhendaten: noch nicht geladen (simuliert).';
  
  // Zoome Karte zu startLocation
  map.setView([startLocation.lat, startLocation.lng], 13);
  startMarker.setLatLng([startLocation.lat, startLocation.lng]);
  console.log('🗺️ Karte zoomed zu:', startLocation);

  // Wind parallel laden (nicht warten)
  fetchWindData(startLocation);
  if (map.hasLayer(windFlowLayer)) windFlowLayer._refreshWindField();

  fetchRoadNetwork(startLocation, (msg) => { mapStatus.innerHTML = `⚡ ${msg}`; })
    .then(osmData => {
      console.log('✅ Straßennetz geladen, Elemente:', osmData.elements.length);
      if (!osmData.elements.length) {
        throw new Error('Keine Straßen in diesem Gebiet gefunden');
      }
      graph = buildGraphFromOsm(osmData);
      lastOsmData = osmData; // für schnellen Rebuild nach GPX-Import merken
      console.log('🔗 Graph gebaut, Knoten:', graph.nodeCoords.size);
      startNodeId = findNearestNode(graph.nodeCoords, startLocation);
      console.log('📍 startNodeId gesetzt:', startNodeId);
      if (!startNodeId) {
        throw new Error('Kein Straßen-Startpunkt in der Nähe gefunden');
      }
      drawNetwork(graph);
      console.log('🎨 Netzwerk gezeichnet');
      mapStatus.hidden = true;
      generateBtn.disabled = false;
      generateBtn.textContent = '🔄 Rundtour erkunden';
      updateModeHint();

      // Echte Höhendaten im Hintergrund nachladen (blockiert die App nicht) —
      // sobald fertig, wird der Graph automatisch mit echten Hm neu gebaut.
      const elevationStatusEl = document.getElementById('elevationStatus');
      const nodeCountForElevation = graph.nodeCoords.size;
      elevationStatusEl.textContent = `⏳ Lade echte Höhendaten für ${nodeCountForElevation} Punkte…`;
      const osmDataForElevation = osmData; // gegen spätere Standortwechsel absichern

      fetchElevations(graph.nodeCoords, (done, total) => {
        elevationStatusEl.textContent = `⏳ Lade echte Höhendaten… (${done}/${total} Blöcke)`;
      }).then(elevations => {
        // Falls der Nutzer inzwischen einen neuen Standort geladen hat, diese
        // veralteten Höhendaten verwerfen statt sie fälschlich anzuwenden.
        if (osmDataForElevation !== lastOsmData) {
          console.log('⏭️ Höhendaten verworfen (Standort hat sich zwischenzeitlich geändert)');
          return;
        }
        nodeElevations = elevations;
        graph = buildGraphFromOsm(osmDataForElevation, nodeElevations);
        if (startLocation) startNodeId = findNearestNode(graph.nodeCoords, startLocation);
        drawNetwork(graph);
        elevationStatusEl.textContent = `✅ Echte Höhendaten aktiv (${elevations.size}/${nodeCountForElevation} Punkte).`;
        console.log('🔗 Graph mit echten Höhendaten neu gebaut');
      }).catch(err => {
        console.warn('⚠️ Höhendaten-Laden fehlgeschlagen:', err.message);
        elevationStatusEl.textContent = '⚠️ Höhendaten konnten nicht geladen werden (simuliert).';
      });
    })
    .catch(err => {
      console.error('❌ Fehler beim Laden:', err);
      mapStatus.classList.add('map-status--error');
      mapStatus.innerHTML = '';
      const msg = document.createElement('span');
      msg.textContent = `❌ ${err.message} `;
      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'Erneut versuchen';
      retryBtn.className = 'btn btn--ghost';
      retryBtn.style.marginLeft = '8px';
      retryBtn.addEventListener('click', loadNetwork);
      mapStatus.appendChild(msg);
      mapStatus.appendChild(retryBtn);
      generateBtn.disabled = false;
      generateBtn.textContent = '🔄 Rundtour erkunden';
    });
}

// Beim Start: Keine Daten laden - Nutzer kann überall auf der Welt starten
function initializeApp() {
  // Karte zeigt nur das OSM-Hintergrundbild, kein Straßennetz noch
  // Das Straßennetz wird erst geladen, wenn der Nutzer einen Start-Ort eingibt
  mapStatus.hidden = true;

  // Zuvor importierte Fahrhistorie aus dem lokalen Speicher wiederherstellen
  loadRiddenPointsFromStorage();
  if (riddenTrackPoints.length) {
    document.getElementById('gpxImportStatus').textContent =
      `✅ ${riddenTrackPoints.length} Streckenpunkte aus vorherigem Import geladen.`;
    document.getElementById('gpxResetBtn').style.display = 'block';
  }

  // Gespeicherte Schnelladressen (Zuhause etc.) anzeigen
  renderQuickLocations();

  // Gespeicherte Routen anzeigen
  renderSavedRoutes();

  console.log('App ready - warte auf Start-Ort-Eingabe');
}

document.getElementById('gpxFileInput').addEventListener('change', (e) => {
  if (e.target.files.length) handleGpxFilesSelected(e.target.files);
});

document.getElementById('gpxResetBtn').addEventListener('click', () => {
  if (confirm('Fahrhistorie wirklich zurücksetzen? "Neuland" wird danach wieder simuliert, bis du erneut importierst.')) {
    resetRiddenHistory();
  }
});

document.getElementById('gpxExportBtn').addEventListener('click', exportRouteAsGpx);
document.getElementById('routeSaveBtn').addEventListener('click', saveCurrentRoute);

initializeApp();


// ---- 7. Start & Ziel: getrennte Standorte + A-B-Routing ----

const startLocationInput = document.getElementById('startLocationInput');
const endLocationInput = document.getElementById('endLocationInput');
const startGeoBtn = document.getElementById('startGeoBtn');
const endGeoBtn = document.getElementById('endGeoBtn');
const endClearBtn = document.getElementById('endClearBtn');
const startSearchBtn = document.getElementById('startSearchBtn');
const endSearchBtn = document.getElementById('endSearchBtn');
const startLocationHint = document.getElementById('startLocationHint');
const endLocationHint = document.getElementById('endLocationHint');

// Merkt sich, welches der beiden Adressfelder zuletzt fokussiert war —
// die Schnelladressen (Zuhause etc.) tragen sich dann genau dort ein.
startLocationInput.addEventListener('focus', () => { activeLocationField = 'start'; });
endLocationInput.addEventListener('focus', () => { activeLocationField = 'end'; });

function setStartLocation(loc, label) {
  startLocation = loc;
  startLocationSetByUser = true;
  CENTER = loc; // WICHTIG: Routing-Algorithmus nutzt CENTER für Wegpunkt-Berechnung
  startMarker.setLatLng([loc.lat, loc.lng]);
  const displayLabel = label || `(${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`;
  startLocationInput.value = displayLabel;
  startLocationHint.textContent = `📍 ${displayLabel}`;
  clearRoute();
  loadNetwork();
}

function setEndLocation(loc, label) {
  if (!loc) {
    endLocation = null;
    endLocationInput.value = '';
    endLocationHint.textContent = '→ Leer (Rundtour)';
  } else {
    endLocation = loc;
    const displayLabel = label || `(${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`;
    endLocationInput.value = displayLabel;
    endLocationHint.textContent = `🗺️ ${displayLabel} (Strecke)`;
  }
  clearRoute();
  updateModeHint();
}

function handleLocationSearch(isStart) {
  const input = isStart ? startLocationInput : endLocationInput;
  const btn = isStart ? startSearchBtn : endSearchBtn;
  const query = input.value.trim();
  const hint = isStart ? startLocationHint : endLocationHint;

  if (!query) {
    hint.textContent = '⚠️ Bitte Ort eingeben';
    return;
  }
  
  hint.textContent = '🔍 Suche nach „' + query + '" …';
  btn.disabled = true;
  const originalBtnText = btn.textContent;
  btn.textContent = '⏳';
  
  geocodeLocation(query)
    .then(({ center, label }) => {
      if (isStart) setStartLocation(center, label);
      else setEndLocation(center, label);
    })
    .catch(err => {
      console.error('Geocoding error:', err);
      hint.textContent = `❌ Nicht gefunden. Versuchen Sie: "Berlin", "10115 Berlin" oder "Unter den Linden, Berlin"`;
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = originalBtnText;
    });
}

startLocationInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleLocationSearch(true);
});

endLocationInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleLocationSearch(false);
});

startSearchBtn.addEventListener('click', () => handleLocationSearch(true));
endSearchBtn.addEventListener('click', () => handleLocationSearch(false));

startGeoBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    startLocationHint.textContent = 'Geolocation nicht unterstützt';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setStartLocation(loc, 'Dein Standort');
    },
    err => {
      startLocationHint.textContent = `Fehler: ${err.message}`;
    }
  );
});

endGeoBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    endLocationHint.textContent = 'Geolocation nicht unterstützt';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setEndLocation(loc, 'Dein Standort');
    },
    err => {
      endLocationHint.textContent = `Fehler: ${err.message}`;
    }
  );
});

endClearBtn.addEventListener('click', () => {
  setEndLocation(null);
});

// Kartenklick: tauscht die aktive Eingabe (wechselt zwischen Start/Ziel)
// — mit Shift-Klick Start, ohne Shift Ziel
let nextClickIsStart = false;
map.on('click', e => {
  const isStart = nextClickIsStart || !endLocationInput.value;
  if (isStart) {
    setStartLocation({ lat: e.latlng.lat, lng: e.latlng.lng }, '(Kartenklick)');
    nextClickIsStart = false;
  } else {
    setEndLocation({ lat: e.latlng.lat, lng: e.latlng.lng }, '(Kartenklick)');
  }
});

// ---- 8. UI-Regler-Verdrahtung ----

const kmInput = document.getElementById('kmInput');
const hmInput = document.getElementById('hmInput');
const neulandInput = document.getElementById('neulandInput');
const windInput = document.getElementById('windInput');
const mainRoadInput = document.getElementById('mainRoadInput');
const kmValue = document.getElementById('kmValue');
const hmValue = document.getElementById('hmValue');
const neulandValue = document.getElementById('neulandValue');
const windValue = document.getElementById('windValue');
const mainRoadValue = document.getElementById('mainRoadValue');
const windStatus = document.getElementById('windStatus');

// Initiale Werte setzen
kmValue.textContent = kmInput.value;
hmValue.textContent = hmInput.value;
neulandValue.textContent = neulandInput.value;
windValue.textContent = windInput.value;
mainRoadValue.textContent = mainRoadInput.value;

kmInput.addEventListener('input', () => kmValue.textContent = kmInput.value);
hmInput.addEventListener('input', () => hmValue.textContent = hmInput.value);
neulandInput.addEventListener('input', () => neulandValue.textContent = neulandInput.value);
mainRoadInput.addEventListener('input', () => mainRoadValue.textContent = mainRoadInput.value);
windInput.addEventListener('input', () => {
  windValue.textContent = windInput.value;
  updateWindStatus();
});

function updateWindStatus() {
  if (!currentWindData) return;
  const windPref = Number(windInput.value);
  const windKmh = (currentWindData.windSpeed * 3.6).toFixed(1);
  const dirName = getWindDirection(currentWindData.windDirection);
  
  let prefText = '';
  if (windPref > 80) prefText = ' — meidet Gegenwind stark';
  else if (windPref < 20) prefText = ' — Wind egal';
  
  windStatus.innerHTML = `💨 ${windKmh} km/h aus ${dirName}${prefText}`;
}

// ---- 10. Wind-Daten Fetching & Visualisierung ----

let currentWindData = null;

async function fetchWindData(location) {
  try {
    // Kein await — laufe parallel im Hintergrund
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lng}&current=wind_speed_10m,wind_direction_10m&timezone=auto`;
    const res = await Promise.race([
      fetch(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 3000)) // 3s Timeout
    ]);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    if (data.current) {
      currentWindData = {
        windSpeed: data.current.wind_speed_10m,
        windDirection: data.current.wind_direction_10m,
        timestamp: data.current.time,
      };
      console.log('✅ Wind:', currentWindData.windSpeed, 'm/s');
      updateWindDisplay();
    }
  } catch (err) {
    console.warn('⚠️ Wind-Daten nicht verfügbar:', err.message);
    windStatus.innerHTML = '⚠️ Wind-Daten nicht verfügbar';
  }
}

function updateWindDisplay() {
  updateWindStatus();
}

function getWindDirection(degrees) {
  const dirs = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(degrees / 22.5) % 16;
  return dirs[idx];
}

// ---- 11. Live-Windkarte (Gitter aus echten Live-Messpunkten) --------------


generateBtn.addEventListener('click', () => {
  console.log('🚀 generateBtn geklickt. graph:', !!graph, 'startNodeId:', startNodeId);
  if (!graph) {
    console.warn('⚠️ Kein Graph vorhanden!');
    return;
  }
  const targetKm = Number(kmInput.value);
  const targetHm = Number(hmInput.value);
  const neulandPct = Number(neulandInput.value);
  const windPref = Number(windInput.value); // 0 = Gegenwind meiden, 100 = Wind egal
  const mainRoadPref = Number(mainRoadInput.value); // 0 = egal, 100 = Hauptstraßen meiden
  console.log('📊 Parameter: targetKm=' + targetKm + ' km, targetHm=' + targetHm + ' hm, neulandPct=' + neulandPct + '%, windPref=' + windPref + '%, mainRoadPref=' + mainRoadPref + '%');

  if (endLocation) {
    // A-B-Routing: direkter Weg von Start zu Ziel
    console.log('🗺️ A-B-Routing gewählt');
    const endNodeId = findNearestNode(graph.nodeCoords, endLocation);
    const abResult = generateABRoute(graph, startNodeId, endNodeId, targetKm, neulandPct, windPref, mainRoadPref, targetHm);

    if (!abResult) {
      alert('Route konnte nicht generiert werden — Ziel unerreichbar');
      return;
    }
    currentAlternatives = abResult.alternatives;
  } else {
    // Rundtour
    console.log('🔄 Rundtour gewählt');
    const route = generateRoute(graph, startNodeId, targetKm, neulandPct, targetHm, windPref, mainRoadPref);
    if (!route) {
      console.error('❌ Route konnte nicht generiert werden');
      alert('Route konnte nicht generiert werden — Straßennetz zu dicht oder Ziel unerreichbar');
      return;
    }
    currentAlternatives = route.alternatives && route.alternatives.length ? route.alternatives : [route];
  }

  if (!currentAlternatives || !currentAlternatives.length) {
    console.error('❌ Keine Route(n) erzeugt');
    alert('Route konnte nicht generiert werden — Straßennetz zu dicht oder Ziel unerreichbar');
    return;
  }

  console.log('🎨 Zeige beste von', currentAlternatives.length, 'Variante(n)');
  applySelectedAlternative(0);
});

// Richtung der aktuellen Route umkehren
const reverseRouteBtn = document.getElementById('reverseRouteBtn');
if (reverseRouteBtn) {
  reverseRouteBtn.addEventListener('click', () => reverseCurrentRoute());
}

// Route per Link teilen (kopiert den Link in die Zwischenablage)
const shareRouteBtn = document.getElementById('shareRouteBtn');
const shareStatusEl = document.getElementById('shareStatus');
if (shareRouteBtn) {
  shareRouteBtn.addEventListener('click', async () => {
    const url = buildShareUrl();
    if (!url) {
      if (shareStatusEl) shareStatusEl.textContent = '⚠️ Keine Route zum Teilen vorhanden.';
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      if (shareStatusEl) shareStatusEl.textContent = '✅ Link kopiert! Einfach weiterschicken — oder den QR-Code unten direkt scannen lassen.';
    } catch (err) {
      window.prompt('Link zum Kopieren (Strg+C):', url);
      if (shareStatusEl) shareStatusEl.textContent = '🔗 Link bereit zum Kopieren.';
    }
    renderShareQr(url);
  });
}

// Zeigt den Teilen-Link zusätzlich als QR-Code an — damit muss niemand den
// (wenn auch jetzt viel kürzeren) Buchstaben/Zahlen-Link lesen oder abtippen,
// sondern einfach mit dem Handy scannen. Nutzt die externe "qrcode"-Bibliothek
// (per <script> in der HTML eingebunden); fehlt sie (z. B. offline geladen),
// wird der Hinweis einfach ausgeblendet statt die App zum Absturz zu bringen.
function renderShareQr(url) {
  const wrap = document.getElementById('shareQrWrap');
  const canvas = document.getElementById('shareQrCanvas');
  if (!wrap || !canvas) return;
  if (typeof QRCode === 'undefined' || !QRCode.toCanvas) {
    wrap.hidden = true;
    return;
  }
  QRCode.toCanvas(canvas, url, { width: 180, margin: 1 }, (err) => {
    if (err) {
      console.warn('⚠️ QR-Code konnte nicht erzeugt werden:', err.message);
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
  });
}

// Neuland-Einfärbung auf der Route ein/ausschalten
const neulandOverlayToggle = document.getElementById('neulandOverlayToggle');
if (neulandOverlayToggle) {
  neulandOverlayToggle.addEventListener('change', () => {
    neulandOverlayActive = neulandOverlayToggle.checked;
    if (neulandOverlayActive) drawNeulandOverlay(); else clearNeulandOverlay();
  });
}

// Beim Laden prüfen, ob ein Teilen-Link (#route=...) in der URL steckt
applyShareFromUrlIfPresent();
