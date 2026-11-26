/**
 * ApexNotes – Rally Navigace (PWA v4)
 * - Volný pohyb mapy (pan) + 2-prstý pinch-zoom / kolečko myši + tlačítko Re-center (jen když odcentrováno)
 * - Otáčení šipky i mapy podle orientace/kompasu mobilu (iPhone webkitCompassHeading / Android deviceorientation)
 * - Výpočet času trasy z OSRM API (náhled při výběru + zbývající čas na mapě)
 * - Automatické nastavení aktuální GPS polohy uživatele jako Start při spuštění trasy
 * - Historie nedávných míst v našeptávači hned po rozkliknutí inputu + živý Photon autocomplete
 * - Opravený výpočet zatáček (převzorkování po 4 m + celkový úhel zatočení -> 90° je stupeň 2, vracák až od 130°+)
 */

(function () {
  'use strict';

  const FREE_KM_LIMIT = 40.0;
  const EARTH_R = 6371000.0;
  const TILE_SIZE = 256;
  const MIN_ZOOM = 12.0;
  const MAX_ZOOM = 18.5;
  const HISTORY_KEY = 'apexnotes_place_history';
  const STRAIGHT_MILESTONES = [1000, 800, 600, 500, 400, 300, 200, 150, 100];

  const state = {
    stages: window.APEXNOTES_STAGES || [],
    currentStage: null,
    corners: [],
    demoMode: false,           // Výchozí = Reálná GPS
    isRunning: false,
    gpsWatchId: null,
    gpsHasFix: false,
    liveGpsPos: null,          // { lat, lon, heading }
    deviceHeadingRad: null,    // Kompas telefonu (0 = Sever, +PI/2 = Východ)
    compassListening: false,
    // Kamera & interaktivní mapa
    mapZoom: 16.0,
    isCentered: true,
    cameraLat: 49.2163,
    cameraLon: 17.7492,
    cameraRotationRad: 0.0,
    // Audio & telemetrie
    audioEnabled: true,
    distanceM: 0.0,
    demoSpeedKmh: 90.0,
    currentSpeedKmh: 0.0,
    leadTimeSec: 5.0,
    routeHeadingRad: 0.0,
    // Výběr Start -> Cíl & historie
    selectedStart: null,       // { lat, lon, label, isGps?: true }
    selectedEnd: null,         // { lat, lon, label }
    previewRouteData: null,    // Cache předpočítané OSRM trasy pro náhled
    placeHistory: loadPlaceHistory(),
    // Hlášky
    spokenCornerIds: new Set(),
    spokenMilestones: new Set(),
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
    mapViewport: document.getElementById('mapViewport'),
    mapBgCanvas: document.getElementById('mapBgCanvas'),
    trackCanvas: document.getElementById('trackCanvas'),
    btnRecenter: document.getElementById('btnRecenter'),
    speedValue: document.getElementById('speedValue'),
    stageProgressText: document.getElementById('stageProgressText'),
    stageEtaText: document.getElementById('stageEtaText'),
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
    routePreviewCard: document.getElementById('routePreviewCard'),
    previewDist: document.getElementById('previewDist'),
    previewTime: document.getElementById('previewTime'),
    previewCorners: document.getElementById('previewCorners'),
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
    btnEnableCompass: document.getElementById('btnEnableCompass'),
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
  // 1. HISTORIE MÍST (localStorage)
  // =========================================================================
  function loadPlaceHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (_) {
      return [];
    }
  }

  function savePlaceToHistory(place) {
    if (!place || !place.label || place.isGps) return;
    const cleaned = state.placeHistory.filter(
      (p) => p.label.toLowerCase() !== place.label.toLowerCase() || (p.sub || '') !== (place.sub || '')
    );
    cleaned.unshift({ label: place.label, sub: place.sub || '', lat: place.lat, lon: place.lon });
    state.placeHistory = cleaned.slice(0, 8);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.placeHistory));
  }

  // =========================================================================
  // 2. KOMPAS MOBILU (OTÁČENÍ ŠIPKY A MAPY PODLE TELEFONU – iOS & ANDROID)
  // =========================================================================
  function handleOrientationEvent(e) {
    let headingDeg = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      // iPhone / iOS Safari – přesný kompasový azimut (0 = Sever)
      headingDeg = e.webkitCompassHeading;
    } else if (typeof e.alpha === 'number' && !isNaN(e.alpha)) {
      // Android / standardní prohlížeč
      headingDeg = (360 - e.alpha) % 360;
    }
    if (headingDeg === null) return;

    const targetRad = (headingDeg * Math.PI) / 180;
    if (state.deviceHeadingRad === null) {
      state.deviceHeadingRad = targetRad;
    } else {
      // Plynulé vyhlazení kompasu, aby šipka netřepala
      let diff = targetRad - state.deviceHeadingRad;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      state.deviceHeadingRad += diff * 0.25;
    }
    if (!state.isRunning) drawInteractiveMap();
  }

  function attachCompassListeners() {
    if (state.compassListening) return;
    state.compassListening = true;
    window.addEventListener('deviceorientationabsolute', handleOrientationEvent, true);
    window.addEventListener('deviceorientation', handleOrientationEvent, true);
  }

  async function requestCompassPermissionIfNeeded() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res === 'granted') {
          attachCompassListeners();
          if (el.btnEnableCompass) el.btnEnableCompass.textContent = '🧭 Kompas telefonu je aktivní ✓';
        }
      } else {
        attachCompassListeners();
      }
    } catch (_) {
      // Uživatel odmítl nebo prohlížeč nevyžaduje permission
    }
  }

  // =========================================================================
  // 3. CHYTRÁ FRONTA HLASU (ČESKÝ SPOLUJEZDEC)
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
    if (isPriorityCorner) {
      state.speechQueue = state.speechQueue.filter((item) => item.isPriorityCorner);
    }
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

    setTimeout(() => {
      if (state.isSpeaking && !window.speechSynthesis.speaking) finish();
    }, 3500);

    window.speechSynthesis.speak(utter);
  }

  function clearSpeechQueue() {
    state.speechQueue = [];
    state.isSpeaking = false;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  // =========================================================================
  // 4. ŠIPKY ZATÁČEK
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
  // 5. OPRAVENÝ GEOMETRICKÝ ALGORITMUS V JS (90° ZATÁČKA NENÍ VRACÁK!)
  // =========================================================================
  function computeTurnAngleDeg(cPts) {
    if (cPts.length < 3) return 0;
    let totalRad = 0;
    for (let i = 1; i < cPts.length - 1; i++) {
      const v1x = cPts[i].x - cPts[i - 1].x;
      const v1y = cPts[i].y - cPts[i - 1].y;
      const v2x = cPts[i + 1].x - cPts[i].x;
      const v2y = cPts[i + 1].y - cPts[i].y;
      if ((v1x * v1x + v1y * v1y) > 1e-4 && (v2x * v2x + v2y * v2y) > 1e-4) {
        totalRad += Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
      }
    }
    return Math.abs((totalRad * 180) / Math.PI);
  }

  function classifyCorner(effR, turnAngleDeg) {
    if (effR > 245 || turnAngleDeg < 14) return { sev: 0, isHairpin: false };
    // Skutečný vracák = obrat o >= 130° zpět s malým poloměrem
    if (turnAngleDeg >= 130 && effR < 34) return { sev: 1, isHairpin: true };
    // Velmi ostrá nad 118° bez vracáku
    if (turnAngleDeg >= 118 && effR < 18) return { sev: 1, isHairpin: false };

    // Běžná 90° zatáčka (70°–125°) spadne do stupně 2 (Pravá dva / Levá dva), NIKOLIV vracák!
    let sev = effR < 40 ? 2 : effR < 70 ? 3 : effR < 110 ? 4 : effR < 170 ? 5 : 6;
    if (turnAngleDeg < 28) sev = Math.max(sev, 5);
    else if (turnAngleDeg < 48) sev = Math.max(sev, 4);
    else if (turnAngleDeg < 70) sev = Math.max(sev, 3);

    return { sev, isHairpin: false };
  }

  function buildStageFromPoints(rawLatLonEle, stageName, durationSec = null, endCoord = null) {
    const lat0 = (rawLatLonEle[0].lat * Math.PI) / 180;
    const lon0 = (rawLatLonEle[0].lon * Math.PI) / 180;
    const cosLat0 = Math.cos(lat0);

    // 1. Převod do lokálních metrů
    const local = [];
    for (const p of rawLatLonEle) {
      const x = (((p.lon * Math.PI) / 180) - lon0) * cosLat0 * EARTH_R;
      const y = (((p.lat * Math.PI) / 180) - lat0) * EARTH_R;
      if (local.length && Math.hypot(x - local[local.length - 1].x, y - local[local.length - 1].y) < 0.5) continue;
      local.push({ lat: p.lat, lon: p.lon, ele: p.ele || 300, x, y });
    }

    // 2. Rovnoměrné převzorkování po 4 metrech (eliminuje špičaté uzly OSRM na 90° křižovatkách)
    const stepM = 4.0;
    const resampled = [{ ...local[0], s: 0 }];
    let accum = 0;
    let nextTarget = stepM;

    for (let i = 1; i < local.length; i++) {
      const p0 = local[i - 1], p1 = local[i];
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-5) continue;
      while (accum + d >= nextTarget) {
        const t = (nextTarget - accum) / d;
        resampled.push({
          lat: p0.lat + t * (p1.lat - p0.lat),
          lon: p0.lon + t * (p1.lon - p0.lon),
          ele: p0.ele + t * (p1.ele - p0.ele),
          x: p0.x + t * dx,
          y: p0.y + t * dy,
          s: nextTarget
        });
        nextTarget += stepM;
      }
      accum += d;
    }

    // 3. Gaussovské vyhlazení
    const weights = [0.1, 0.2, 0.4, 0.2, 0.1];
    const pts = resampled.map((pt, i) => {
      let sx = 0, sy = 0, slat = 0, slon = 0;
      for (let k = -2; k <= 2; k++) {
        const idx = Math.min(resampled.length - 1, Math.max(0, i + k));
        const w = weights[k + 2];
        sx += resampled[idx].x * w;
        sy += resampled[idx].y * w;
        slat += resampled[idx].lat * w;
        slon += resampled[idx].lon * w;
      }
      return { lat: slat, lon: slon, ele: pt.ele, x: sx, y: sy, s: pt.s, r: 999, dir: 'S' };
    });

    // 4. Mengerova křivost přes okno w=3 (~12 m na každou stranu)
    const wOff = 3;
    for (let i = wOff; i < pts.length - wOff; i++) {
      const p1 = pts[i - wOff], p2 = pts[i], p3 = pts[i + wOff];
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

    // 5. Extrakce a sloučení zatáček + klasifikace pomocí (effR + turnAngleDeg)
    const rawCorners = [];
    let i = wOff;
    while (i < pts.length - wOff) {
      if (pts[i].r <= 235) {
        const cDir = pts[i].dir;
        const cPts = [];
        while (i < pts.length - wOff && pts[i].r <= 240 && pts[i].dir === cDir) {
          cPts.push(pts[i]);
          i++;
        }
        if (cPts.length >= 3 && (cPts[cPts.length - 1].s - cPts[0].s) >= 12) {
          rawCorners.push({ dir: cDir, cPts });
        }
      } else {
        i++;
      }
    }

    // Sloučení blízkých stejnosměrných zatáček (< 16 m)
    const merged = [];
    for (const rc of rawCorners) {
      if (merged.length) {
        const prev = merged[merged.length - 1];
        if (prev.dir === rc.dir && (rc.cPts[0].s - prev.cPts[prev.cPts.length - 1].s) < 16) {
          prev.cPts = prev.cPts.concat(rc.cPts);
          continue;
        }
      }
      merged.push(rc);
    }

    const sevWords = { 1: 'jedna', 2: 'dva', 3: 'tři', 4: 'čtyři', 5: 'pět', 6: 'šest' };
    const pacenotes = [];
    for (const item of merged) {
      const cPts = item.cPts;
      const sortedR = cPts.map((p) => p.r).sort((a, b) => a - b);
      const effR = sortedR[Math.floor(sortedR.length * 0.25)];
      const turnAngle = computeTurnAngleDeg(cPts);
      const { sev, isHairpin } = classifyCorner(effR, turnAngle);
      if (sev === 0) continue;

      const apex = cPts.reduce((best, p) => (p.r < best.r ? p : best), cPts[0]);
      const dirWord = item.dir === 'L' ? 'Levá' : 'Pravá';
      const lenM = cPts[cPts.length - 1].s - cPts[0].s;

      pacenotes.push({
        id: pacenotes.length + 1,
        type: 'corner',
        dir: item.dir,
        severity: sev,
        is_hairpin: isHairpin,
        is_long: lenM >= 70 && !isHairpin,
        distance_m: Math.round(cPts[0].s),
        end_distance_m: Math.round(cPts[cPts.length - 1].s),
        radius_m: effR,
        turn_angle_deg: Math.round(turnAngle),
        lat: apex.lat,
        lon: apex.lon,
        short_label: `${item.dir}${sev}${isHairpin ? '!' : ''}`,
        call_cz: `${dirWord} ${sevWords[sev]}${isHairpin ? ' vracák' : ''}`
      });
    }

    const totalS = pts.length ? pts[pts.length - 1].s : 0;
    const finalDur = durationSec != null ? Math.round(durationSec) : Math.round((totalS / 1000 / 60) * 3600);
    const destCoord = endCoord || (pts.length ? { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon, label: stageName.split('→').pop().trim() } : null);

    return {
      id: 'route_' + Date.now(),
      name: stageName,
      total_length_m: Math.round(totalS),
      total_length_km: (totalS / 1000).toFixed(2),
      duration_sec: finalDur,
      destination: destCoord,
      isCustomNavRoute: !!endCoord,
      corners_count: pacenotes.length,
      pacenotes,
      geometry: pts
    };
  }

  function formatDuration(sec) {
    if (!sec || sec <= 0) return '-- min';
    const totalMin = Math.max(1, Math.round(sec / 60));
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h} h ${m} min`;
  }

  // =========================================================================
  // 6. NAŠEPTÁVAČ + HISTORIE MÍST + ŽIVÝ VÝPOČET ČASU TRASY (PHOTON + OSRM)
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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function renderSuggestionsDropdown(listEl, items, isStartField, isHistoryMode, onPick) {
    listEl.innerHTML = '';
    const hasContent = (isStartField && isHistoryMode) || items.length > 0;
    if (!hasContent) {
      listEl.classList.add('hidden');
      return;
    }

    if (isStartField && isHistoryMode) {
      const gpsItem = document.createElement('div');
      gpsItem.className = 'suggestion-item';
      gpsItem.innerHTML = `<span class="sugg-icon">📍</span><div class="sugg-body"><span class="sugg-main">Moje aktuální poloha (GPS)</span><span class="sugg-sub">Automaticky použije tvoji polohu</span></div>`;
      gpsItem.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onPick({ isGps: true, label: 'Moje poloha', sub: '' });
        listEl.classList.add('hidden');
      });
      listEl.appendChild(gpsItem);
    }

    if (isHistoryMode && items.length > 0) {
      const hdr = document.createElement('div');
      hdr.className = 'sugg-header';
      hdr.textContent = '🕒 Nedávná místa';
      listEl.appendChild(hdr);
    }

    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'suggestion-item';
      const icon = isHistoryMode ? '🕒' : '📍';
      div.innerHTML = `<span class="sugg-icon">${icon}</span><div class="sugg-body"><span class="sugg-main">${escapeHtml(item.label)}</span><span class="sugg-sub">${escapeHtml(item.sub || '')}</span></div>`;
      div.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onPick(item);
        listEl.classList.add('hidden');
      });
      listEl.appendChild(div);
    }
    listEl.classList.remove('hidden');
  }

  function setupAutocomplete(inputEl, listEl, isStartField, onSelect) {
    let debounceTimer = null;

    const showHistory = () => {
      const q = inputEl.value.trim();
      if (q.length < 2 || q === '📍 Moje aktuální poloha') {
        renderSuggestionsDropdown(listEl, state.placeHistory, isStartField, true, (picked) => {
          if (picked.isGps) {
            setStartToCurrentGps();
          } else {
            inputEl.value = picked.sub ? `${picked.label}, ${picked.sub}` : picked.label;
            onSelect(picked);
            tryFetchRoutePreview();
          }
        });
      }
    };

    inputEl.addEventListener('focus', showHistory);
    inputEl.addEventListener('click', showHistory);

    inputEl.addEventListener('input', () => {
      onSelect(null);
      state.previewRouteData = null;
      el.routePreviewCard.classList.add('hidden');
      const q = inputEl.value.trim();
      clearTimeout(debounceTimer);

      if (q.length < 2) {
        showHistory();
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const items = await searchPlaceSuggestions(q);
          renderSuggestionsDropdown(listEl, items, isStartField, false, (picked) => {
            inputEl.value = picked.sub ? `${picked.label}, ${picked.sub}` : picked.label;
            onSelect(picked);
            tryFetchRoutePreview();
          });
        } catch (_) {
          listEl.classList.add('hidden');
        }
      }, 240);
    });

    inputEl.addEventListener('blur', () => {
      setTimeout(() => listEl.classList.add('hidden'), 180);
    });
  }

  function getCurrentGpsPromise() {
    return new Promise((resolve, reject) => {
      if (state.liveGpsPos) {
        resolve({ lat: state.liveGpsPos.lat, lon: state.liveGpsPos.lon, label: 'Moje poloha', isGps: true });
        return;
      }
      if (!('geolocation' in navigator)) {
        reject(new Error('Prohlížeč nepodporuje GPS.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.liveGpsPos = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            heading: typeof pos.coords.heading === 'number' && !isNaN(pos.coords.heading) ? pos.coords.heading : null
          };
          state.gpsHasFix = true;
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Moje poloha', isGps: true });
        },
        (err) => reject(new Error('Nelze zjistit tvoji polohu: ' + err.message)),
        { enableHighAccuracy: true, timeout: 7000 }
      );
    });
  }

  function setStartToCurrentGps() {
    el.inputStart.value = '📍 Moje aktuální poloha';
    el.routeSearchStatus.textContent = 'Zjišťuji tvoji GPS polohu...';
    getCurrentGpsPromise()
      .then((gpsObj) => {
        state.selectedStart = gpsObj;
        el.routeSearchStatus.textContent = '';
        tryFetchRoutePreview();
      })
      .catch((err) => {
        el.routeSearchStatus.textContent = err.message;
      });
  }

  async function fetchOsrmStage(startObj, endObj) {
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startObj.lon},${startObj.lat};${endObj.lon},${endObj.lat}?overview=full&geometries=geojson`;
    const resp = await fetch(osrmUrl);
    const data = await resp.json();
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error('Nepodařilo se najít silniční trasu.');
    }
    const route = data.routes[0];
    const rawPts = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon, ele: 300 }));
    return buildStageFromPoints(rawPts, `${startObj.label} → ${endObj.label}`, route.duration, endObj);
  }

  // Živý výpočet vzdálenosti a času hned jak vybereš Start i Cíl v modalu
  async function tryFetchRoutePreview() {
    if (!state.selectedStart || !state.selectedEnd) return;
    el.routeSearchStatus.textContent = 'Počítám délku a čas trasy...';
    try {
      const stage = await fetchOsrmStage(state.selectedStart, state.selectedEnd);
      state.previewRouteData = stage;
      el.previewDist.textContent = `📏 ${stage.total_length_km} km`;
      el.previewTime.textContent = `⏱️ ${formatDuration(stage.duration_sec)}`;
      el.previewCorners.textContent = `↩️ ${stage.corners_count} zat.`;
      el.routePreviewCard.classList.remove('hidden');
      el.routeSearchStatus.textContent = '';
    } catch (err) {
      el.routeSearchStatus.textContent = err.message;
    }
  }

  async function calculateStartEndRoute() {
    const startTxt = el.inputStart.value.trim();
    const endTxt = el.inputEnd.value.trim();
    if (!endTxt) {
      el.routeSearchStatus.textContent = 'Vyber prosím Cíl trasy.';
      return;
    }

    el.routeSearchStatus.textContent = 'Počítám trasu, čas a rally rozpis...';
    el.btnCalculateRoute.disabled = true;

    try {
      let startObj = state.selectedStart;
      if (!startObj) {
        if (!startTxt || startTxt === '📍 Moje aktuální poloha') {
          startObj = await getCurrentGpsPromise();
        } else {
          const res = await searchPlaceSuggestions(startTxt);
          if (!res.length) throw new Error(`Start „${startTxt}“ nenalezen.`);
          startObj = res[0];
        }
        state.selectedStart = startObj;
      }

      let endObj = state.selectedEnd;
      if (!endObj) {
        const res = await searchPlaceSuggestions(endTxt);
        if (!res.length) throw new Error(`Cíl „${endTxt}“ nenalezen.`);
        endObj = res[0];
        state.selectedEnd = endObj;
      }

      // Uložíme do historie míst
      savePlaceToHistory(startObj);
      savePlaceToHistory(endObj);

      const newStage = state.previewRouteData || (await fetchOsrmStage(startObj, endObj));
      state.previewRouteData = null;

      state.stages.unshift(newStage);
      populateStageSelect();
      selectStage(newStage.id);
      el.routeSearchStatus.textContent = '';
      el.routeModal.classList.add('hidden');
      queueSpeech(`Trasa ${newStage.total_length_km} kilometrů, čas ${formatDuration(newStage.duration_sec)} připravena.`, 4, true);
    } catch (err) {
      el.routeSearchStatus.textContent = 'Chyba: ' + err.message;
    } finally {
      el.btnCalculateRoute.disabled = false;
    }
  }

  // =========================================================================
  // 7. INTERAKTIVNÍ OTÁČEJÍCÍ SE MAPA (PAN + PINCH ZOOM + RE-CENTER + KOMPAS)
  // =========================================================================
  function latLonToWorldPx(lat, lon, zoom) {
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * scale;
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return [x, y];
  }

  function worldPxToLatLon(wx, wy, zoom) {
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const lon = (wx / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * wy) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lat, lon];
  }

  function getOsmTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (state.tileCache.has(key)) return state.tileCache.get(key);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    img.onload = () => {
      if (!state.isRunning) drawInteractiveMap();
    };
    state.tileCache.set(key, img);
    return img;
  }

  function getCarPose() {
    const geom = state.currentStage ? state.currentStage.geometry : [];
    let lat = state.cameraLat;
    let lon = state.cameraLon;

    if (!state.demoMode && state.liveGpsPos) {
      lat = state.liveGpsPos.lat;
      lon = state.liveGpsPos.lon;
    } else if (geom.length) {
      let idx = 0;
      for (let i = 0; i < geom.length; i++) {
        if (geom[i].s <= state.distanceM) idx = i;
        else break;
      }
      const p0 = geom[idx];
      const p1 = geom[Math.min(geom.length - 1, idx + 1)];
      lat = p0.lat;
      lon = p0.lon;
      if (p1.s > p0.s) {
        const t = Math.min(1, Math.max(0, (state.distanceM - p0.s) / (p1.s - p0.s)));
        lat = p0.lat + (p1.lat - p0.lat) * t;
        lon = p0.lon + (p1.lon - p0.lon) * t;
      }
      const pAhead = geom[Math.min(geom.length - 1, idx + 3)];
      const dLon = (pAhead.lon - p0.lon) * Math.cos((lat * Math.PI) / 180);
      const dLat = pAhead.lat - p0.lat;
      if (Math.abs(dLon) > 1e-7 || Math.abs(dLat) > 1e-7) {
        const target = Math.atan2(dLon, dLat);
        let diff = target - state.routeHeadingRad;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        state.routeHeadingRad += diff * 0.25;
      }
    }

    // PRIORITA SMĚRU ŠIPKY:
    // 1. Kompas mobilu (deviceHeadingRad) – šipka se vždy otáčí podle mobilu!
    // 2. Fallback GPS heading (při pohybu)
    // 3. Fallback směr trasy (v Demo simulaci na PC bez kompasu)
    let arrowHeading = state.routeHeadingRad;
    if (state.deviceHeadingRad !== null) {
      arrowHeading = state.deviceHeadingRad;
    } else if (!state.demoMode && state.liveGpsPos && state.liveGpsPos.heading !== null && state.currentSpeedKmh > 5) {
      arrowHeading = (state.liveGpsPos.heading * Math.PI) / 180;
    }

    return { lat, lon, arrowHeading };
  }

  function setCenteredState(centered) {
    state.isCentered = centered;
    el.btnRecenter.classList.toggle('hidden', centered);
    if (centered) {
      state.mapZoom = Math.max(15.0, Math.min(17.0, state.mapZoom));
      drawInteractiveMap();
    }
  }

  function setupMapGestures() {
    const vp = el.mapViewport;
    const pointers = new Map();
    let lastPanX = 0, lastPanY = 0;
    let lastPinchDist = 0;

    function panByScreenDelta(dx, dy) {
      if (state.isCentered) {
        // Při odcentrování zafixujeme aktuální polohu kamery pod prstem
        const car = getCarPose();
        const anchorOffset = (el.trackCanvas.height * 0.68) - (el.trackCanvas.height * 0.5);
        const [carWx, carWy] = latLonToWorldPx(car.lat, car.lon, state.mapZoom);
        const cosR = Math.cos(state.cameraRotationRad);
        const sinR = Math.sin(state.cameraRotationRad);
        // Posuneme střed kamery tak, aby při přepnutí z anchorY=0.68 na 0.50 mapa vůbec neskočila!
        const shiftWx = sinR * anchorOffset;
        const shiftWy = -cosR * anchorOffset;
        const [cLat, cLon] = worldPxToLatLon(carWx + shiftWx, carWy + shiftWy, state.mapZoom);
        state.cameraLat = cLat;
        state.cameraLon = cLon;
        setCenteredState(false);
      }

      // Převod posunu na obrazovce (dx, dy) do otočených world souřadnic mapy
      const cosR = Math.cos(state.cameraRotationRad);
      const sinR = Math.sin(state.cameraRotationRad);
      const worldDx = -dx * cosR + dy * sinR;
      const worldDy = -dx * sinR - dy * cosR;

      const [cWx, cWy] = latLonToWorldPx(state.cameraLat, state.cameraLon, state.mapZoom);
      const [newLat, newLon] = worldPxToLatLon(cWx + worldDx, cWy + worldDy, state.mapZoom);
      state.cameraLat = Math.max(-80, Math.min(80, newLat));
      state.cameraLon = newLon;
      drawInteractiveMap();
    }

    vp.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      vp.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        lastPanX = e.clientX;
        lastPanY = e.clientY;
      } else if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        lastPanX = (pts[0].x + pts[1].x) / 2;
        lastPanY = (pts[0].y + pts[1].y) / 2;
      }
    });

    vp.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        const dx = e.clientX - lastPanX;
        const dy = e.clientY - lastPanY;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        if (Math.hypot(dx, dy) > 0.5) panByScreenDelta(dx, dy);
      } else if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        if (lastPinchDist > 10 && dist > 10) {
          const zoomDelta = Math.log2(dist / lastPinchDist);
          state.mapZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.mapZoom + zoomDelta));
        }
        panByScreenDelta(midX - lastPanX, midY - lastPanY);
        lastPinchDist = dist;
        lastPanX = midX;
        lastPanY = midY;
      }
    });

    const endPtr = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 1) {
        const remaining = Array.from(pointers.values())[0];
        lastPanX = remaining.x;
        lastPanY = remaining.y;
      }
    };
    vp.addEventListener('pointerup', endPtr);
    vp.addEventListener('pointercancel', endPtr);

    // Kolečko myši na PC pro zoomování
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.35 : -0.35;
      state.mapZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.mapZoom + delta));
      drawInteractiveMap();
    }, { passive: false });
  }

  function resizeCanvases() {
    const rect = el.mapViewport.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (el.trackCanvas.width !== w || el.trackCanvas.height !== h) {
      el.trackCanvas.width = w;
      el.trackCanvas.height = h;
      el.mapBgCanvas.width = w;
      el.mapBgCanvas.height = h;
    }
  }

  function drawInteractiveMap() {
    resizeCanvases();
    const w = el.trackCanvas.width;
    const h = el.trackCanvas.height;
    const bgCtx = el.mapBgCanvas.getContext('2d');
    const fgCtx = el.trackCanvas.getContext('2d');
    bgCtx.clearRect(0, 0, w, h);
    fgCtx.clearRect(0, 0, w, h);

    const car = getCarPose();

    let anchorX, anchorY, camLat, camLon, mapRotation;
    if (state.isCentered) {
      anchorX = w * 0.5;
      anchorY = h * 0.68;
      camLat = car.lat;
      camLon = car.lon;
      mapRotation = car.arrowHeading;
      state.cameraLat = camLat;
      state.cameraLon = camLon;
      state.cameraRotationRad = mapRotation;
    } else {
      anchorX = w * 0.5;
      anchorY = h * 0.5;
      camLat = state.cameraLat;
      camLon = state.cameraLon;
      mapRotation = state.cameraRotationRad;
    }

    const tileZ = Math.round(state.mapZoom);
    const zoomScale = Math.pow(2, state.mapZoom - tileZ);
    const [camWxZ, camWyZ] = latLonToWorldPx(camLat, camLon, tileZ);

    // 1. SPODNÍ VRSTVA: OpenStreetMap dlaždice
    bgCtx.save();
    bgCtx.fillStyle = '#e8e8e8';
    bgCtx.fillRect(0, 0, w, h);
    bgCtx.translate(anchorX, anchorY);
    bgCtx.rotate(-mapRotation);
    bgCtx.scale(zoomScale, zoomScale);

    const maxTiles = Math.pow(2, tileZ);
    const centerTx = Math.floor(camWxZ / TILE_SIZE);
    const centerTy = Math.floor(camWyZ / TILE_SIZE);
    const tileRange = 3;

    for (let dx = -tileRange; dx <= tileRange; dx++) {
      for (let dy = -tileRange; dy <= tileRange; dy++) {
        const tx = ((centerTx + dx) % maxTiles + maxTiles) % maxTiles;
        const ty = centerTy + dy;
        if (ty < 0 || ty >= maxTiles) continue;
        const img = getOsmTile(tileZ, tx, ty);
        if (img.complete && img.naturalWidth > 0) {
          bgCtx.drawImage(img, tx * TILE_SIZE - camWxZ, ty * TILE_SIZE - camWyZ, TILE_SIZE, TILE_SIZE);
        }
      }
    }
    bgCtx.restore();

    // 2. HORNÍ VRSTVA: Trasa + šipka auta (otáčí se podle kompasu mobilu!)
    const geom = state.currentStage ? state.currentStage.geometry : [];
    const [camWx, camWy] = latLonToWorldPx(camLat, camLon, state.mapZoom);

    fgCtx.save();
    fgCtx.translate(anchorX, anchorY);
    fgCtx.rotate(-mapRotation);

    if (geom.length) {
      fgCtx.lineCap = 'round';
      fgCtx.lineJoin = 'round';

      fgCtx.beginPath();
      for (let i = 0; i < geom.length; i++) {
        const [wx, wy] = latLonToWorldPx(geom[i].lat, geom[i].lon, state.mapZoom);
        if (i === 0) fgCtx.moveTo(wx - camWx, wy - camWy);
        else fgCtx.lineTo(wx - camWx, wy - camWy);
      }
      fgCtx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
      fgCtx.lineWidth = 14;
      fgCtx.stroke();

      for (let i = 1; i < geom.length; i++) {
        const p0 = geom[i - 1], p1 = geom[i];
        const [wx0, wy0] = latLonToWorldPx(p0.lat, p0.lon, state.mapZoom);
        const [wx1, wy1] = latLonToWorldPx(p1.lat, p1.lon, state.mapZoom);

        fgCtx.beginPath();
        fgCtx.moveTo(wx0 - camWx, wy0 - camWy);
        fgCtx.lineTo(wx1 - camWx, wy1 - camWy);

        if (p1.s <= state.distanceM) {
          fgCtx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
          fgCtx.lineWidth = 8;
        } else if (p1.r < 40) {
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
    }

    // 3. Šipka auta v mapových souřadnicích – otočená podle mobilu (car.arrowHeading)!
    const [carWx, carWy] = latLonToWorldPx(car.lat, car.lon, state.mapZoom);
    fgCtx.translate(carWx - camWx, carWy - camWy);
    fgCtx.rotate(car.arrowHeading);

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
  // 8. RALLY CO-DRIVER ENGINE (ODPOČET ROVINEK + O 1 POKYN NAPŘED)
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
    const onStraightApproach = remToCorner > leadM && remToCorner >= 60;

    if (onStraightApproach) {
      const roundedNow = roundDisplayDist(remToCorner);
      el.primaryCallCard.className = 'hud-banner sev-0';
      el.cornerArrowPath.setAttribute('d', getCornerSvgPath('S', 0));
      el.cornerShortCode.textContent = `↑ ${roundedNow} m`;
      el.callDistanceCountdown.textContent = `ROVINKA`;
      el.callCzechText.textContent = `DÁLE ${roundedNow} METRŮ`;
      el.cornerModBadges.innerHTML = '';

      el.nextCornerCode.textContent = nextCorner.short_label;
      el.nextCornerText.textContent = `${nextCorner.call_cz} (za ${Math.round(remToCorner)} m)`;

      const pAfter = formatCornerPreview(cornerAfter, nextCorner.end_distance_m);
      el.afterCornerCode.textContent = pAfter.code;
      el.afterCornerText.textContent = pAfter.text;

      if (state.isRunning) {
        if (state.lastStraightAnnouncedFor !== nextCorner.id) {
          state.lastStraightAnnouncedFor = nextCorner.id;
          if (roundedNow >= 80) queueSpeech(`Dále ${roundedNow}`, 0, false);
          for (const m of STRAIGHT_MILESTONES) {
            if (m >= remToCorner - 45) state.spokenMilestones.add(`${nextCorner.id}_${m}`);
          }
        } else {
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
      el.primaryCallCard.className = `hud-banner sev-${nextCorner.severity || 3}`;
      el.cornerArrowPath.setAttribute('d', getCornerSvgPath(nextCorner.dir, nextCorner.severity));
      el.cornerShortCode.textContent = nextCorner.short_label;
      el.callDistanceCountdown.textContent = remToCorner > 5 ? `ZA ${Math.round(remToCorner)} m` : 'V ZATÁČCE';
      el.callCzechText.textContent = nextCorner.call_cz;

      el.cornerModBadges.innerHTML = '';
      if (nextCorner.is_hairpin) addBadge('VRACÁK', 'danger');
      if (nextCorner.modifier === 'utahuje') addBadge('UTAHUJE', 'danger');
      if (nextCorner.has_crest) addBadge('HORIZONT', 'warn');

      const pNext = formatCornerPreview(cornerAfter, nextCorner.end_distance_m);
      el.nextCornerCode.textContent = pNext.code;
      el.nextCornerText.textContent = pNext.text;

      if (cornerAfter) {
        const pThird = formatCornerPreview(cornerThird, cornerAfter.end_distance_m);
        el.afterCornerCode.textContent = pThird.code;
        el.afterCornerText.textContent = pThird.text;
      } else {
        el.afterCornerCode.textContent = '--';
        el.afterCornerText.textContent = '--';
      }

      if (state.isRunning && !state.spokenCornerIds.has(nextCorner.id)) {
        state.spokenCornerIds.add(nextCorner.id);
        let speechText = nextCorner.call_cz;
        if (cornerAfter && (cornerAfter.distance_m - nextCorner.end_distance_m) <= 45) {
          state.spokenCornerIds.add(cornerAfter.id);
          speechText = `${speechText.replace(/\s+do$/i, '')}, do ${cornerAfter.call_cz}`;
        }
        queueSpeech(speechText, nextCorner.severity || 3, true);
      }

      if (state.isRunning && cornerAfter && (cornerAfter.distance_m - distM) <= leadM * 0.65 && !state.spokenCornerIds.has(cornerAfter.id)) {
        state.spokenCornerIds.add(cornerAfter.id);
        queueSpeech(cornerAfter.call_cz, cornerAfter.severity || 3, true);
      }
    }

    const totalM = Math.max(1, state.currentStage.total_length_m);
    const remRatio = Math.max(0, 1 - distM / totalM);
    const totalSec = state.currentStage.duration_sec || Math.round((totalM / 1000 / 60) * 3600);
    el.stageProgressText.textContent = `${(distM / 1000).toFixed(1)} / ${(totalM / 1000).toFixed(1)} km`;
    el.stageEtaText.textContent = `⏱️ ${formatDuration(totalSec * remRatio)}`;
  }

  function addBadge(label, type) {
    const span = document.createElement('span');
    span.className = `mod-tag ${type}`;
    span.textContent = label;
    el.cornerModBadges.appendChild(span);
  }

  // =========================================================================
  // 9. REŽIMY: REÁLNÁ GPS (HLAVNÍ) vs DEMO + AUTO-START Z AKTUÁLNÍ POLOHY
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
    drawInteractiveMap();
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
          if (deltaM < 250) {
            state.distanceM = bestPt.s;
            addDrivenMeters(deltaM);
          } else if (state.distanceM === 0) {
            state.distanceM = bestPt.s;
          }
          evaluatePacenotesAtDistance(state.distanceM);
        }
        drawInteractiveMap();
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
    drawInteractiveMap();
    if (state.isRunning) requestAnimationFrame(tickDemoSimulation);
  }

  async function startStage() {
    if (!state.currentStage) return;
    if (!state.isProUnlocked && state.odometerKm >= FREE_KM_LIMIT) {
      el.freemiumModal.classList.remove('hidden');
      return;
    }

    ensureAudioContext();
    await requestCompassPermissionIfNeeded();
    setCenteredState(true);

    // V reálném GPS režimu při spuštění trasy automaticky nastavíme start na aktuální polohu uživatele!
    if (!state.demoMode && state.currentStage.geometry.length) {
      try {
        el.gpsStatusBadge.textContent = 'START Z GPS...';
        el.gpsStatusBadge.className = 'badge badge-wait';
        const gpsStart = await getCurrentGpsPromise();
        const firstPt = state.currentStage.geometry[0];
        const dLat = (firstPt.lat - gpsStart.lat) * 111320;
        const dLon = (firstPt.lon - gpsStart.lon) * 111320 * Math.cos((gpsStart.lat * Math.PI) / 180);
        const distFromStartM = Math.hypot(dLat, dLon);

        // Pokud uživatel stojí dál než 150 m od původního začátku trasy, automaticky přepočítáme trasu z jeho polohy do cíle!
        if (distFromStartM > 150) {
          const lastPt = state.currentStage.geometry[state.currentStage.geometry.length - 1];
          const destObj = state.currentStage.destination || {
            lat: lastPt.lat,
            lon: lastPt.lon,
            label: state.currentStage.name.split('→').pop().trim()
          };
          const rerouted = await fetchOsrmStage(gpsStart, destObj);
          state.currentStage = rerouted;
          state.corners = rerouted.pacenotes.filter((n) => n.type === 'corner');
          el.activeRouteName.textContent = rerouted.name;
          state.distanceM = 0;
          state.spokenCornerIds.clear();
          state.spokenMilestones.clear();
          state.lastStraightAnnouncedFor = null;
        }
      } catch (err) {
        console.warn('Auto-start z GPS přeskočen:', err.message);
      }
    }

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
    setCenteredState(true);
    evaluatePacenotesAtDistance(0);
    drawInteractiveMap();
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
  // 10. FREEMIUM, GPX & INICIALIZACE
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
      const dur = st.duration_sec ? ` • ${formatDuration(st.duration_sec)}` : '';
      opt.textContent = `${st.name} (${st.total_length_km} km${dur})`;
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
    applyNavigationMode(false);
    updateFreemiumUi();
    updateLeadTimeLabel();
    setupMapGestures();

    // Na Androidu / desktopu připojíme kompas automaticky (iOS povolí při kliknutí na START / tlačítko kompasu)
    if (typeof DeviceOrientationEvent === 'undefined' || typeof DeviceOrientationEvent.requestPermission !== 'function') {
      attachCompassListeners();
    }

    window.addEventListener('resize', drawInteractiveMap);

    // Našeptávač + historie míst hned po rozkliknutí
    setupAutocomplete(el.inputStart, el.startSuggestions, true, (item) => { state.selectedStart = item; });
    setupAutocomplete(el.inputEnd, el.endSuggestions, false, (item) => { state.selectedEnd = item; });

    el.btnRecenter.addEventListener('click', () => setCenteredState(true));
    el.btnStartPause.addEventListener('click', () => (state.isRunning ? pauseStage() : startStage()));
    el.btnAudioToggle.addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      el.btnAudioToggle.textContent = state.audioEnabled ? '🔊' : '🔇';
      if (!state.audioEnabled) clearSpeechQueue();
    });

    // Route modal: při otevření automaticky předvyplníme Start = Moje poloha (v GPS režimu)
    el.btnOpenRoute.addEventListener('click', () => {
      el.routeModal.classList.remove('hidden');
      if (!state.demoMode && !el.inputStart.value.trim()) {
        setStartToCurrentGps();
      }
    });
    el.btnCloseRoute.addEventListener('click', () => el.routeModal.classList.add('hidden'));
    el.btnCalculateRoute.addEventListener('click', calculateStartEndRoute);
    el.btnUseMyLocation.addEventListener('click', setStartToCurrentGps);

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
    el.btnModeGps.addEventListener('click', () => applyNavigationMode(false));
    el.btnModeDemo.addEventListener('click', () => applyNavigationMode(true));
    el.btnEnableCompass.addEventListener('click', requestCompassPermissionIfNeeded);

    el.btnReset.addEventListener('click', () => { resetStage(); el.settingsModal.classList.add('hidden'); });
    el.btnTestVoice.addEventListener('click', () => {
      ensureAudioContext();
      queueSpeech('Dvě stě, Pravá dva přes horizont', 2, true);
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
