/**
 * ApexNotes – Jednoduchá rally navigace (PWA)
 * - Zjednodušené navigační UI (velká otočná mapa ve stylu Waze / Rally GPS)
 * - Otáčení mapy podle směru jízdy řidiče (heading-up) + tmavé mapové dlaždice
 * - Zadání Startu a Cíle (Nominatim + OSRM routování + okamžitý výpočet rally rozpisu)
 * - Český hlas spolujezdce s dynamickým předstihem podle rychlosti
 */

(function () {
  'use strict';

  const FREE_KM_LIMIT = 40.0;
  const EARTH_R = 6371000.0;
  const TILE_SIZE = 256;
  const MAP_ZOOM = 16;

  const state = {
    stages: window.APEXNOTES_STAGES || [],
    currentStage: null,
    isRunning: false,
    useRealGps: false,
    gpsWatchId: null,
    audioEnabled: true,
    distanceM: 0.0,
    speedKmh: 90.0,
    leadTimeSec: 3.5,
    currentHeadingRad: 0.0, // Směr jízdy (0 = Sever, PI/2 = Východ)
    customStartCoords: null,
    spokenNoteIds: new Set(),
    activeNote: null,
    nextNote: null,
    lastTickTime: null,
    odometerKm: parseFloat(localStorage.getItem('apexnotes_odometer_km') || '0.0'),
    isProUnlocked: localStorage.getItem('apexnotes_pro_unlocked') === 'true',
    audioCtx: null,
    tileCache: new Map()
  };

  const el = {
    primaryCallCard: document.getElementById('primaryCallCard'),
    cornerArrowPath: document.getElementById('cornerArrowPath'),
    cornerShortCode: document.getElementById('cornerShortCode'),
    callDistanceCountdown: document.getElementById('callDistanceCountdown'),
    gpsStatusBadge: document.getElementById('gpsStatusBadge'),
    callCzechText: document.getElementById('callCzechText'),
    cornerModBadges: document.getElementById('cornerModBadges'),
    nextCallSummary: document.getElementById('nextCallSummary'),
    btnAudioToggle: document.getElementById('btnAudioToggle'),
    trackCanvas: document.getElementById('trackCanvas'),
    speedValue: document.getElementById('speedValue'),
    stageProgressText: document.getElementById('stageProgressText'),
    activeRouteName: document.getElementById('activeRouteName'),
    freemiumPill: document.getElementById('freemiumPill'),
    btnOpenRoute: document.getElementById('btnOpenRoute'),
    btnStartPause: document.getElementById('btnStartPause'),
    btnRealGps: document.getElementById('btnRealGps'),
    btnOpenSettings: document.getElementById('btnOpenSettings'),
    // Route modal
    routeModal: document.getElementById('routeModal'),
    btnCloseRoute: document.getElementById('btnCloseRoute'),
    inputStart: document.getElementById('inputStart'),
    inputEnd: document.getElementById('inputEnd'),
    btnUseMyLocation: document.getElementById('btnUseMyLocation'),
    btnCalculateRoute: document.getElementById('btnCalculateRoute'),
    routeSearchStatus: document.getElementById('routeSearchStatus'),
    stageSelect: document.getElementById('stageSelect'),
    gpxFileInput: document.getElementById('gpxFileInput'),
    // Settings modal
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    speedSlider: document.getElementById('speedSlider'),
    speedSliderLabel: document.getElementById('speedSliderLabel'),
    leadTimeSlider: document.getElementById('leadTimeSlider'),
    leadTimeLabel: document.getElementById('leadTimeLabel'),
    btnReset: document.getElementById('btnReset'),
    btnTestVoice: document.getElementById('btnTestVoice'),
    // Freemium modal
    freemiumModal: document.getElementById('freemiumModal'),
    btnCloseFreemium: document.getElementById('btnCloseFreemium'),
    kmMeterFill: document.getElementById('kmMeterFill'),
    modalKmDetail: document.getElementById('modalKmDetail'),
    btnUnlockPro: document.getElementById('btnUnlockPro'),
    btnResetTrial: document.getElementById('btnResetTrial')
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // =========================================================================
  // 1. HLASOVÝ SYNTETIZÉR (ČESKÝ SPOLUJEZDEC)
  // =========================================================================
  function ensureAudioContext() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) state.audioCtx = new AC();
    }
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
  }

  function playIntercomCue(severity) {
    if (!state.audioEnabled) return;
    ensureAudioContext();
    if (!state.audioCtx) return;

    const now = state.audioCtx.currentTime;
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    const freqMap = { 1: 780, 2: 660, 3: 540, 4: 460, 5: 400, 6: 350, 0: 310 };
    osc.frequency.setValueAtTime(freqMap[severity] || 440, now);
    osc.type = severity <= 2 && severity > 0 ? 'sawtooth' : 'sine';

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.11);
  }

  function speakCzechPacenote(textCz, severity = 3) {
    if (!state.audioEnabled) return;
    playIntercomCue(severity);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(textCz);
      utter.lang = 'cs-CZ';
      utter.rate = 1.18;
      utter.pitch = severity === 1 ? 1.1 : 1.0;
      const voices = window.speechSynthesis.getVoices();
      const czVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('cs'));
      if (czVoice) utter.voice = czVoice;
      window.speechSynthesis.speak(utter);
    }
  }

  // =========================================================================
  // 2. ŠIPKY ZATÁČEK
  // =========================================================================
  function getCornerSvgPath(dir, severity) {
    if (dir === 'S' || !severity) {
      return 'M60 102 L60 20 M36 44 L60 18 L84 44';
    }
    const left = {
      1: 'M76 102 L76 42 C76 16 34 16 34 44 L34 86 M16 68 L34 90 L52 68',
      2: 'M78 102 L78 52 C78 28 55 24 24 24 M44 8 L20 24 L44 40',
      3: 'M74 102 L74 58 C74 36 52 26 26 22 M48 10 L22 22 L42 42',
      4: 'M70 102 L70 62 C70 42 50 28 30 18 M54 12 L28 18 L40 42',
      5: 'M66 102 L66 64 C66 44 52 30 38 16 M62 16 L36 16 L40 42',
      6: 'M64 102 L60 58 L44 18 M66 28 L44 16 L34 40'
    };
    const right = {
      1: 'M44 102 L44 42 C44 16 86 16 86 44 L86 86 M68 68 L86 90 L104 68',
      2: 'M42 102 L42 52 C42 28 65 24 96 24 M76 8 L100 24 L76 40',
      3: 'M46 102 L46 58 C46 36 68 26 94 22 M72 10 L98 22 L78 42',
      4: 'M50 102 L50 62 C50 42 70 28 90 18 M66 12 L92 18 L80 42',
      5: 'M54 102 L54 64 C54 44 68 30 82 16 M58 16 L84 16 L80 42',
      6: 'M56 102 L60 58 L76 18 M54 28 L76 16 L86 40'
    };
    return (dir === 'L' ? left : right)[severity] || left[3];
  }

  // =========================================================================
  // 3. VÝPOČET ROZPISU Z LIBOVOLNÝCH BODŮ (OSRM START->CÍL I GPX)
  // =========================================================================
  function buildStageFromPoints(rawLatLonEle, stageName) {
    const lat0 = (rawLatLonEle[0].lat * Math.PI) / 180;
    const lon0 = (rawLatLonEle[0].lon * Math.PI) / 180;
    const cosLat0 = Math.cos(lat0);

    const pts = [];
    let totalS = 0;
    for (const p of rawLatLonEle) {
      const x = (((p.lon * Math.PI) / 180) - lon0) * cosLat0 * EARTH_R;
      const y = (((p.lat * Math.PI) / 180) - lat0) * EARTH_R;
      if (pts.length) {
        const d = Math.hypot(x - pts[pts.length - 1].x, y - pts[pts.length - 1].y);
        if (d < 2.0) continue;
        totalS += d;
      }
      pts.push({ lat: p.lat, lon: p.lon, ele: p.ele || 300, x, y, s: totalS, r: 999, dir: 'S' });
    }

    // Mengerova křivost
    for (let i = 2; i < pts.length - 2; i++) {
      const p1 = pts[i - 2], p2 = pts[i], p3 = pts[i + 2];
      const v1x = p2.x - p1.x, v1y = p2.y - p1.y;
      const v2x = p3.x - p2.x, v2y = p3.y - p2.y;
      const a = Math.hypot(v1x, v1y), b = Math.hypot(v2x, v2y), c = Math.hypot(p3.x - p1.x, p3.y - p1.y);
      const cross = v1x * v2y - v1y * v2x;
      if (a * b * c > 1e-3 && Math.abs(cross) > 1e-3) {
        const kappa = (2 * Math.abs(cross)) / (a * b * c);
        p2.r = Math.min(999, Math.round((1 / kappa) * 10) / 10);
        p2.dir = cross > 0 ? 'L' : 'P';
      }
    }

    const sevWords = { 1: 'jedna', 2: 'dva', 3: 'tři', 4: 'čtyři', 5: 'pět', 6: 'šest' };
    const pacenotes = [];
    let lastCornerEnd = 0;
    let i = 2;

    while (i < pts.length - 2) {
      if (pts[i].r <= 220) {
        const cDir = pts[i].dir;
        const startS = pts[i].s;
        let minR = pts[i].r;
        let apex = pts[i];
        while (i < pts.length - 2 && pts[i].r <= 230 && pts[i].dir === cDir) {
          if (pts[i].r < minR) { minR = pts[i].r; apex = pts[i]; }
          i++;
        }
        const endS = pts[i].s;
        const sev = minR < 22 ? 1 : minR < 38 ? 2 : minR < 62 ? 3 : minR < 98 ? 4 : minR < 155 ? 5 : 6;
        const straight = Math.round((startS - lastCornerEnd) / 10) * 10;
        if (straight >= 50) {
          pacenotes.push({
            id: pacenotes.length + 1, type: 'straight', dir: 'S', severity: 0,
            distance_m: lastCornerEnd + 5, end_distance_m: startS, radius_m: 999,
            short_label: `↑ ${straight} m`, call_cz: `Dále ${straight}`
          });
        }
        const dirWord = cDir === 'L' ? 'Levá' : 'Pravá';
        pacenotes.push({
          id: pacenotes.length + 1, type: 'corner', dir: cDir, severity: sev,
          is_hairpin: sev === 1, distance_m: Math.round(startS), end_distance_m: Math.round(endS),
          radius_m: minR, lat: apex.lat, lon: apex.lon,
          short_label: `${cDir}${sev}`, call_cz: `${dirWord} ${sevWords[sev]}${sev === 1 ? ' vracák' : ''}`
        });
        lastCornerEnd = endS;
      } else {
        i++;
      }
    }

    return {
      id: 'route_' + Date.now(),
      name: stageName,
      total_length_m: Math.round(totalS),
      total_length_km: (totalS / 1000).toFixed(2),
      min_ele_m: 300,
      max_ele_m: 400,
      corners_count: pacenotes.filter((n) => n.type === 'corner').length,
      pacenotes,
      geometry: pts
    };
  }

  // =========================================================================
  // 4. VYHLEDÁNÍ START -> CÍL (NOMINATIM + OSRM)
  // =========================================================================
  async function geocodePlace(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cz,sk&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'cs' } });
    const data = await res.json();
    if (!data || !data.length) throw new Error(`Místo „${query}“ nenalezeno.`);
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name.split(',')[0] };
  }

  async function calculateStartEndRoute() {
    const startTxt = el.inputStart.value.trim();
    const endTxt = el.inputEnd.value.trim();
    if (!endTxt || (!startTxt && !state.customStartCoords)) {
      el.routeSearchStatus.textContent = 'Zadej prosím Start i Cíl.';
      return;
    }

    el.routeSearchStatus.textContent = 'Hledám trasu...';
    el.btnCalculateRoute.disabled = true;

    try {
      let startCoord = state.customStartCoords;
      let startLabel = 'Moje poloha';
      if (!startCoord || startTxt !== '📍 Moje aktuální poloha') {
        const gStart = await geocodePlace(startTxt);
        startCoord = { lat: gStart.lat, lon: gStart.lon };
        startLabel = gStart.label;
      }
      const gEnd = await geocodePlace(endTxt);

      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startCoord.lon},${startCoord.lat};${gEnd.lon},${gEnd.lat}?overview=full&geometries=geojson`;
      const resp = await fetch(osrmUrl);
      const data = await resp.json();
      if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
        throw new Error('Nepodařilo se najít silniční trasu.');
      }

      const rawPts = data.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon, ele: 300 }));
      const newStage = buildStageFromPoints(rawPts, `${startLabel} → ${gEnd.label}`);

      state.stages.unshift(newStage);
      populateStageSelect();
      selectStage(newStage.id);
      el.routeSearchStatus.textContent = '';
      el.routeModal.classList.add('hidden');
      speakCzechPacenote(`Trasa ${startLabel} do ${gEnd.label} připravena.`, 4);
    } catch (err) {
      el.routeSearchStatus.textContent = 'Chyba: ' + err.message;
    } finally {
      el.btnCalculateRoute.disabled = false;
    }
  }

  // =========================================================================
  // 5. OTÁČEJÍCÍ SE NAVIGAČNÍ MAPA (HEADING-UP + TMAVÉ MAPOVÉ DLAŽDICE)
  // =========================================================================
  function latLonToWorldPx(lat, lon, zoom) {
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * scale;
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return [x, y];
  }

  function getTileImage(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (state.tileCache.has(key)) return state.tileCache.get(key);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    // Tmavá navigační mapa CartoDB Dark Matter (zdarma bez API klíče)
    img.src = `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
    img.onload = () => {
      if (!state.isRunning) drawRotatingNavMap();
    };
    state.tileCache.set(key, img);
    return img;
  }

  function interpolateCarPosAndHeading(geom, distM) {
    let idx = 0;
    for (let i = 0; i < geom.length; i++) {
      if (geom[i].s <= distM) idx = i;
      else break;
    }
    const p0 = geom[idx];
    const p1 = geom[Math.min(geom.length - 1, idx + 1)];

    let lat = p0.lat, lon = p0.lon;
    if (p1.s > p0.s) {
      const t = Math.min(1, Math.max(0, (distM - p0.s) / (p1.s - p0.s)));
      lat = p0.lat + (p1.lat - p0.lat) * t;
      lon = p0.lon + (p1.lon - p0.lon) * t;
    }

    // Výpočet směru jízdy (heading) o kousek dopředu pro plynulé otáčení mapy
    const pAhead = geom[Math.min(geom.length - 1, idx + 3)];
    const dLon = (pAhead.lon - p0.lon) * Math.cos((lat * Math.PI) / 180);
    const dLat = pAhead.lat - p0.lat;
    let heading = state.currentHeadingRad;
    if (Math.abs(dLon) > 1e-7 || Math.abs(dLat) > 1e-7) {
      const targetHeading = Math.atan2(dLon, dLat); // 0 = Sever, +PI/2 = Východ
      // Plynulá interpolace úhlu, aby mapa necukala
      let diff = targetHeading - state.currentHeadingRad;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      heading = state.currentHeadingRad + diff * 0.25;
      state.currentHeadingRad = heading;
    }
    return { lat, lon, heading };
  }

  function resizeCanvasIfNeeded() {
    const canvas = el.trackCanvas;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
      canvas.width = Math.floor(rect.width);
      canvas.height = Math.floor(rect.height);
    }
  }

  function drawRotatingNavMap() {
    resizeCanvasIfNeeded();
    const canvas = el.trackCanvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!state.currentStage || !state.currentStage.geometry.length) return;
    const geom = state.currentStage.geometry;
    const car = interpolateCarPosAndHeading(geom, state.distanceM);

    // Šipka auta bude v dolní třetině obrazovky (jako v Waze), aby řidič viděl daleko dopředu!
    const anchorX = w * 0.5;
    const anchorY = h * 0.68;

    const [carWx, carWy] = latLonToWorldPx(car.lat, car.lon, MAP_ZOOM);

    ctx.save();
    // Otočíme celý svět kolem pozice auta tak, aby směr jízdy mířil VŽDY NAHORU
    ctx.translate(anchorX, anchorY);
    ctx.rotate(-car.heading);

    // 1. Vykreslení mapových dlaždic kolem auta
    const maxTiles = Math.pow(2, MAP_ZOOM);
    const centerTx = Math.floor(carWx / TILE_SIZE);
    const centerTy = Math.floor(carWy / TILE_SIZE);
    const tileRange = 2;

    for (let dx = -tileRange; dx <= tileRange; dx++) {
      for (let dy = -tileRange; dy <= tileRange; dy++) {
        const tx = ((centerTx + dx) % maxTiles + maxTiles) % maxTiles;
        const ty = centerTy + dy;
        if (ty < 0 || ty >= maxTiles) continue;
        const img = getTileImage(MAP_ZOOM, tx, ty);
        if (img.complete && img.naturalWidth > 0) {
          const drawX = tx * TILE_SIZE - carWx;
          const drawY = ty * TILE_SIZE - carWy;
          ctx.drawImage(img, drawX, drawY, TILE_SIZE, TILE_SIZE);
        }
      }
    }

    // 2. Vykreslení trasy (barevně podle ostrosti zatáček)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < geom.length; i++) {
      const p0 = geom[i - 1];
      const p1 = geom[i];
      const [wx0, wy0] = latLonToWorldPx(p0.lat, p0.lon, MAP_ZOOM);
      const [wx1, wy1] = latLonToWorldPx(p1.lat, p1.lon, MAP_ZOOM);

      ctx.beginPath();
      ctx.moveTo(wx0 - carWx, wy0 - carWy);
      ctx.lineTo(wx1 - carWx, wy1 - carWy);

      if (p1.s <= state.distanceM) {
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.65)';
        ctx.lineWidth = 8;
      } else if (p1.r < 38) {
        ctx.strokeStyle = '#ff2e2e';
        ctx.lineWidth = 10;
      } else if (p1.r < 95) {
        ctx.strokeStyle = '#ffd000';
        ctx.lineWidth = 9;
      } else {
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 8;
      }
      ctx.stroke();
    }

    ctx.restore();

    // 3. Vykreslení navigační šipky auta (míří vždy nahoru)
    ctx.save();
    ctx.translate(anchorX, anchorY);

    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 229, 255, 0.22)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.lineTo(13, 13);
    ctx.lineTo(0, 7);
    ctx.lineTo(-13, 13);
    ctx.closePath();
    ctx.fillStyle = '#00e5ff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();
  }

  // =========================================================================
  // 6. TELEMETRIE & HLASOVÉ ČTENÍ S PŘEDSTIHEM
  // =========================================================================
  function getDynamicLeadDistanceM() {
    return Math.max(25.0, (state.speedKmh / 3.6) * state.leadTimeSec);
  }

  function updateLeadTimeLabel() {
    const leadM = Math.round(getDynamicLeadDistanceM());
    el.leadTimeLabel.textContent = `${state.leadTimeSec.toFixed(1)} s (${leadM} m)`;
  }

  function evaluatePacenotesAtDistance(distM) {
    if (!state.currentStage) return;
    const notes = state.currentStage.pacenotes;
    const leadM = getDynamicLeadDistanceM();
    const lookaheadM = distM + leadM;

    const upcomingIdx = notes.findIndex((n) => n.end_distance_m >= distM);
    if (upcomingIdx === -1) {
      if (state.isRunning) finishStage();
      return;
    }

    const current = notes[upcomingIdx];
    const next = notes[upcomingIdx + 1] || null;
    state.activeNote = current;
    state.nextNote = next;

    if (state.isRunning && current.distance_m <= lookaheadM && !state.spokenNoteIds.has(current.id)) {
      state.spokenNoteIds.add(current.id);
      speakCzechPacenote(current.call_cz, current.severity || 0);
    }

    if (state.isRunning && next && next.distance_m <= distM + leadM * 0.55 && !state.spokenNoteIds.has(next.id)) {
      state.spokenNoteIds.add(next.id);
      speakCzechPacenote(next.call_cz, next.severity || 0);
    }

    renderHud(current, next, distM);
  }

  function renderHud(note, nextNote, distM) {
    if (!note) return;
    const toCornerM = Math.max(0, Math.round(note.distance_m - distM));
    el.callDistanceCountdown.textContent = toCornerM > 0 ? `ZA ${toCornerM} m` : 'V ZATÁČCE';
    el.primaryCallCard.className = `hud-banner sev-${note.severity || 0}`;
    el.cornerArrowPath.setAttribute('d', getCornerSvgPath(note.dir, note.severity));
    el.cornerShortCode.textContent = note.short_label;
    el.callCzechText.textContent = note.call_cz;

    el.cornerModBadges.innerHTML = '';
    if (note.is_hairpin) addBadge('VRACÁK', 'danger');
    if (note.modifier === 'utahuje') addBadge('UTAHUJE', 'danger');
    if (note.has_crest) addBadge('HORIZONT', 'warn');

    el.nextCallSummary.textContent = nextNote ? `Potom: ${nextNote.call_cz}` : 'Potom: CÍL';
    const totalKm = (state.currentStage.total_length_m / 1000).toFixed(1);
    const currKm = (distM / 1000).toFixed(1);
    el.stageProgressText.textContent = `${currKm} / ${totalKm} km`;
  }

  function addBadge(label, type) {
    const span = document.createElement('span');
    span.className = `mod-tag ${type}`;
    span.textContent = label;
    el.cornerModBadges.appendChild(span);
  }

  // =========================================================================
  // 7. FREEMIUM & BĚH SIMULACE / GPS
  // =========================================================================
  function updateFreemiumUi() {
    if (state.isProUnlocked) {
      el.freemiumPill.classList.add('pro-unlocked');
      el.freemiumPill.textContent = 'PRO ∞';
      el.kmMeterFill.style.width = '100%';
      el.modalKmDetail.textContent = `Plná verze aktivní (odjeto ${state.odometerKm.toFixed(1)} km)`;
    } else {
      el.freemiumPill.classList.remove('pro-unlocked');
      el.freemiumPill.textContent = `${state.odometerKm.toFixed(1)} / ${FREE_KM_LIMIT} km`;
      el.kmMeterFill.style.width = `${Math.min(100, (state.odometerKm / FREE_KM_LIMIT) * 100)}%`;
      el.modalKmDetail.textContent = `Odjeto: ${state.odometerKm.toFixed(1)} / ${FREE_KM_LIMIT.toFixed(1)} km`;
    }
  }

  function addDrivenMeters(deltaM) {
    if (deltaM <= 0) return;
    state.odometerKm += deltaM / 1000.0;
    localStorage.setItem('apexnotes_odometer_km', state.odometerKm.toFixed(3));
    updateFreemiumUi();
    if (!state.isProUnlocked && state.odometerKm >= FREE_KM_LIMIT) {
      pauseStage();
      el.freemiumModal.classList.remove('hidden');
    }
  }

  function tickSimulation(timestamp) {
    if (!state.isRunning) return;
    if (!state.lastTickTime) state.lastTickTime = timestamp;
    const dtSec = Math.min(0.25, (timestamp - state.lastTickTime) / 1000.0);
    state.lastTickTime = timestamp;

    if (!state.useRealGps) {
      const deltaM = (state.speedKmh / 3.6) * dtSec;
      state.distanceM += deltaM;
      addDrivenMeters(deltaM);
    }

    evaluatePacenotesAtDistance(state.distanceM);
    drawRotatingNavMap();
    if (state.isRunning) requestAnimationFrame(tickSimulation);
  }

  function startStage() {
    if (!state.currentStage) return;
    if (!state.isProUnlocked && state.odometerKm >= FREE_KM_LIMIT) {
      el.freemiumModal.classList.remove('hidden');
      return;
    }
    ensureAudioContext();
    if (state.distanceM >= state.currentStage.total_length_m - 10) resetStage();
    state.isRunning = true;
    state.lastTickTime = null;
    el.btnStartPause.textContent = '⏸ PAUZA';
    el.btnStartPause.classList.add('running');
    if (state.distanceM < 5 && state.spokenNoteIds.size === 0) {
      speakCzechPacenote('Start trasy', 4);
    }
    requestAnimationFrame(tickSimulation);
  }

  function pauseStage() {
    state.isRunning = false;
    state.lastTickTime = null;
    el.btnStartPause.textContent = '▶ POKRAČOVAT';
    el.btnStartPause.classList.remove('running');
  }

  function resetStage() {
    pauseStage();
    state.distanceM = 0.0;
    state.spokenNoteIds.clear();
    el.btnStartPause.textContent = '▶ START';
    if (state.currentStage && state.currentStage.pacenotes.length) {
      renderHud(state.currentStage.pacenotes[0], state.currentStage.pacenotes[1] || null, 0);
    }
    drawRotatingNavMap();
  }

  function finishStage() {
    pauseStage();
    el.btnStartPause.textContent = '🏁 ZNOVU';
    el.cornerShortCode.textContent = 'CÍL';
    el.callCzechText.textContent = 'DORAZIL JSI DO CÍLE!';
    speakCzechPacenote('Cíl trasy', 5);
  }

  function toggleRealGps() {
    if (state.useRealGps) {
      if (state.gpsWatchId !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(state.gpsWatchId);
      }
      state.gpsWatchId = null;
      state.useRealGps = false;
      el.gpsStatusBadge.textContent = 'SIMULACE';
      el.gpsStatusBadge.className = 'badge badge-sim';
      el.btnRealGps.classList.remove('active-gps');
      return;
    }
    if (!('geolocation' in navigator)) {
      alert('Prohlížeč nepodporuje GPS.');
      return;
    }
    state.useRealGps = true;
    el.gpsStatusBadge.textContent = 'GPS';
    el.gpsStatusBadge.className = 'badge badge-gps';
    el.btnRealGps.classList.add('active-gps');

    state.gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed } = pos.coords;
        if (typeof speed === 'number' && !isNaN(speed) && speed >= 0) {
          state.speedKmh = Math.max(10, Math.round(speed * 3.6));
          el.speedValue.textContent = state.speedKmh;
          el.speedSlider.value = state.speedKmh;
          el.speedSliderLabel.textContent = `${state.speedKmh} km/h`;
          updateLeadTimeLabel();
        }
        if (state.currentStage && state.currentStage.geometry.length) {
          let bestPt = state.currentStage.geometry[0];
          let bestDist = Infinity;
          for (const p of state.currentStage.geometry) {
            const dLat = (p.lat - latitude) * 111320;
            const dLon = (p.lon - longitude) * 111320 * Math.cos((latitude * Math.PI) / 180);
            const d = dLat * dLat + dLon * dLon;
            if (d < bestDist) { bestDist = d; bestPt = p; }
          }
          const deltaM = Math.max(0, bestPt.s - state.distanceM);
          state.distanceM = bestPt.s;
          addDrivenMeters(deltaM);
          evaluatePacenotesAtDistance(state.distanceM);
          drawRotatingNavMap();
        }
      },
      (err) => {
        alert('Chyba GPS: ' + err.message);
        toggleRealGps();
      },
      { enableHighAccuracy: true, maximumAge: 250, timeout: 8000 }
    );
  }

  // =========================================================================
  // 8. NAČTENÍ GPX + INICIALIZACE
  // =========================================================================
  function parseUploadedGpx(xmlText, fileName) {
    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
    const trkpts = Array.from(xml.querySelectorAll('trkpt, rtept'));
    if (trkpts.length < 5) {
      alert('GPX soubor nemá dost bodů.');
      return;
    }
    const rawPts = trkpts.map((pt) => ({
      lat: parseFloat(pt.getAttribute('lat')),
      lon: parseFloat(pt.getAttribute('lon')),
      ele: 300
    }));
    const nameEl = xml.querySelector('trk > name, metadata > name');
    const trackName = nameEl ? nameEl.textContent.trim() : fileName.replace(/\.gpx$/i, '');
    const customStage = buildStageFromPoints(rawPts, `${trackName} (GPX)`);
    state.stages.unshift(customStage);
    populateStageSelect();
    selectStage(customStage.id);
    el.routeModal.classList.add('hidden');
  }

  function populateStageSelect() {
    el.stageSelect.innerHTML = '';
    for (const st of state.stages) {
      const opt = document.createElement('option');
      opt.value = st.id;
      opt.textContent = `${st.name} (${st.total_length_km} km)`;
      el.stageSelect.appendChild(opt);
    }
  }

  function selectStage(stageId) {
    const found = state.stages.find((s) => s.id === stageId) || state.stages[0];
    if (!found) return;
    state.currentStage = found;
    el.stageSelect.value = found.id;
    el.activeRouteName.textContent = found.name;
    resetStage();
  }

  function init() {
    populateStageSelect();
    if (state.stages.length > 0) selectStage(state.stages[0].id);
    updateFreemiumUi();
    updateLeadTimeLabel();

    window.addEventListener('resize', drawRotatingNavMap);

    el.btnStartPause.addEventListener('click', () => (state.isRunning ? pauseStage() : startStage()));
    el.btnRealGps.addEventListener('click', toggleRealGps);
    el.btnAudioToggle.addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      el.btnAudioToggle.textContent = state.audioEnabled ? '🔊' : '🔇';
    });

    // Route modal (Start -> Cíl)
    el.btnOpenRoute.addEventListener('click', () => el.routeModal.classList.remove('hidden'));
    el.btnCloseRoute.addEventListener('click', () => el.routeModal.classList.add('hidden'));
    el.btnCalculateRoute.addEventListener('click', calculateStartEndRoute);
    el.btnUseMyLocation.addEventListener('click', () => {
      if (!('geolocation' in navigator)) return;
      el.routeSearchStatus.textContent = 'Zjišťuji polohu...';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.customStartCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          el.inputStart.value = '📍 Moje aktuální poloha';
          el.routeSearchStatus.textContent = '';
        },
        (err) => { el.routeSearchStatus.textContent = 'Nelze zjistit GPS: ' + err.message; },
        { enableHighAccuracy: true, timeout: 6000 }
      );
    });
    el.stageSelect.addEventListener('change', (e) => {
      selectStage(e.target.value);
      el.routeModal.classList.add('hidden');
    });
    el.gpxFileInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = (ev) => parseUploadedGpx(ev.target.result, f.name);
      r.readAsText(f);
    });

    // Settings modal
    el.btnOpenSettings.addEventListener('click', () => el.settingsModal.classList.remove('hidden'));
    el.btnCloseSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    el.btnReset.addEventListener('click', () => { resetStage(); el.settingsModal.classList.add('hidden'); });
    el.btnTestVoice.addEventListener('click', () => {
      ensureAudioContext();
      speakCzechPacenote(state.activeNote ? state.activeNote.call_cz : 'Pravá čtyři utahuje', 3);
    });
    el.speedSlider.addEventListener('input', (e) => {
      state.speedKmh = parseFloat(e.target.value);
      el.speedValue.textContent = state.speedKmh;
      el.speedSliderLabel.textContent = `${state.speedKmh} km/h`;
      updateLeadTimeLabel();
    });
    el.leadTimeSlider.addEventListener('input', (e) => {
      state.leadTimeSec = parseFloat(e.target.value);
      updateLeadTimeLabel();
    });

    // Freemium modal
    el.freemiumPill.addEventListener('click', () => { updateFreemiumUi(); el.freemiumModal.classList.remove('hidden'); });
    el.btnCloseFreemium.addEventListener('click', () => el.freemiumModal.classList.add('hidden'));
    el.btnUnlockPro.addEventListener('click', () => {
      state.isProUnlocked = true;
      localStorage.setItem('apexnotes_pro_unlocked', 'true');
      updateFreemiumUi();
      el.freemiumModal.classList.add('hidden');
    });
    el.btnResetTrial.addEventListener('click', () => {
      state.isProUnlocked = false;
      state.odometerKm = 0.0;
      localStorage.setItem('apexnotes_pro_unlocked', 'false');
      localStorage.setItem('apexnotes_odometer_km', '0.0');
      updateFreemiumUi();
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
