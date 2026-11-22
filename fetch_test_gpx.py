import os
import json
import math
import urllib.request
from datetime import datetime, timedelta

# Definice 3 reálných českých rally úseků (start a cíl pro OSRM routing po reálných silnicích)
STAGES = [
    {
        "id": "rz_barum_pindula",
        "name": "RZ1 Barum Rally – Pindula (Želechovice – Provodov)",
        "region": "Zlínský kraj (Barum Czech Rally Zlín)",
        "waypoints": [
            (49.2163, 17.7492),  # Želechovice nad Dřevnicí - výjezd
            (49.1935, 17.7568),  # Pindula sedlo
            (49.1812, 17.7485),  # Provodov
        ],
        "base_alt": 310.0,
        "alt_profile": [
            (0.0, 295.0), (0.20, 340.0), (0.38, 415.0), (0.42, 418.0),
            (0.47, 392.0), (0.65, 365.0), (0.78, 385.0), (0.82, 360.0), (1.0, 325.0)
        ]
    },
    {
        "id": "rz_bohemia_navarov",
        "name": "RZ2 Rally Bohemia – Návarov (Železný Brod – Návarov – Zlatá Olešnice)",
        "region": "Liberecký kraj (Rally Bohemia)",
        "waypoints": [
            (50.6538, 15.2912),  # Horská Kamenice / Železný Brod
            (50.6805, 15.3285),  # Návarov most (serpentiny)
            (50.7012, 15.3510),  # Zlatá Olešnice
        ],
        "base_alt": 340.0,
        "alt_profile": [
            (0.0, 320.0), (0.25, 430.0), (0.45, 315.0), (0.52, 310.0),
            (0.70, 485.0), (0.74, 490.0), (0.80, 455.0), (1.0, 520.0)
        ]
    },
    {
        "id": "rz_sumava_korab",
        "name": "RZ3 Rallye Šumava Klatovy – Koráb (Kdyně – Koráb – Mezholezy)",
        "region": "Plzeňský kraj (Rallye Šumava Klatovy)",
        "waypoints": [
            (49.3935, 13.0485),  # Kdyně
            (49.3968, 13.0745),  # Koráb vrchol (serpentiny)
            (49.4095, 13.0990),  # Mezholezy
        ],
        "base_alt": 460.0,
        "alt_profile": [
            (0.0, 455.0), (0.30, 590.0), (0.55, 745.0), (0.59, 752.0),
            (0.65, 705.0), (0.85, 580.0), (1.0, 515.0)
        ]
    }
]

def interpolate_altitude(progress, profile):
    """Plynulá interpolace nadmořské výšky s realistickými horizonty (hřebeny)."""
    for i in range(len(profile) - 1):
        p0, a0 = profile[i]
        p1, a1 = profile[i + 1]
        if p0 <= progress <= p1:
            t = (progress - p0) / max(1e-6, (p1 - p0))
            # Smoothstep + drobná terénní vlna pro realistické horizonty
            smooth_t = t * t * (3 - 2 * t)
            base = a0 + (a1 - a0) * smooth_t
            crest_wave = 4.5 * math.sin(progress * math.pi * 14.0) * math.exp(-((progress - 0.5) ** 2) * 4)
            return round(base + crest_wave, 1)
    return profile[-1][1]

def fetch_osrm_route(waypoints):
    """Stáhne reálnou geometrii silnice z OSRM API."""
    coords_str = ";".join(f"{lon},{lat}" for lat, lon in waypoints)
    url = f"https://router.project-osrm.org/route/v1/driving/{coords_str}?overview=full&geometries=geojson"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ApexNotes-Rally-Generator/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") == "Ok" and data["routes"]:
                coords = data["routes"][0]["geometry"]["coordinates"]
                return [(lat, lon) for lon, lat in coords]
    except Exception as e:
        print(f"OSRM fallback ({e}) - generuji přesnou syntetickou rally geometrii.")
    return None

def generate_fallback_rally_geometry(stage):
    """Záložní generátor realistické horské RZ s vracáky, esíčky a rovinkami."""
    lat0, lon0 = stage["waypoints"][0]
    points = []
    lat, lon = lat0, lon0
    heading = 0.45
    # Sekvence segmentů: (délka_m, změna_kurzu_rad)
    segments = [
        (160, 0.0), (55, 0.65), (90, 0.0), (45, -1.15), (140, 0.0),
        (35, 2.35), (110, 0.0), (70, -0.85), (40, -0.95), (210, 0.0),
        (50, 1.45), (80, 0.0), (30, -2.55), (175, 0.0), (65, 0.55),
        (120, 0.0), (45, -1.30), (150, 0.0)
    ]
    step_m = 4.0
    for seg_len, d_heading in segments:
        steps = max(2, int(seg_len / step_m))
        for s in range(steps):
            heading += d_heading / steps
            dlat = (step_m * math.cos(heading)) / 111320.0
            dlon = (step_m * math.sin(heading)) / (111320.0 * math.cos(math.radians(lat)))
            lat += dlat
            lon += dlon
            points.append((lat, lon))
    return points

def save_gpx(filepath, stage, coords):
    """Uloží body do standardního GPX 1.1 souboru s nadmořskou výškou."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    start_time = datetime(2026, 11, 1, 9, 0, 0)
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="ApexNotes GPX Generator" xmlns="http://www.topografix.com/GPX/1/1">',
        '  <metadata>',
        f'    <name>{stage["name"]}</name>',
        f'    <desc>{stage["region"]} - Testovací trať pro ApexNotes</desc>',
        '  </metadata>',
        '  <trk>',
        f'    <name>{stage["name"]}</name>',
        '    <trkseg>'
    ]
    n = max(1, len(coords) - 1)
    for i, (lat, lon) in enumerate(coords):
        progress = i / n
        ele = interpolate_altitude(progress, stage["alt_profile"])
        t_str = (start_time + timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        lines.append(f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">')
        lines.append(f'        <ele>{ele:.1f}</ele>')
        lines.append(f'        <time>{t_str}</time>')
        lines.append('      </trkpt>')
    lines.extend([
        '    </trkseg>',
        '  </trk>',
        '</gpx>'
    ])
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

def main():
    out_dir = os.path.join(os.path.dirname(__file__), "data", "gpx")
    os.makedirs(out_dir, exist_ok=True)
    for stage in STAGES:
        coords = fetch_osrm_route(stage["waypoints"])
        source = "OSRM reálná silniční data"
        if not coords or len(coords) < 20:
            coords = generate_fallback_rally_geometry(stage)
            source = "syntetická horská RZ"
        filepath = os.path.join(out_dir, f"{stage['id']}.gpx")
        save_gpx(filepath, stage, coords)
        print(f"[OK] {stage['id']}.gpx ({len(coords)} bodů, zdroj: {source}) -> {filepath}")

if __name__ == "__main__":
    main()
