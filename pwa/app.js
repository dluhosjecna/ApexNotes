/**
 * ApexNotes – Fáze 3 & 4: Mobilní PWA aplikace (iPhone 13 iOS / Android)
 * - Offline architektura + registrace Service Workeru
 * - Prediktivní telemetrie (dynamický předstih čtení podle rychlosti v km/h)
 * - Česká hlasová navigace (Web Speech API cs-CZ + WAV audio banka)
 * - Real-time GPS napojení (navigator.geolocation.watchPosition) + Jízdní simulátor
 * - Vestavěný JS port geometrického algoritmu (Catmull-Rom + Mengerova křivost) pro přímý import GPX v telefonu
 * - Freemium počítadlo kilometrů (limit 40 km zdarma, poté odemčení plné verze za 300 Kč)
 */

(function () {
  'use strict';

  const FREE_KM_LIMIT = 40.0;
  const EARTH_R = 6371000.0;

  // Stav aplikace
  const state = {
    stages: window.APEXNOTES_STAGES || [],
    currentStage: null,
    isRunning: false,
    useRealGps: false,
    gpsWatchId: null,
    audioEnabled: true,
    distanceM: 0.0,
    speedKmh: 95.0,
    leadTimeSec: 3.5,
    spokenNoteIds: new Set(),
    activeNote: null,
    nextNote: null,
    lastTickTime: null,
    odometerKm: parseFloat(localStorage.getItem('apexnotes_odometer_km') || '0.0'),
    isProUnlocked: localStorage.getItem('apexnotes_pro_unlocked') === 'true',
    audioCtx: null
  };

  // DOM elementy
  const el = {
    stageSelect: document.getElementById('stageSelect'),
    gpxFileInput: document.getElementById('gpxFileInput'),
    gpsStatusBadge: document.getElementById('gpsStatusBadge'),
    freemiumPill: document.getElementById('freemiumPill'),
    freemiumKmText: document.getElementById('freemiumKmText'),
    btnAudioToggle: document.getElementById('btnAudioToggle'),
    primaryCallCard: document.getElementById('primaryCallCard'),
    callDistanceCountdown: document.getElementById('callDistanceCountdown'),
    callMetaRadius: document.getElementById('callMetaRadius'),
    cornerArrowPath: document.getElementById('cornerArrowPath'),
    cornerShortCode: document.getElementById('cornerShortCode'),
    cornerModBadges: document.getElementById('cornerModBadges'),
    callCzechText: document.getElementById('callCzechText'),
    nextCallCode: document.getElementById('nextCallCode'),
    nextCallText: document.getElementById('nextCallText'),
    stageProgressText: document.getElementById('stageProgressText'),
    trackCanvas: document.getElementById('trackCanvas'),
    elevationCanvas: document.getElementById('elevationCanvas'),
    speedValue: document.getElementById('speedValue'),
    speedSlider: document.getElementById('speedSlider'),
    speedSliderLabel: document.getElementById('speedSliderLabel'),
    leadTimeSlider: document.getElementById('leadTimeSlider'),
    leadTimeLabel: document.getElementById('leadTimeLabel'),
    btnStartPause: document.getElementById('btnStartPause'),
    btnReset: document.getElementById('btnReset'),
    btnRealGps: document.getElementById('btnRealGps'),
    btnTestVoice: document.getElementById('btnTestVoice'),
    freemiumModal: document.getElementById('freemiumModal'),
    kmMeterFill: document.getElementById('kmMeterFill'),
    modalKmDetail: document.getElementById('modalKmDetail'),
    btnUnlockPro: document.getElementById('btnUnlockPro'),
    btnResetTrial: document.getElementById('btnResetTrial'),
    btnCloseModal: document.getElementById('btnCloseModal')
  };

  // Registrace Service Workeru pro 100% offline běh
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // =========================================================================
  // 1. AUDIO & ČESKÝ HLASOVÝ SYNTETIZÉR (iOS Safari + Android kompatibilní)
  // =========================================================================
  function ensureAudioContext() {
    if (!state.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        state.audioCtx = new AudioContextClass();
      }
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

    // Čím ostřejší zatáčka (1 = vracák), tím vyšší varovný tón v interkomu
    const freqMap = { 1: 780, 2: 660, 3: 540, 4: 460, 5: 400, 6: 350, 0: 310 };
    osc.frequency.setValueAtTime(freqMap[severity] || 440, now);
    osc.type = severity <= 2 && severity > 0 ? 'sawtooth' : 'sine';

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);

    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  function speakCzechPacenote(textCz, severity = 3) {
    if (!state.audioEnabled) return;
    playIntercomCue(severity);

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(textCz);
      utter.lang = 'cs-CZ';
      utter.rate = 1.18; // Dynamické závodní tempo spolujezdce
      utter.pitch = severity === 1 ? 1.12 : 1.0;

      const voices = window.speechSynthesis.getVoices();
      const czVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('cs'));
      if (czVoice) utter.voice = czVoice;

      window.speechSynthesis.speak(utter);
    }
  }

  // =========================================================================
  // 2. ŠIPKY ZATÁČEK (SVG VEKTORY PRO STUPNĚ 1–6 LEVÁ / PRAVÁ)
  // =========================================================================
  function getCornerSvgPath(dir, severity) {
    if (dir === 'S' || !severity) {
      // Rovinka
      return 'M60 102 L60 20 M36 44 L60 18 L84 44';
    }
    const isLeft = dir === 'L';
    // Stupně 1 (vracák) až 6 (mírná)
    const pathsLeft = {
      1: 'M76 102 L76 42 C76 16 34 16 34 44 L34 86 M16 68 L34 90 L52 68', // Vracák L1
      2: 'M78 102 L78 52 C78 28 55 24 24 24 M44 8 L20 24 L44 40',        // Ostrá L2
      3: 'M74 102 L74 58 C74 36 52 26 26 22 M48 10 L22 22 L42 42',       // Střední L3
      4: 'M70 102 L70 62 C70 42 50 28 30 18 M54 12 L28 18 L40 42',       // Rychlá L4
      5: 'M66 102 L66 64 C66 44 52 30 38 16 M62 16 L36 16 L40 42',       // Velmi rychlá L5
      6: 'M64 102 L60 58 L44 18 M66 28 L44 16 L34 40'                    // Mírná L6
    };

    if (isLeft) {
      return pathsLeft[severity] || pathsLeft[3];
    }
    // Zrcadlení pro pravé zatáčky (x -> 120 - x)
    const pathsRight = {
      1: 'M44 102 L44 42 C44 16 86 16 86 44 L86 86 M68 68 L86 90 L104 68',
      2: 'M42 102 L42 52 C42 28 65 24 96 24 M76 8 L100 24 L76 40',
      3: 'M46 102 L46 58 C46 36 68 26 94 22 M72 10 L98 22 L78 42',
      4: 'M50 102 L50 62 C50 42 70 28 90 18 M66 12 L92 18 L80 42',
      5: 'M54 102 L54 64 C54 44 68 30 82 16 M58 16 L84 16 L80 42',
      6: 'M56 102 L60 58 L76 18 M54 28 L76 16 L86 40'
    };
    return pathsRight[severity] || pathsRight[3];
  }

  // =========================================================================
  // 3. PREDIKTIVNÍ TELEMETRIE & DYNAMICKÝ PŘEDSTIH ČTENÍ
  // =========================================================================
  function getDynamicLeadDistanceM() {
    // v [m/s] * leadTime [s] (např. při 80 km/h = 22.2 m/s * 3.5 s = 77.8 m předstih)
    const speedMs = state.speedKmh / 3.6;
    return Math.max(25.0, speedMs * state.leadTimeSec);
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

    // Najdeme nejbližší nadcházející zatáčku/povel
    let upcomingIdx = notes.findIndex((n) => n.end_distance_m >= distM);
    if (upcomingIdx === -1) {
      // Cíl rychlostní zkoušky
      if (state.isRunning) {
        finishStage();
      }
      return;
    }

    const current = notes[upcomingIdx];
    const next = notes[upcomingIdx + 1] || null;
    state.activeNote = current;
    state.nextNote = next;

    // Pokud se vozidlo dostalo do zóny dynamického předstihu, přečteme hlášku!
    if (state.isRunning && current.distance_m <= lookaheadM && !state.spokenNoteIds.has(current.id)) {
      state.spokenNoteIds.add(current.id);
      speakCzechPacenote(current.call_cz, current.severity || 0);
    }

    // Také zkontrolujeme, zda i navazující zatáčka ("do...") už nespadá do předstihu
    if (
      state.isRunning &&
      next &&
      next.distance_m <= distM + leadM * 0.55 &&
      !state.spokenNoteIds.has(next.id)
    ) {
      state.spokenNoteIds.add(next.id);
      speakCzechPacenote(next.call_cz, next.severity || 0);
    }

    renderHud(current, next, distM);
  }

  function renderHud(note, nextNote, distM) {
    if (!note) return;

    const toCornerM = Math.max(0, Math.round(note.distance_m - distM));
    el.callDistanceCountdown.textContent = toCornerM > 0 ? `ZA ${toCornerM} m` : `V ZATÁČCE`;
    el.callMetaRadius.textContent = note.type === 'corner' ? `R = ${note.radius_m} m` : `ROVINKA`;

    // Třída ostrosti zatáčky sev-1 až sev-6
    el.primaryCallCard.className = `call-card sev-${note.severity || 0}`;
    el.cornerArrowPath.setAttribute('d', getCornerSvgPath(note.dir, note.severity));
    el.cornerShortCode.textContent = note.short_label;
    el.callCzechText.textContent = note.call_cz;

    // Modifikátory (VRACÁK, UTAHUJE, HORIZONT, DLOUHÁ)
    el.cornerModBadges.innerHTML = '';
    if (note.is_hairpin) {
      addBadge('VRACÁK', 'danger');
    }
    if (note.modifier === 'utahuje') {
      addBadge('UTAHUJE', 'danger');
    } else if (note.modifier === 'otevírá') {
      addBadge('OTEVÍRÁ', 'info');
    }
    if (note.has_crest) {
      addBadge('HORIZONT', 'warn');
    }
    if (note.is_long) {
      addBadge('DLOUHÁ', 'info');
    }

    if (nextNote) {
      el.nextCallCode.textContent = nextNote.short_label;
      el.nextCallText.textContent = `${nextNote.call_cz} (za ${Math.max(0, Math.round(nextNote.distance_m - distM))} m)`;
    } else {
      el.nextCallCode.textContent = 'CÍL';
      el.nextCallText.textContent = 'Konec rychlostní zkoušky';
    }

    const totalKm = (state.currentStage.total_length_m / 1000).toFixed(2);
    const currKm = (distM / 1000).toFixed(2);
    el.stageProgressText.textContent = `${currKm} / ${totalKm} km`;
  }

  function addBadge(label, type) {
    const span = document.createElement('span');
    span.className = `mod-tag ${type}`;
    span.textContent = label;
    el.cornerModBadges.appendChild(span);
  }

  // =========================================================================
  // 4. VYKRESLENÍ MAPY TRATĚ A VÝŠKOVÉHO PROFILU (CANVAS)
  // =========================================================================
  function drawTrackAndElevation() {
    if (!state.currentStage || !state.currentStage.geometry.length) return;
    const geom = state.currentStage.geometry;

    // 1. Mapa tratě
    const ctx = el.trackCanvas.getContext('2d');
    const w = el.trackCanvas.width;
    const h = el.trackCanvas.height;
    ctx.clearRect(0, 0, w, h);

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of geom) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }

    const pad = 26;
    const latSpan = Math.max(1e-5, maxLat - minLat);
    const lonSpan = Math.max(1e-5, maxLon - minLon);

    function toXY(p) {
      const x = pad + ((p.lon - minLon) / lonSpan) * (w - 2 * pad);
      const y = h - pad - ((p.lat - minLat) / latSpan) * (h - 2 * pad);
      return [x, y];
    }

    // Vykreslení segmentů trati barevně podle poloměru zatáčky
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < geom.length; i++) {
      const p0 = geom[i - 1];
      const p1 = geom[i];
      const [x0, y0] = toXY(p0);
      const [x1, y1] = toXY(p1);

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);

      if (p1.s <= state.distanceM) {
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 5;
      } else if (p1.r < 38) {
        ctx.strokeStyle = '#ff2e2e';
        ctx.lineWidth = 7;
      } else if (p1.r < 95) {
        ctx.strokeStyle = '#ffd000';
        ctx.lineWidth = 6;
      } else {
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 5;
      }
      ctx.stroke();
    }

    // Aktuální poloha auta na trati
    let carPt = geom[0];
    for (const p of geom) {
      if (p.s <= state.distanceM) carPt = p;
      else break;
    }
    const [cx, cy] = toXY(carPt);

    // Pulzující kruh kolem auta
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#00e5ff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // 2. Výškový profil (DEM)
    const ectx = el.elevationCanvas.getContext('2d');
    const ew = el.elevationCanvas.width;
    const eh = el.elevationCanvas.height;
    ectx.clearRect(0, 0, ew, eh);

    const minE = state.currentStage.min_ele_m;
    const maxE = Math.max(minE + 10, state.currentStage.max_ele_m);
    const totalS = Math.max(1, state.currentStage.total_length_m);

    ectx.beginPath();
    ectx.moveTo(0, eh);
    for (const p of geom) {
      const x = (p.s / totalS) * ew;
      const y = eh - 6 - ((p.ele - minE) / (maxE - minE)) * (eh - 14);
      ectx.lineTo(x, y);
    }
    ectx.lineTo(ew, eh);
    ectx.closePath();
    ectx.fillStyle = 'rgba(255, 208, 0, 0.18)';
    ectx.fill();

    // Ukazatel pozice ve výškovém profilu
    const progX = (state.distanceM / totalS) * ew;
    ectx.beginPath();
    ectx.moveTo(progX, 0);
    ectx.lineTo(progX, eh);
    ectx.strokeStyle = '#00e5ff';
    ectx.lineWidth = 3;
    ectx.stroke();
  }

  // =========================================================================
  // 5. FREEMIUM POČÍTADLO KILOMETRŮ (FÁZE 4)
  // =========================================================================
  function updateFreemiumUi() {
    if (state.isProUnlocked) {
      el.freemiumPill.classList.add('pro-unlocked');
      el.freemiumKmText.textContent = 'PRO AKTIVNÍ ∞';
      el.kmMeterFill.style.width = '100%';
      el.modalKmDetail.textContent = `Plná verze ApexNotes PRO je aktivní (celkem odjeto ${state.odometerKm.toFixed(1)} km).`;
    } else {
      el.freemiumPill.classList.remove('pro-unlocked');
      el.freemiumKmText.textContent = `${state.odometerKm.toFixed(1)} / ${FREE_KM_LIMIT} km`;
      const pct = Math.min(100, (state.odometerKm / FREE_KM_LIMIT) * 100);
      el.kmMeterFill.style.width = `${pct}%`;
      el.modalKmDetail.textContent = `Odjeto: ${state.odometerKm.toFixed(1)} km ze ${FREE_KM_LIMIT.toFixed(1)} km zdarma`;
    }
  }

  function addDrivenMeters(deltaM) {
    if (deltaM <= 0) return;
    state.odometerKm += deltaM / 1000.0;
    localStorage.setItem('apexnotes_odometer_km', state.odometerKm.toFixed(3));
    updateFreemiumUi();

    if (!state.isProUnlocked && state.odometerKm >= FREE_KM_LIMIT) {
      pauseStage();
      speakCzechPacenote('Vyčerpán bezplatný limit čtyřicet kilometrů. Odemkněte plnou verzi.', 1);
      el.freemiumModal.classList.remove('hidden');
    }
  }

  // =========================================================================
  // 6. HLAVNÍ SMYČKA JÍZDY (SIMULÁTOR + REÁLNÁ GPS V IPHONU 13)
  // =========================================================================
  function tickSimulation(timestamp) {
    if (!state.isRunning) return;
    if (!state.lastTickTime) state.lastTickTime = timestamp;
    const dtSec = Math.min(0.25, (timestamp - state.lastTickTime) / 1000.0);
    state.lastTickTime = timestamp;

    if (!state.useRealGps) {
      const speedMs = state.speedKmh / 3.6;
      const deltaM = speedMs * dtSec;
      state.distanceM += deltaM;
      addDrivenMeters(deltaM);
    }

    evaluatePacenotesAtDistance(state.distanceM);
    drawTrackAndElevation();

    if (state.isRunning) {
      requestAnimationFrame(tickSimulation);
    }
  }

  function startStage() {
    if (!state.currentStage) return;
    if (!state.isProUnlocked && state.odometerKm >= FREE_KM_LIMIT) {
      el.freemiumModal.classList.remove('hidden');
      return;
    }

    ensureAudioContext();
    if (state.distanceM >= state.currentStage.total_length_m - 10) {
      resetStage();
    }

    state.isRunning = true;
    state.lastTickTime = null;
    el.btnStartPause.textContent = '⏸ PAUZA';
    el.btnStartPause.classList.add('running');

    if (state.distanceM < 5 && state.spokenNoteIds.size === 0) {
      speakCzechPacenote('Start rychlostní zkoušky', 3);
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
    el.btnStartPause.textContent = '▶ START RZ';
    if (state.currentStage && state.currentStage.pacenotes.length) {
      renderHud(state.currentStage.pacenotes[0], state.currentStage.pacenotes[1] || null, 0);
    }
    drawTrackAndElevation();
  }

  function finishStage() {
    pauseStage();
    el.btnStartPause.textContent = '🏁 CÍL RZ (ZNOVU)';
    el.cornerShortCode.textContent = 'CÍL';
    el.callCzechText.textContent = 'CÍL RYCHLOSTNÍ ZKOUŠKY!';
    speakCzechPacenote('Cíl rychlostní zkoušky', 5);
  }

  // Napojení na reálnou GPS v iPhonu 13 / Androidu
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
      alert('Tento prohlížeč nepodporuje GPS geolokaci.');
      return;
    }

    state.useRealGps = true;
    el.gpsStatusBadge.textContent = 'GPS AKTIVNÍ';
    el.gpsStatusBadge.className = 'badge badge-gps';
    el.btnRealGps.classList.add('active-gps');

    state.gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed } = pos.coords;
        if (typeof speed === 'number' && !isNaN(speed) && speed >= 0) {
          state.speedKmh = Math.max(15, Math.round(speed * 3.6));
          el.speedValue.textContent = state.speedKmh;
          el.speedSlider.value = state.speedKmh;
          el.speedSliderLabel.textContent = `${state.speedKmh} km/h`;
          updateLeadTimeLabel();
        }

        // Přiřazení k nejbližšímu bodu na trati (Map-matching)
        if (state.currentStage && state.currentStage.geometry.length) {
          let bestPt = state.currentStage.geometry[0];
          let bestDist = Infinity;
          for (const p of state.currentStage.geometry) {
            const dLat = (p.lat - latitude) * 111320;
            const dLon = (p.lon - longitude) * 111320 * Math.cos((latitude * Math.PI) / 180);
            const d = dLat * dLat + dLon * dLon;
            if (d < bestDist) {
              bestDist = d;
              bestPt = p;
            }
          }
          const deltaM = Math.max(0, bestPt.s - state.distanceM);
          state.distanceM = bestPt.s;
          addDrivenMeters(deltaM);
          evaluatePacenotesAtDistance(state.distanceM);
          drawTrackAndElevation();
        }
      },
      (err) => {
        alert('Nelze získat GPS polohu: ' + err.message + '. Přepínám zpět na simulátor.');
        toggleRealGps();
      },
      { enableHighAccuracy: true, maximumAge: 250, timeout: 8000 }
    );
  }

  // =========================================================================
  // 7. VESTAVĚNÝ GPX PARSER V JS (PRO NAHRÁNÍ VLASTNÍ GPX TRATĚ V TELEFONU)
  // =========================================================================
  function parseUploadedGpxInBrowser(xmlText, fileName) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'text/xml');
    const trkpts = Array.from(xml.querySelectorAll('trkpt, rtept'));
    if (trkpts.length < 5) {
      alert('GPX soubor obsahuje příliš málo bodů.');
      return;
    }

    const nameEl = xml.querySelector('trk > name, metadata > name');
    const trackName = nameEl ? nameEl.textContent.trim() : fileName.replace(/\.gpx$/i, '');

    const lat0 = (parseFloat(trkpts[0].getAttribute('lat')) * Math.PI) / 180;
    const lon0 = (parseFloat(trkpts[0].getAttribute('lon')) * Math.PI) / 180;
    const cosLat0 = Math.cos(lat0);

    const pts = [];
    let totalS = 0;
    for (const pt of trkpts) {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const eleEl = pt.querySelector('ele');
      const ele = eleEl ? parseFloat(eleEl.textContent) : 320.0;
      const x = (((lon * Math.PI) / 180) - lon0) * cosLat0 * EARTH_R;
      const y = (((lat * Math.PI) / 180) - lat0) * EARTH_R;

      if (pts.length) {
        const d = Math.hypot(x - pts[pts.length - 1].x, y - pts[pts.length - 1].y);
        if (d < 1.5) continue;
        totalS += d;
      }
      pts.push({ lat, lon, ele, x, y, s: totalS, r: 999, dir: 'S' });
    }

    // Výpočet Mengerovy křivosti na nahrané GPX
    const sevWords = { 1: 'jedna', 2: 'dva', 3: 'tři', 4: 'čtyři', 5: 'pět', 6: 'šest' };
    const pacenotes = [];
    let lastCornerEnd = 0;

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

    let i = 2;
    while (i < pts.length - 2) {
      if (pts[i].r <= 220) {
        const cDir = pts[i].dir;
        const startS = pts[i].s;
        let minR = pts[i].r;
        let apex = pts[i];
        while (i < pts.length - 2 && pts[i].r <= 230 && pts[i].dir === cDir) {
          if (pts[i].r < minR) {
            minR = pts[i].r;
            apex = pts[i];
          }
          i++;
        }
        const endS = pts[i].s;
        let sev = minR < 22 ? 1 : minR < 38 ? 2 : minR < 62 ? 3 : minR < 98 ? 4 : minR < 155 ? 5 : 6;
        const straight = Math.round((startS - lastCornerEnd) / 10) * 10;
        if (straight >= 50) {
          pacenotes.push({
            id: pacenotes.length + 1,
            type: 'straight',
            dir: 'S',
            severity: 0,
            distance_m: lastCornerEnd + 5,
            end_distance_m: startS,
            radius_m: 999,
            short_label: `↑ ${straight} m`,
            call_cz: `Dále ${straight}`
          });
        }
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
        lastCornerEnd = endS;
      } else {
        i++;
      }
    }

    const customStage = {
      id: 'custom_' + Date.now(),
      name: `${trackName} (Vlastní GPX)`,
      total_length_m: Math.round(totalS),
      total_length_km: (totalS / 1000).toFixed(2),
      min_ele_m: Math.min(...pts.map((p) => p.ele)),
      max_ele_m: Math.max(...pts.map((p) => p.ele)),
      corners_count: pacenotes.filter((n) => n.type === 'corner').length,
      pacenotes,
      geometry: pts
    };

    state.stages.unshift(customStage);
    populateStageSelect();
    selectStage(customStage.id);
    speakCzechPacenote(`Nahrána vlastní trať. Počet zatáček ${customStage.corners_count}.`, 4);
  }

  // =========================================================================
  // 8. INICIALIZACE UI & EVENT LISTENERY
  // =========================================================================
  function populateStageSelect() {
    el.stageSelect.innerHTML = '';
    for (const st of state.stages) {
      const opt = document.createElement('option');
      opt.value = st.id;
      opt.textContent = `${st.name} (${st.total_length_km} km | ${st.corners_count} zat.)`;
      el.stageSelect.appendChild(opt);
    }
  }

  function selectStage(stageId) {
    const found = state.stages.find((s) => s.id === stageId) || state.stages[0];
    if (!found) return;
    state.currentStage = found;
    el.stageSelect.value = found.id;
    resetStage();
  }

  function init() {
    populateStageSelect();
    if (state.stages.length > 0) {
      selectStage(state.stages[0].id);
    }
    updateFreemiumUi();
    updateLeadTimeLabel();

    el.stageSelect.addEventListener('change', (e) => selectStage(e.target.value));

    el.gpxFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => parseUploadedGpxInBrowser(ev.target.result, file.name);
      reader.readAsText(file);
    });

    el.btnStartPause.addEventListener('click', () => {
      if (state.isRunning) pauseStage();
      else startStage();
    });

    el.btnReset.addEventListener('click', resetStage);
    el.btnRealGps.addEventListener('click', toggleRealGps);

    el.btnTestVoice.addEventListener('click', () => {
      ensureAudioContext();
      const sample = state.activeNote ? state.activeNote.call_cz : 'Pravá čtyři utahuje do dva přes horizont';
      speakCzechPacenote(sample, state.activeNote ? state.activeNote.severity : 2);
    });

    el.btnAudioToggle.addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      el.btnAudioToggle.textContent = state.audioEnabled ? '🔊' : '🔇';
      el.btnAudioToggle.classList.toggle('active', state.audioEnabled);
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
    el.freemiumPill.addEventListener('click', () => {
      updateFreemiumUi();
      el.freemiumModal.classList.remove('hidden');
    });

    el.btnCloseModal.addEventListener('click', () => {
      el.freemiumModal.classList.add('hidden');
    });

    el.btnUnlockPro.addEventListener('click', () => {
      state.isProUnlocked = true;
      localStorage.setItem('apexnotes_pro_unlocked', 'true');
      updateFreemiumUi();
      speakCzechPacenote('Plná verze ApexNotes Pro odemčena.', 5);
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
