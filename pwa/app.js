/**
 * ApexNotes – Rally Navigace (PWA)
 * - Výchozí režim: Reálná GPS navigace (přepínání na Demo simulaci v ⚙️ Nastavení)
 * - Dvou-vrstvá otočná mapa (OpenStreetMap dlaždice bez API klíče v tmavém režimu + barevná trasa)
 * - Našeptávač lokací Start -> Cíl (Photon API) + OSRM routování
 * - Dynamický odpočet dlouhých rovinek (680 -> 500 -> 300 -> 200 -> 100) v hlavním pokynu
 * - Zobrazení nadcházející zatáčky + ještě o 1 pokyn napřed
 * - Předstih čtení hlášek nastavitelný až do 15.0 s + fronta hlasu (nezahazuje nadcházející zatáčku)
 */

(function () {
  'use strict';

  const FREE_KM_LIMIT = 40.0;
  const EARTH_R = 6371000.0;
  const TILE_SIZE = 256;
  const MAP_ZOOM = 16;
  const STRAIGHT_MILESTONES = [1000, 800, 600, 500, 400, 300, 200, 150, 100];

  const state = {
    stages: window.APEXNOTES_STAGES || [],
    currentStage: null,
    corners: [],          // Čistý seznam zatáček pro aktuální trasu
    demoMode: false,      // Výchozí = Reálná GPS! (Demo se přepíná v ⚙️)
    isRunning: false,
    gpsWatchId: null,
    gpsHasFix: false,
    liveGpsPos: null,     // { lat, lon, heading }
    audioEnabled: true,
    distanceM: 0.0,
    demoSpeedKmh: 90.0,
    currentSpeedKmh: 0.0,
    leadTimeSec: 5.0,
    currentHeadingRad: 0.0,
    selectedStart: null,  // { lat, lon, label }
    selectedEnd: null,    // { lat, lon, label }
    spokenCornerIds: new Set(),
    spokenMilestones: new Set(), // klíč: `${cornerId}_${milestone}`
    lastStraightAnnouncedFor: null,
    speechQueue: [],
    isSpeaking: false,
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
    nextCornerCode: document.getElementById('nextCornerCode'),
    nextCornerText: document.getElementById('nextCornerText'),
    afterCornerCode: document.getElementById('afterCornerCode'),
    afterCornerText: document.getElementById('afterCornerText'),
    btnAudioToggle: document.getElementById('btnAudioToggle'),
    mapBgCanvas: document.getElementById('mapBgCanvas'),
    trackCanvas: document.getElementById('trackCanvas'),
    speedValue: document.getElementById('speedValue'),
    stageProgressText: document.getElementById('stageProgressText'),
    activeRouteName: document.getElementById('activeRouteName'),
    freemiumPill: document.getElementById('freemiumPill'),
    btnOpenRoute: document.getElementById('btnOpenRoute'),
    btnStartPause: document.getElementById('btnStartPause'),
    btnOpenSettings: document.getElementById('btnOpenSettings'),
    // Route modal
    routeModal: document.getElementById('routeModal'),
    btnCloseRoute: document.getElementById('btnCloseRoute'),
    inputStart: document.getElementById('inputStart'),
    inputEnd: document.getElementById('inputEnd'),
    startSuggestions: document.getElementById('startSuggestions'),
    endSuggestions: document.getElementById('endSuggestions'),
    btnUseMyLocation: document.getElementById('btnUseMyLocation'),
    btnCalculateRoute: document.getElementById('btnCalculateRoute'),
    routeSearchStatus: document.getElementById('routeSearchStatus'),
    stageSelect: document.getElementById('stageSelect'),
    gpxFileInput: document.getElementById('gpxFileInput'),
    // Settings modal
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    modeStatusText: document.getElementById('modeStatusText'),
    btnModeGps: document.getElementById('btnModeGps'),
    btnModeDemo: document.getElementById('btnModeDemo'),
    demoSpeedSection: document.getElementById('demoSpeedSection'),
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
  // 1. CHYTRÁ FRONTA HLASU (ČESKÝ SPOLUJEZDEC – NIKDY NEUSEKNE ZATÁČKU)
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
    gain.gain.exponentialRampToValueAtTime(0.11, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  function queueSpeech(textCz, severity = 3, isPriorityCorner = false) {
    if (!state.audioEnabled) return;
    if (!('speechSynthesis' in window)) {
      playIntercomCue(severity);
      return;
    }

    // Důležitá zatáčka odstraní ze zásobníku případné staré nevyřčené odpočty rovinky
    if (isPriorityCorner) {
      state.speechQueue = state.speechQueue.filter((item) => item.isPriorityCorner);
    }

    // Zamezíme duplicitě stejné hlášky hned za sebou
    if (state.speechQueue.length && state.speechQueue[state.speechQueue.length - 1].textCz === textCz) {
      return;
    }

    state.speechQueue.push({ textCz, severity, isPriorityCorner });
    processSpeechQueue();
  }

  function processSpeechQueue() {
    if (state.isSpeaking || !state.speechQueue.length) return;
    const item = state.speechQueue.shift();
    state.isSpeaking = true;

    playIntercomCue(item.severity);

    const utter = new SpeechSynthesisUtterance(item.textCz);
    utter.lang = 'cs-CZ';
    utter.rate = 1.2;
    utter.pitch = item.severity === 1 ? 1.1 : 1.0;

    const voices = window.speechSynthesis.getVoices();
    const czVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('cs'));
    if (czVoice) utter.voice = czVoice;

    const finish = () => {
      state.isSpeaking = false;
      processSpeechQueue();
    };
    utter.onend = finish;
    utter.onerror = finish;

    // Pojistka proti zaseknutí speechSynthesis na iOS
    setTimeout(() => {
      if (state.isSpeaking && !window.speechSynthesis.speaking) {
        finish();
      }
    }, 3500);

    window.speechSynthesis.speak(utter);
  }

  function clearSpeechQueue() {
    state.speechQueue = [];
    state.isSpeaking = false;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
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
  // 3. VÝPOČET ROZPISU Z BODŮ (START -> CÍL I GPX)
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
        const dirWord = cDir === 'L' ? 'Levá' : 'Pravá';
        pacenotes.push({
          id: pacenotes.length + 1,
          type: 'corner',
          dir: cDir,
          severity: sev,
          is_hairpin: sev === 1,
          distance_m: Math.round(startS),
          end_distance_m: Math.round(endS),
          radius_m: minR,
          lat: apex.lat,
          lon: apex.lon,
          short_label: `${cDir}${sev}`,
          call_cz: `${dirWord} ${sevWords[sev]}${sev === 1 ? ' vracák' : ''}`
        });
      } else {
        i++;
      }
    }

    return {
      id: 'route_' + Date.now(),
      name: stageName,
      total_length_m: Math.round(totalS),
      total_length_km: (totalS / 1000).toFixed(2),
      corners_count: pacenotes.length,
      pacenotes,
      geometry: pts
    };
  }

  // =========================================================================
  // 4. NAŠEPTÁVAČ LOKACÍ (PHOTON API) & VÝPOČET TRASY START -> CÍL (OSRM)
  // =========================================================================
  async function searchPlaceSuggestions(query) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=16&lat=49.8&lon=15.5`;
    const resp = await fetch(url);
    const data = await resp.json();
    const features = data.features || [];

    const priorityTypes = { city: 5, town: 4, village: 3, suburb: 3, cadastral_community: 3, residential: 2, road: 2 };
    const seen = new Set();
    const results = [];

    for (const f of features) {
      const p = f.properties || {};
      const coords = f.geometry && f.geometry.coordinates;
      if (!p.name || !coords) continue;

      const country = (p.countrycode || '').toUpperCase();
      const subParts = [p.street, p.city, p.county, p.state].filter(Boolean);
      const uniqueSub = [...new Set(subParts)].filter((s) => s !== p.name).slice(0, 2).join(', ');
      const dedupeKey = `${p.name.toLowerCase()}|${uniqueSub.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const isCzSk = country === 'CZ' || country === 'SK';
      const typeScore = priorityTypes[p.osm_value] || 1;
      const prefixMatch = p.name.toLowerCase().startsWith(query.toLowerCase()) ? 3 : 0;

      results.push({
        label: p.name,
        sub: uniqueSub || p.country || '',
        lat: coords[1],
        lon: coords[0],
        score: (isCzSk ? 10 : 0) + typeScore + prefixMatch
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 6);
  }

  function setupAutocomplete(inputEl, listEl, onSelect) {
    let debounceTimer = null;

    inputEl.addEventListener('input', () => {
      onSelect(null); // Jakmile uživatel upraví text, zrušíme starý výběr
      const q = inputEl.value.trim();
      clearTimeout(debounceTimer);
      if (q.length < 2) {
        listEl.classList.add('hidden');
        listEl.innerHTML = '';
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const items = await searchPlaceSuggestions(q);
          listEl.innerHTML = '';
          if (!items.length) {
            listEl.classList.add('hidden');
            return;
          }
          for (const item of items) {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `<span class="sugg-main">${escapeHtml(item.label)}</span><span class="sugg-sub">${escapeHtml(item.sub)}</span>`;
            div.addEventListener('pointerdown', (e) => {
              e.preventDefault();
              inputEl.value = item.sub ? `${item.label}, ${item.sub}` : item.label;
              onSelect(item);
              listEl.classList.add('hidden');
            });
            listEl.appendChild(div);
          }
          listEl.classList.remove('hidden');
        } catch (_) {
          listEl.classList.add('hidden');
        }
      }, 250);
    });

    inputEl.addEventListener('blur', () => {
      setTimeout(() => listEl.classList.add('hidden'), 180);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  async function calculateStartEndRoute() {
    const startTxt = el.inputStart.value.trim();
    const endTxt = el.inputEnd.value.trim();
    if (!startTxt || !endTxt) {
      el.routeSearchStatus.textContent = 'Vyber prosím Start i Cíl.';
      return;
    }

    el.routeSearchStatus.textContent = 'Počítám trasu a rally rozpis...';
    el.btnCalculateRoute.disabled = true;

    try {
      let startObj = state.selectedStart;
      if (!startObj) {
        const res = await searchPlaceSuggestions(startTxt);
        if (!res.length) throw new Error(`Start „${startTxt}“ nenalezen.`);
        startObj = res[0];
      }

      let endObj = state.selectedEnd;
      if (!endObj) {
        const res = await searchPlaceSuggestions(endTxt);
        if (!res.length) throw new Error(`Cíl „${endTxt}“ nenalezen.`);
        endObj = res[0];
      }

      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startObj.lon},${startObj.lat};${endObj.lon},${endObj.lat}?overview=full&geometries=geojson`;
      const resp = await fetch(osrmUrl);
      const data = await resp.json();
      if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
        throw new Error('Nepodařilo se najít silniční trasu.');
      }

      const rawPts = data.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon, ele: 300 }));
      const newStage = buildStageFromPoints(rawPts, `${startObj.label} → ${endObj.label}`);

      state.stages.unshift(newStage);
      populateStageSelect();
      selectStage(newStage.id);
      el.routeSearchStatus.textContent = '';
      el.routeModal.classList.add('hidden');
      queueSpeech(`Trasa ${startObj.label} do ${endObj.label} připravena.`, 4, true);
    } catch (err) {
      el.routeSearchStatus.textContent = 'Chyba: ' + err.message;
    } finally {
      el.btnCalculateRoute.disabled = false;
    }
  }

  // =========================================================================
  // 5. OTÁČEJÍCÍ SE NAVIGAČNÍ MAPA (2 VRSTVY: OSM TILES + BAREVNÁ TRASA)
  // =========================================================================
  function latLonToWorldPx(lat, lon, zoom) {
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * scale;
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return [x, y];
  }

  function getOsmTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (state.tileCache.has(key)) return state.tileCache.get(key);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
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

    const pAhead = geom[Math.min(geom.length - 1, idx + 3)];
    const dLon = (pAhead.lon - p0.lon) * Math.cos((lat * Math.PI) / 180);
    const dLat = pAhead.lat - p0.lat;
    let heading = state.currentHeadingRad;
    if (Math.abs(dLon) > 1e-7 || Math.abs(dLat) > 1e-7) {
      const targetHeading = Math.atan2(dLon, dLat);
      let diff = targetHeading - state.currentHeadingRad;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      heading = state.currentHeadingRad + diff * 0.28;
      state.currentHeadingRad = heading;
    }
    return { lat, lon, heading };
  }

  function resizeCanvases() {
    const rect = el.trackCanvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (el.trackCanvas.width !== w || el.trackCanvas.height !== h) {
      el.trackCanvas.width = w;
      el.trackCanvas.height = h;
      el.mapBgCanvas.width = w;
      el.mapBgCanvas.height = h;
    }
  }

  function drawRotatingNavMap() {
    resizeCanvases();
    const w = el.trackCanvas.width;
    const h = el.trackCanvas.height;

    const bgCtx = el.mapBgCanvas.getContext('2d');
    const fgCtx = el.trackCanvas.getContext('2d');
    bgCtx.clearRect(0, 0, w, h);
    fgCtx.clearRect(0, 0, w, h);

    // Zjištění pozice a kurzu (z trasy nebo ze živé GPS)
    let car = null;
    const geom = state.currentStage ? state.currentStage.geometry : [];
    if (geom.length) {
      car = interpolateCarPosAndHeading(geom, state.distanceM);
      // V reálném GPS režimu s živým headingem použijeme hladký kurs z GPS pokud se auto hýbe
      if (!state.demoMode && state.liveGpsPos && state.liveGpsPos.heading !== null && state.currentSpeedKmh > 6) {
        car.heading = (state.liveGpsPos.heading * Math.PI) / 180;
        state.currentHeadingRad = car.heading;
      }
    } else if (state.liveGpsPos) {
      car = { lat: state.liveGpsPos.lat, lon: state.liveGpsPos.lon, heading: state.currentHeadingRad };
    }
    if (!car) return;

    const anchorX = w * 0.5;
    const anchorY = h * 0.68;
    const [carWx, carWy] = latLonToWorldPx(car.lat, car.lon, MAP_ZOOM);

    // 1. SPODNÍ VRSTVA: OpenStreetMap dlaždice otočené podle směru jízdy
    bgCtx.save();
    bgCtx.fillStyle = '#e8e8e8'; // Po invert filtru je to příjemná tmavá silniční šedá
    bgCtx.fillRect(0, 0, w, h);
    bgCtx.translate(anchorX, anchorY);
    bgCtx.rotate(-car.heading);

    const maxTiles = Math.pow(2, MAP_ZOOM);
    const centerTx = Math.floor(carWx / TILE_SIZE);
    const centerTy = Math.floor(carWy / TILE_SIZE);
    const tileRange = 3; // Pokryje spolehlivě i rohy při otáčení na velkém displeji

    for (let dx = -tileRange; dx <= tileRange; dx++) {
      for (let dy = -tileRange; dy <= tileRange; dy++) {
        const tx = ((centerTx + dx) % maxTiles + maxTiles) % maxTiles;
        const ty = centerTy + dy;
        if (ty < 0 || ty >= maxTiles) continue;
        const img = getOsmTile(MAP_ZOOM, tx, ty);
        if (img.complete && img.naturalWidth > 0) {
          bgCtx.drawImage(img, tx * TILE_SIZE - carWx, ty * TILE_SIZE - carWy, TILE_SIZE, TILE_SIZE);
        }
      }
    }
    bgCtx.restore();

    // 2. HORNÍ VRSTVA: Zářivě barevná rally trasa + šipka řidiče
    if (geom.length) {
      fgCtx.save();
      fgCtx.translate(anchorX, anchorY);
      fgCtx.rotate(-car.heading);
      fgCtx.lineCap = 'round';
      fgCtx.lineJoin = 'round';

      // Tmavý obrys trasy pro perfektní kontrast nad mapou
      fgCtx.beginPath();
      for (let i = 0; i < geom.length; i++) {
        const [wx, wy] = latLonToWorldPx(geom[i].lat, geom[i].lon, MAP_ZOOM);
        if (i === 0) fgCtx.moveTo(wx - carWx, wy - carWy);
        else fgCtx.lineTo(wx - carWx, wy - carWy);
      }
      fgCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      fgCtx.lineWidth = 14;
      fgCtx.stroke();

      // Barevné segmenty podle ostrosti zatáček
      for (let i = 1; i < geom.length; i++) {
        const p0 = geom[i - 1];
        const p1 = geom[i];
        const [wx0, wy0] = latLonToWorldPx(p0.lat, p0.lon, MAP_ZOOM);
        const [wx1, wy1] = latLonToWorldPx(p1.lat, p1.lon, MAP_ZOOM);

        fgCtx.beginPath();
        fgCtx.moveTo(wx0 - carWx, wy0 - carWy);
        fgCtx.lineTo(wx1 - carWx, wy1 - carWy);

        if (p1.s <= state.distanceM) {
          fgCtx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
          fgCtx.lineWidth = 8;
        } else if (p1.r < 38) {
          fgCtx.strokeStyle = '#ff2e2e';
          fgCtx.lineWidth = 10;
        } else if (p1.r < 95) {
          fgCtx.strokeStyle = '#ffd000';
          fgCtx.lineWidth = 9;
        } else {
          fgCtx.strokeStyle = '#00e676';
          fgCtx.lineWidth = 8;
        }
        fgCtx.stroke();
      }
      fgCtx.restore();
    }

    // 3. Navigační šipka auta (vždy míří nahoru)
    fgCtx.save();
    fgCtx.translate(anchorX, anchorY);
    fgCtx.beginPath();
    fgCtx.arc(0, 0, 22, 0, Math.PI * 2);
    fgCtx.fillStyle = 'rgba(0, 229, 255, 0.25)';
    fgCtx.fill();

    fgCtx.beginPath();
    fgCtx.moveTo(0, -16);
    fgCtx.lineTo(13, 13);
    fgCtx.lineTo(0, 7);
    fgCtx.lineTo(-13, 13);
    fgCtx.closePath();
    fgCtx.fillStyle = '#00e5ff';
    fgCtx.fill();
    fgCtx.lineWidth = 2.5;
    fgCtx.strokeStyle = '#ffffff';
    fgCtx.stroke();
    fgCtx.restore();
  }

  // =========================================================================
  // 6. RALLY CO-DRIVER ENGINE (ODPOČET ROVINEK + O 1 POKYN NAPŘED)
  // =========================================================================
  function getActiveSpeedKmh() {
    if (state.demoMode) return state.demoSpeedKmh;
    return Math.max(30.0, state.currentSpeedKmh);
  }

  function getDynamicLeadDistanceM() {
    return Math.max(35.0, (getActiveSpeedKmh() / 3.6) * state.leadTimeSec);
  }

  function updateLeadTimeLabel() {
    const leadM = Math.round(getDynamicLeadDistanceM());
    el.leadTimeLabel.textContent = `${state.leadTimeSec.toFixed(1)} s (${leadM} m)`;
  }

  function roundDisplayDist(m) {
    if (m < 50) return Math.max(10, Math.round(m / 5) * 5);
    if (m < 200) return Math.round(m / 10) * 10;
    return Math.round(m / 20) * 20;
  }

  function formatCornerPreview(corner, prevCornerEndS) {
    if (!corner) return { code: 'CÍL', text: 'Konec trasy' };
    const gap = Math.round((corner.distance_m - prevCornerEndS) / 10) * 10;
    const prefix = gap >= 40 ? `${gap} m → ` : '';
    return { code: corner.short_label, text: `${prefix}${corner.call_cz}` };
  }

  function evaluatePacenotesAtDistance(distM) {
    if (!state.currentStage) return;
    const corners = state.corners;
    const leadM = getDynamicLeadDistanceM();

    const idx = corners.findIndex((c) => c.end_distance_m >= distM);
    if (idx === -1) {
      if (state.isRunning) finishStage();
      return;
    }

    const nextCorner = corners[idx];
    const cornerAfter = corners[idx + 1] || null;
    const cornerThird = corners[idx + 2] || null;
    const remToCorner = Math.max(0, nextCorner.distance_m - distM);

    // Zda jsme ještě na rovince před zónou předstihu pro nadcházející zatáčku
    const onStraightApproach = remToCorner > leadM && remToCorner >= 60;

    if (onStraightApproach) {
      // --- HLAVNÍ POKYN: ŽIVÝ ODPOČET ROVINKY (např. 680 -> 300 -> 200 -> 100) ---
      const roundedNow = roundDisplayDist(remToCorner);
      el.primaryCallCard.className = 'hud-banner sev-0';
      el.cornerArrowPath.setAttribute('d', getCornerSvgPath('S', 0));
      el.cornerShortCode.textContent = `↑ ${roundedNow} m`;
      el.callDistanceCountdown.textContent = `ROVINKA`;
      el.callCzechText.textContent = `DÁLE ${roundedNow} METRŮ`;
      el.cornerModBadges.innerHTML = '';

      // Na řádku DALŠÍ je pořád vidět ta nadcházející zatáčka!
      el.nextCornerCode.textContent = nextCorner.short_label;
      el.nextCornerText.textContent = `${nextCorner.call_cz} (za ${Math.round(remToCorner)} m)`;

      // O 1 pokyn napřed: zatáčka ZA ní!
      const pAfter = formatCornerPreview(cornerAfter, nextCorner.end_distance_m);
      el.afterCornerCode.textContent = pAfter.code;
      el.afterCornerText.textContent = pAfter.text;

      // Hlasové hlášení začátku dlouhé rovinky + průběžné milníky ("300", "200", "100")
      if (state.isRunning) {
        if (state.lastStraightAnnouncedFor !== nextCorner.id) {
          state.lastStraightAnnouncedFor = nextCorner.id;
          // Oznámíme začátek rovinky a rovnou zmíníme i co bude na konci, pokud je < 350 m
          if (roundedNow >= 80) {
            queueSpeech(`Dále ${roundedNow}`, 0, false);
          }
          // Aby hned na začátku neřeklo stejný milník dvakrát
          for (const m of STRAIGHT_MILESTONES) {
            if (m >= remToCorner - 45) {
              state.spokenMilestones.add(`${nextCorner.id}_${m}`);
            }
          }
        } else {
          // Průběžný odpočet na milnících 500, 400, 300, 200, 100 m
          for (const m of STRAIGHT_MILESTONES) {
            const key = `${nextCorner.id}_${m}`;
            if (remToCorner <= m + 12 && remToCorner > leadM + 20 && !state.spokenMilestones.has(key)) {
              state.spokenMilestones.add(key);
              queueSpeech(`${m}`, 0, false);
              break;
            }
          }
        }
      }
    } else {
      // --- HLAVNÍ POKYN: NADCHÁZEJÍCÍ ZATÁČKA (V ZÓNĚ PŘEDSTIHU) ---
      el.primaryCallCard.className = `hud-banner sev-${nextCorner.severity || 3}`;
      el.cornerArrowPath.setAttribute('d', getCornerSvgPath(nextCorner.dir, nextCorner.severity));
      el.cornerShortCode.textContent = nextCorner.short_label;
      el.callDistanceCountdown.textContent = remToCorner > 5 ? `ZA ${Math.round(remToCorner)} m` : 'V ZATÁČCE';
      el.callCzechText.textContent = nextCorner.call_cz;

      el.cornerModBadges.innerHTML = '';
      if (nextCorner.is_hairpin) addBadge('VRACÁK', 'danger');
      if (nextCorner.modifier === 'utahuje') addBadge('UTAHUJE', 'danger');
      if (nextCorner.has_crest) addBadge('HORIZONT', 'warn');

      // Řádek DALŠÍ = příští zatáčka po této
      const pNext = formatCornerPreview(cornerAfter, nextCorner.end_distance_m);
      el.nextCornerCode.textContent = pNext.code;
      el.nextCornerText.textContent = pNext.text;

      // Řádek POTOM = ještě o 1 pokyn napřed
      if (cornerAfter) {
        const pThird = formatCornerPreview(cornerThird, cornerAfter.end_distance_m);
        el.afterCornerCode.textContent = pThird.code;
        el.afterCornerText.textContent = pThird.text;
      } else {
        el.afterCornerCode.textContent = '--';
        el.afterCornerText.textContent = '--';
      }

      // HLASOVÉ PŘEČTENÍ NADCHÁZEJÍCÍ ZATÁČKY (VŽDY S PRIORITOU!)
      if (state.isRunning && !state.spokenCornerIds.has(nextCorner.id)) {
        state.spokenCornerIds.add(nextCorner.id);
        let speechText = nextCorner.call_cz;

        // Pokud těsně za ní (do 45 m) následuje další zatáčka, spojíme ji do jednoho plynulého hlášení
        if (cornerAfter && (cornerAfter.distance_m - nextCorner.end_distance_m) <= 45) {
          state.spokenCornerIds.add(cornerAfter.id);
          const cleanFirst = speechText.replace(/\s+do$/i, '');
          speechText = `${cleanFirst}, do ${cornerAfter.call_cz}`;
        }
        queueSpeech(speechText, nextCorner.severity || 3, true);
      }

      // Pokud se mezitím i další zatáčka dostala do zóny předstihu, přečteme i ji
      if (state.isRunning && cornerAfter && (cornerAfter.distance_m - distM) <= leadM * 0.65 && !state.spokenCornerIds.has(cornerAfter.id)) {
        state.spokenCornerIds.add(cornerAfter.id);
        queueSpeech(cornerAfter.call_cz, cornerAfter.severity || 3, true);
      }
    }

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
  // 7. REŽIMY: REÁLNÁ GPS (HLAVNÍ) vs DEMO SIMULACE (V NASTAVENÍ)
  // =========================================================================
  function applyNavigationMode(isDemo) {
    pauseStage();
    stopGpsWatch();
    state.demoMode = isDemo;

    if (isDemo) {
      el.gpsStatusBadge.textContent = 'DEMO';
      el.gpsStatusBadge.className = 'badge badge-sim';
      el.modeStatusText.textContent = 'Demo simulace';
      el.btnModeGps.classList.remove('active');
      el.btnModeDemo.classList.add('active', 'demo-active');
      el.demoSpeedSection.classList.remove('hidden');
      state.currentSpeedKmh = state.demoSpeedKmh;
      el.speedValue.textContent = Math.round(state.demoSpeedKmh);
    } else {
      el.gpsStatusBadge.textContent = state.gpsHasFix ? 'GPS OK' : 'GPS';
      el.gpsStatusBadge.className = state.gpsHasFix ? 'badge badge-gps' : 'badge badge-wait';
      el.modeStatusText.textContent = 'Reálná GPS';
      el.btnModeGps.classList.add('active');
      el.btnModeDemo.classList.remove('active', 'demo-active');
      el.demoSpeedSection.classList.add('hidden');
      state.currentSpeedKmh = 0;
      el.speedValue.textContent = '0';
    }
    updateLeadTimeLabel();
    drawRotatingNavMap();
  }

  function startGpsWatch() {
    if (!('geolocation' in navigator)) {
      alert('Tento prohlížeč nepodporuje GPS. V nastavení (⚙️) můžeš zapnout Demo simulaci.');
      pauseStage();
      return;
    }

    el.gpsStatusBadge.textContent = 'HLEDÁM GPS';
    el.gpsStatusBadge.className = 'badge badge-wait';

    state.gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed, heading } = pos.coords;
        state.gpsHasFix = true;
        state.liveGpsPos = { lat: latitude, lon: longitude, heading: typeof heading === 'number' && !isNaN(heading) ? heading : null };

        el.gpsStatusBadge.textContent = 'GPS OK';
        el.gpsStatusBadge.className = 'badge badge-gps';

        const kmh = typeof speed === 'number' && !isNaN(speed) && speed >= 0 ? Math.round(speed * 3.6) : 0;
        state.currentSpeedKmh = kmh;
        el.speedValue.textContent = kmh;
        updateLeadTimeLabel();

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
          if (deltaM < 250) { // Ochrana proti skoku GPS
            state.distanceM = bestPt.s;
            addDrivenMeters(deltaM);
          } else if (state.distanceM === 0) {
            state.distanceM = bestPt.s;
          }
          evaluatePacenotesAtDistance(state.distanceM);
        }
        drawRotatingNavMap();
      },
      (err) => {
        el.gpsStatusBadge.textContent = 'GPS CHYBA';
        el.gpsStatusBadge.className = 'badge badge-wait';
        console.warn('GPS error:', err.message);
      },
      { enableHighAccuracy: true, maximumAge: 300, timeout: 10000 }
    );
  }

  function stopGpsWatch() {
    if (state.gpsWatchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
    }
    state.gpsWatchId = null;
  }

  function tickDemoSimulation(timestamp) {
    if (!state.isRunning || !state.demoMode) return;
    if (!state.lastTickTime) state.lastTickTime = timestamp;
    const dtSec = Math.min(0.25, (timestamp - state.lastTickTime) / 1000.0);
    state.lastTickTime = timestamp;

    const deltaM = (state.demoSpeedKmh / 3.6) * dtSec;
    state.distanceM += deltaM;
    addDrivenMeters(deltaM);

    evaluatePacenotesAtDistance(state.distanceM);
    drawRotatingNavMap();
    if (state.isRunning) requestAnimationFrame(tickDemoSimulation);
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

    if (state.distanceM < 5 && state.spokenCornerIds.size === 0) {
      queueSpeech('Start navigace', 4, false);
    }

    if (state.demoMode) {
      requestAnimationFrame(tickDemoSimulation);
    } else {
      startGpsWatch();
    }
  }

  function pauseStage() {
    state.isRunning = false;
    state.lastTickTime = null;
    stopGpsWatch();
    el.btnStartPause.textContent = '▶ START';
    el.btnStartPause.classList.remove('running');
  }

  function resetStage() {
    pauseStage();
    clearSpeechQueue();
    state.distanceM = 0.0;
    state.spokenCornerIds.clear();
    state.spokenMilestones.clear();
    state.lastStraightAnnouncedFor = null;
    evaluatePacenotesAtDistance(0);
    drawRotatingNavMap();
  }

  function finishStage() {
    pauseStage();
    el.btnStartPause.textContent = '🏁 ZNOVU';
    el.cornerShortCode.textContent = 'CÍL';
    el.callCzechText.textContent = 'DORAZIL JSI DO CÍLE!';
    el.nextCornerCode.textContent = '🏁';
    el.nextCornerText.textContent = 'Konec trasy';
    el.afterCornerCode.textContent = '--';
    el.afterCornerText.textContent = '--';
    queueSpeech('Cíl trasy', 5, true);
  }

  // =========================================================================
  // 8. FREEMIUM, GPX & INICIALIZACE
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
    state.corners = (found.pacenotes || []).filter((n) => n.type === 'corner');
    el.stageSelect.value = found.id;
    el.activeRouteName.textContent = found.name;
    resetStage();
  }

  function init() {
    populateStageSelect();
    if (state.stages.length > 0) selectStage(state.stages[0].id);
    applyNavigationMode(false); // Hlavní výchozí režim = Reálná GPS
    updateFreemiumUi();
    updateLeadTimeLabel();

    window.addEventListener('resize', drawRotatingNavMap);

    // Našeptávač pro Start a Cíl
    setupAutocomplete(el.inputStart, el.startSuggestions, (item) => { state.selectedStart = item; });
    setupAutocomplete(el.inputEnd, el.endSuggestions, (item) => { state.selectedEnd = item; });

    el.btnStartPause.addEventListener('click', () => (state.isRunning ? pauseStage() : startStage()));
    el.btnAudioToggle.addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      el.btnAudioToggle.textContent = state.audioEnabled ? '🔊' : '🔇';
      if (!state.audioEnabled) clearSpeechQueue();
    });

    // Route modal
    el.btnOpenRoute.addEventListener('click', () => el.routeModal.classList.remove('hidden'));
    el.btnCloseRoute.addEventListener('click', () => el.routeModal.classList.add('hidden'));
    el.btnCalculateRoute.addEventListener('click', calculateStartEndRoute);
    el.btnUseMyLocation.addEventListener('click', () => {
      if (!('geolocation' in navigator)) return;
      el.routeSearchStatus.textContent = 'Zjišťuji polohu...';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.selectedStart = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Moje poloha' };
          el.inputStart.value = '📍 Moje aktuální poloha';
          el.startSuggestions.classList.add('hidden');
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

    // Settings modal (přepínač Reálná GPS / Demo simulace + předstih 2–15 s)
    el.btnOpenSettings.addEventListener('click', () => el.settingsModal.classList.remove('hidden'));
    el.btnCloseSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    el.btnModeGps.addEventListener('click', () => applyNavigationMode(false));
    el.btnModeDemo.addEventListener('click', () => applyNavigationMode(true));

    el.btnReset.addEventListener('click', () => { resetStage(); el.settingsModal.classList.add('hidden'); });
    el.btnTestVoice.addEventListener('click', () => {
      ensureAudioContext();
      queueSpeech('Dvě stě, Pravá tři utahuje přes horizont', 2, true);
    });
    el.speedSlider.addEventListener('input', (e) => {
      state.demoSpeedKmh = parseFloat(e.target.value);
      if (state.demoMode) {
        state.currentSpeedKmh = state.demoSpeedKmh;
        el.speedValue.textContent = Math.round(state.demoSpeedKmh);
      }
      el.speedSliderLabel.textContent = `${state.demoSpeedKmh} km/h`;
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
