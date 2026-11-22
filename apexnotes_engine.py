"""
ApexNotes – Fáze 2: Geometrický algoritmus pro automatický výpočet rally rozpisu (Pacenotes)
Autor: Michael Dluhoš

Tento modul implementuje kompletní Fázi 2 podle harmonogramu:
1. Načtení GPX/KML trasy a převod (lat, lon, ele) do lokálních metrických souřadnic (x, y, z).
2. Interpolace a vyhlazení pomocí Catmull-Rom spline filtru s rovnoměrným vzorkováním po 2.5 m.
3. Výpočet Mengerovy křivosti (poloměr R ze 3 bodů) a 2D vektorového součinu pro určení směru (Levá / Pravá).
4. Analýza výškového profilu (DEM / ele) a detekce slepých horizontů, prudkých stoupání a klesání.
5. Mapování na český rally slang (stupnice 1–6, utahuje/otevírá, dlouhá, rovinky po desítkách metrů) a export do JSON/TXT.
"""

import os
import json
import math
import glob
import xml.etree.ElementTree as ET
from typing import List, Dict, Tuple, Any

# Konstanta poloměru Země v metrech
EARTH_RADIUS_M = 6371000.0


def parse_gpx(filepath: str) -> Tuple[str, List[Dict[str, float]]]:
    """Načte GPX soubor a vrátí název trati a seznam bodů [{'lat', 'lon', 'ele'}]."""
    tree = ET.parse(filepath)
    root = tree.getroot()
    ns = {"gpx": "http://www.topografix.com/GPX/1/1"}

    name_el = root.find(".//gpx:trk/gpx:name", ns) or root.find(".//gpx:metadata/gpx:name", ns)
    if name_el is None:
        # Fallback bez namespace
        for el in root.iter():
            if el.tag.endswith("name") and el.text:
                name_el = el
                break
    track_name = name_el.text.strip() if (name_el is not None and name_el.text) else os.path.basename(filepath)

    raw_points = []
    for pt in root.iter():
        if pt.tag.endswith("trkpt") or pt.tag.endswith("rtept"):
            lat = float(pt.attrib["lat"])
            lon = float(pt.attrib["lon"])
            ele = 300.0
            for child in pt:
                if child.tag.endswith("ele") and child.text:
                    ele = float(child.text)
            raw_points.append({"lat": lat, "lon": lon, "ele": ele})

    return track_name, raw_points


def gps_to_local_xy(points: List[Dict[str, float]]) -> List[Dict[str, float]]:
    """Převede GPS souřadnice (lat, lon, ele) na lokální kartézské souřadnice (x, y, z) v metrech."""
    if not points:
        return []
    lat0 = math.radians(points[0]["lat"])
    lon0 = math.radians(points[0]["lon"])
    cos_lat0 = math.cos(lat0)

    local_pts = []
    total_dist = 0.0
    for i, p in enumerate(points):
        lat_rad = math.radians(p["lat"])
        lon_rad = math.radians(p["lon"])
        x = (lon_rad - lon0) * cos_lat0 * EARTH_RADIUS_M
        y = (lat_rad - lat0) * EARTH_RADIUS_M
        z = p.get("ele", 300.0)

        if local_pts:
            dx = x - local_pts[-1]["x"]
            dy = y - local_pts[-1]["y"]
            step = math.hypot(dx, dy)
            if step < 0.2:
                continue  # Odfiltrujeme duplicitní body na stejném místě
            total_dist += step

        local_pts.append({
            "lat": p["lat"],
            "lon": p["lon"],
            "x": x,
            "y": y,
            "z": z,
            "s": total_dist
        })
    return local_pts


def catmull_rom_point(p0: Dict[str, float], p1: Dict[str, float], p2: Dict[str, float], p3: Dict[str, float], t: float) -> Dict[str, float]:
    """Vypočítá bod na kubické Catmull-Rom spline křivce pro parametr t v [0, 1]."""
    t2 = t * t
    t3 = t2 * t

    def interp(k: str) -> float:
        v0, v1, v2, v3 = p0[k], p1[k], p2[k], p3[k]
        return 0.5 * (
            (2.0 * v1)
            + (-v0 + v2) * t
            + (2.0 * v0 - 5.0 * v1 + 4.0 * v2 - v3) * t2
            + (-v0 + 3.0 * v1 - 3.0 * v2 + v3) * t3
        )

    return {
        "lat": interp("lat"),
        "lon": interp("lon"),
        "x": interp("x"),
        "y": interp("y"),
        "z": interp("z")
    }


def resample_and_smooth_spline(local_pts: List[Dict[str, float]], step_m: float = 2.5) -> List[Dict[str, float]]:
    """
    1. Vyhladí a převzorkuje trasu pomocí Catmull-Rom spline po pevném kroku step_m (2.5 m).
    2. Aplikuje klouzavý gaussovský průměr pro odstranění GPS šumu.
    """
    if len(local_pts) < 4:
        return local_pts

    # Nejprve vygenerujeme hustou spline křivku
    dense_pts = [local_pts[0]]
    n = len(local_pts)
    for i in range(n - 1):
        p0 = local_pts[max(0, i - 1)]
        p1 = local_pts[i]
        p2 = local_pts[min(n - 1, i + 1)]
        p3 = local_pts[min(n - 1, i + 2)]

        seg_len = math.hypot(p2["x"] - p1["x"], p2["y"] - p1["y"])
        subdivisions = max(1, int(math.ceil(seg_len / 1.0)))
        for s in range(1, subdivisions + 1):
            t = s / subdivisions
            pt = catmull_rom_point(p0, p1, p2, p3, t)
            dense_pts.append(pt)

    # Nyní převzorkujeme přesně po step_m (2.5 m)
    resampled = [dict(dense_pts[0], s=0.0)]
    accum = 0.0
    next_target = step_m
    total_s = 0.0

    for i in range(1, len(dense_pts)):
        prev = dense_pts[i - 1]
        curr = dense_pts[i]
        dx = curr["x"] - prev["x"]
        dy = curr["y"] - prev["y"]
        d = math.hypot(dx, dy)
        if d < 1e-6:
            continue

        while accum + d >= next_target:
            ratio = (next_target - accum) / d
            new_pt = {
                "lat": prev["lat"] + ratio * (curr["lat"] - prev["lat"]),
                "lon": prev["lon"] + ratio * (curr["lon"] - prev["lon"]),
                "x": prev["x"] + ratio * dx,
                "y": prev["y"] + ratio * dy,
                "z": prev["z"] + ratio * (curr["z"] - prev["z"]),
                "s": next_target
            }
            resampled.append(new_pt)
            next_target += step_m
        accum += d

    # Lehké vyhlazení souřadnic (Gaussian-like okno) pro eliminaci lokálního kmitání
    smoothed = []
    weights = [0.1, 0.2, 0.4, 0.2, 0.1]
    m = len(resampled)
    for i in range(m):
        sx = sy = sz = slat = slon = 0.0
        for offset, w in zip([-2, -1, 0, 1, 2], weights):
            idx = min(m - 1, max(0, i + offset))
            sx += resampled[idx]["x"] * w
            sy += resampled[idx]["y"] * w
            sz += resampled[idx]["z"] * w
            slat += resampled[idx]["lat"] * w
            slon += resampled[idx]["lon"] * w
        smoothed.append({
            "lat": slat,
            "lon": slon,
            "x": sx,
            "y": sy,
            "z": sz,
            "s": resampled[i]["s"]
        })

    return smoothed


def compute_menger_curvature_and_elevation(pts: List[Dict[str, float]], window_offset: int = 4) -> List[Dict[str, float]]:
    """
    Pro každý bod na trati spočítá:
    - Mengerovu křivost kappa = 4*A / (|ab|*|bc|*|ca|) ze 3 bodů (i - w, i, i + w)
    - Poloměr zatáčky R = 1 / kappa (v metrech)
    - Směr zatáčky pomocí 2D vektorového součinu: cross > 0 => LEVÁ ('L'), cross < 0 => PRAVÁ ('P')
    - Podélný sklon vozovky (grade_pct) a změnu sklonu (crest_index) pro detekci horizontů
    """
    n = len(pts)
    w = window_offset  # při kroku 2.5 m je w=4 -> chord ~ 10 m na každou stranu (20 m okno)

    for i in range(n):
        i_prev = max(0, i - w)
        i_next = min(n - 1, i + w)
        p1, p2, p3 = pts[i_prev], pts[i], pts[i_next]

        # Vektory p1->p2 a p2->p3
        v1x, v1y = p2["x"] - p1["x"], p2["y"] - p1["y"]
        v2x, v2y = p3["x"] - p2["x"], p3["y"] - p2["y"]

        a = math.hypot(v1x, v1y)
        b = math.hypot(v2x, v2y)
        c = math.hypot(p3["x"] - p1["x"], p3["y"] - p1["y"])

        # 2D vektorový součin: v1 x v2 = v1x*v2y - v1y*v2x
        # V kartézské soustavě (x=Východ, y=Sever):
        # Kladný vektorový součin znamená stáčení doleva (proti směru hodinových ručiček),
        # Záporný vektorový součin znamená stáčení doprava (po směru hodinových ručiček).
        cross = v1x * v2y - v1y * v2x
        area2 = abs(cross)  # 2 * obsah trojúhelníku

        if a * b * c < 1e-5 or area2 < 1e-5:
            kappa = 0.0
            radius = 9999.0
            direction = "S"
        else:
            # Mengerova křivost: kappa = 4 * Area / (a * b * c) = 2 * area2 / (a * b * c)
            kappa = (2.0 * area2) / (a * b * c)
            radius = min(9999.0, 1.0 / max(1e-6, kappa))
            direction = "L" if cross > 0 else "P"

        # Výpočet podélného sklonu a zlomu horizontu (DEM analýza)
        ds_back = max(1.0, p2["s"] - p1["s"])
        ds_fwd = max(1.0, p3["s"] - p2["s"])
        grade_in = ((p2["z"] - p1["z"]) / ds_back) * 100.0   # v %
        grade_out = ((p3["z"] - p2["z"]) / ds_fwd) * 100.0   # v %
        # Záporná změna sklonu (ze stoupání do klesání) indikuje horizont (crest)
        grade_change = grade_out - grade_in

        pts[i]["kappa"] = kappa
        pts[i]["radius"] = round(radius, 1)
        pts[i]["dir"] = direction
        pts[i]["grade_pct"] = round(0.5 * (grade_in + grade_out), 1)
        pts[i]["grade_change"] = round(grade_change, 2)

    return pts


def radius_to_czech_severity(r: float) -> int:
    """
    Převede minimální poloměr zatáčky R (v metrech) na českou rally stupnici 1–6:
    1 = nejostřejší (vracák), 6 = nejrychlejší, 0 = rovinka.
    """
    if r < 22.0:
        return 1
    elif r < 38.0:
        return 2
    elif r < 62.0:
        return 3
    elif r < 98.0:
        return 4
    elif r < 155.0:
        return 5
    elif r <= 240.0:
        return 6
    return 0


SEVERITY_WORDS_CZ = {
    1: "jedna",
    2: "dva",
    3: "tři",
    4: "čtyři",
    5: "pět",
    6: "šest"
}


def round_straight_distance(dist_m: float) -> int:
    """Zaokrouhlí délku rovinky podle zvyklostí českých spolujezdců (30, 40, 50, 60, 80, 100, 150, 200...)."""
    if dist_m < 25:
        return 0
    if dist_m < 100:
        return int(round(dist_m / 10.0) * 10)
    if dist_m < 300:
        return int(round(dist_m / 20.0) * 20)
    return int(round(dist_m / 50.0) * 50)


def extract_pacenotes(pts: List[Dict[str, float]]) -> List[Dict[str, Any]]:
    """
    Segmentuje trať na jednotlivé zatáčky, horizonty a rovinky a generuje český rally rozpis.
    """
    CORNER_MAX_R = 235.0
    MIN_CORNER_LEN_M = 12.0

    raw_corners = []
    in_corner = False
    curr_pts = []
    curr_dir = None

    for pt in pts:
        is_curved = pt["radius"] <= CORNER_MAX_R
        if is_curved:
            if not in_corner:
                in_corner = True
                curr_dir = pt["dir"]
                curr_pts = [pt]
            elif pt["dir"] == curr_dir:
                curr_pts.append(pt)
            else:
                # Okamžitá změna směru (esíčko L -> P nebo P -> L)
                if (curr_pts[-1]["s"] - curr_pts[0]["s"]) >= MIN_CORNER_LEN_M:
                    raw_corners.append((curr_dir, curr_pts))
                curr_dir = pt["dir"]
                curr_pts = [pt]
        else:
            if in_corner:
                if (curr_pts[-1]["s"] - curr_pts[0]["s"]) >= MIN_CORNER_LEN_M:
                    raw_corners.append((curr_dir, curr_pts))
                in_corner = False
                curr_pts = []

    if in_corner and curr_pts and (curr_pts[-1]["s"] - curr_pts[0]["s"]) >= MIN_CORNER_LEN_M:
        raw_corners.append((curr_dir, curr_pts))

    # Sloučení stejnosměrných zatáček, které jsou od sebe méně než 15 m
    merged_corners = []
    for c_dir, c_pts in raw_corners:
        if merged_corners:
            prev_dir, prev_pts = merged_corners[-1]
            gap = c_pts[0]["s"] - prev_pts[-1]["s"]
            if prev_dir == c_dir and gap < 15.0:
                merged_corners[-1] = (prev_dir, prev_pts + c_pts)
                continue
        merged_corners.append((c_dir, c_pts))

    pacenotes = []
    prev_end_s = 0.0

    for idx, (c_dir, c_pts) in enumerate(merged_corners):
        start_s = c_pts[0]["s"]
        end_s = c_pts[-1]["s"]
        length_m = end_s - start_s

        # Apex (bod s nejmenším poloměrem)
        apex_pt = min(c_pts, key=lambda p: p["radius"])
        min_r = apex_pt["radius"]
        severity = radius_to_czech_severity(min_r)
        if severity == 0:
            continue

        # Detekce utahování / otevírání (porovnání 1. a 2. poloviny zatáčky)
        half = max(1, len(c_pts) // 2)
        r_first = min(p["radius"] for p in c_pts[:half])
        r_second = min(p["radius"] for p in c_pts[half:])
        sev_first = radius_to_czech_severity(r_first) or severity
        sev_second = radius_to_czech_severity(r_second) or severity

        modifier = ""
        sub_call = ""
        if length_m >= 30.0 and sev_second < sev_first and (sev_first - sev_second) >= 1:
            # Druhá polovina je ostřejší -> zatáčka utahuje!
            severity = sev_first
            modifier = "utahuje"
            if sev_first - sev_second >= 2:
                sub_call = f"do {SEVERITY_WORDS_CZ[sev_second]}"
        elif length_m >= 35.0 and sev_second > sev_first and (sev_second - sev_first) >= 1:
            severity = sev_first
            modifier = "otevírá"

        is_long = length_m >= 65.0
        is_hairpin = severity == 1 and length_m >= 22.0

        # Detekce horizontu nebo klesání/stoupání v zatáčce
        min_grade_change = min(p["grade_change"] for p in c_pts)
        max_grade = max(abs(p["grade_pct"]) for p in c_pts)
        has_crest = min_grade_change <= -3.8

        # Vzdálenost od předchozí zatáčky
        straight_before = max(0.0, start_s - prev_end_s)
        rounded_straight = round_straight_distance(straight_before)

        # Pokud je před zatáčkou dlouhá rovinka, přidáme samostatnou hlášku rovinky nebo horizontu
        if rounded_straight >= 40:
            pacenotes.append({
                "id": len(pacenotes) + 1,
                "type": "straight",
                "dir": "S",
                "severity": 0,
                "distance_m": round(prev_end_s + 5.0, 1),
                "end_distance_m": round(start_s, 1),
                "length_m": rounded_straight,
                "radius_m": 999.0,
                "lat": c_pts[0]["lat"],
                "lon": c_pts[0]["lon"],
                "ele": round(c_pts[0]["z"], 1),
                "short_label": f"↑ {rounded_straight} m",
                "call_cz": f"Dále {rounded_straight}",
                "audio_tokens": [f"dist_{min(200, rounded_straight)}"]
            })

        # Sestavení českého hlasového povelu (slang českých spolujezdců)
        dir_word = "Levá" if c_dir == "L" else "Pravá"
        sev_word = SEVERITY_WORDS_CZ[severity]
        parts = [f"{dir_word} {sev_word}"]
        tokens = [f"{c_dir}{severity}"]

        if is_hairpin:
            parts.append("vracák")
            tokens.append("vracak")
        elif is_long:
            parts.append("dlouhá")
            tokens.append("dlouha")

        if modifier:
            parts.append(modifier)
            tokens.append("utahuje" if modifier == "utahuje" else "otevira")
            if sub_call:
                parts.append(sub_call)

        if has_crest:
            parts.append("přes horizont")
            tokens.append("horizont")

        # Navázání na další zatáčku ("do...")
        if idx + 1 < len(merged_corners):
            next_start = merged_corners[idx + 1][1][0]["s"]
            if (next_start - end_s) < 25.0:
                parts.append("do")
                tokens.append("do")

        call_cz = " ".join(parts)
        short_label = f"{c_dir}{severity}" + ("!" if modifier == "utahuje" or is_hairpin else "")

        pacenotes.append({
            "id": len(pacenotes) + 1,
            "type": "corner",
            "dir": c_dir,
            "severity": severity,
            "modifier": modifier,
            "is_long": is_long,
            "is_hairpin": is_hairpin,
            "has_crest": has_crest,
            "distance_m": round(start_s, 1),
            "apex_distance_m": round(apex_pt["s"], 1),
            "end_distance_m": round(end_s, 1),
            "length_m": round(length_m, 1),
            "radius_m": round(min_r, 1),
            "grade_pct": apex_pt["grade_pct"],
            "lat": round(apex_pt["lat"], 6),
            "lon": round(apex_pt["lon"], 6),
            "ele": round(apex_pt["z"], 1),
            "short_label": short_label,
            "call_cz": call_cz,
            "audio_tokens": tokens
        })

        prev_end_s = end_s

    return pacenotes


def analyze_gpx_file(filepath: str) -> Dict[str, Any]:
    """Kompletní pipeline Fáze 2 pro jeden GPX soubor."""
    track_name, raw_pts = parse_gpx(filepath)
    local_pts = gps_to_local_xy(raw_pts)
    smoothed_pts = resample_and_smooth_spline(local_pts, step_m=2.5)
    analyzed_pts = compute_menger_curvature_and_elevation(smoothed_pts, window_offset=4)
    pacenotes = extract_pacenotes(analyzed_pts)

    total_length_m = analyzed_pts[-1]["s"] if analyzed_pts else 0.0
    elevations = [p["z"] for p in analyzed_pts] if analyzed_pts else [0.0]

    # Zjednodušená geometrie trati pro rychlé vykreslení v PWA aplikaci (každý 2. bod = po 5 m)
    track_geometry = [
        {
            "lat": round(p["lat"], 6),
            "lon": round(p["lon"], 6),
            "ele": round(p["z"], 1),
            "s": round(p["s"], 1),
            "r": p["radius"],
            "dir": p["dir"]
        }
        for i, p in enumerate(analyzed_pts) if i % 2 == 0 or i == len(analyzed_pts) - 1
    ]

    stage_id = os.path.splitext(os.path.basename(filepath))[0]
    return {
        "id": stage_id,
        "name": track_name,
        "total_length_m": round(total_length_m, 1),
        "total_length_km": round(total_length_m / 1000.0, 2),
        "min_ele_m": round(min(elevations), 1),
        "max_ele_m": round(max(elevations), 1),
        "corners_count": sum(1 for n in pacenotes if n["type"] == "corner"),
        "pacenotes": pacenotes,
        "geometry": track_geometry
    }


def main():
    base_dir = os.path.dirname(__file__)
    gpx_dir = os.path.join(base_dir, "data", "gpx")
    out_dir = os.path.join(base_dir, "data", "pacenotes")
    pwa_data_dir = os.path.join(base_dir, "pwa", "data")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(pwa_data_dir, exist_ok=True)

    gpx_files = sorted(glob.glob(os.path.join(gpx_dir, "*.gpx")))
    if not gpx_files:
        print("Žádné GPX soubory nenalezeny! Spusťte nejprve fetch_test_gpx.py.")
        return

    all_stages = []
    print("=" * 72)
    print("APEXNOTES - FÁZE 2: GEOMETRICKÝ ALGORITMUS (MENGEROVA KŘIVOST & SPLINE)")
    print("=" * 72)

    for gpx_path in gpx_files:
        result = analyze_gpx_file(gpx_path)
        all_stages.append(result)

        # Uložení JSON rozpisu
        json_path = os.path.join(out_dir, f"{result['id']}_pacenotes.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        # Uložení čitelného TXT rozpisu pro kontrolu a dokumentaci
        txt_path = os.path.join(out_dir, f"{result['id']}_rozpis.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(f"ZÁVODNÍ ROZPIS (PACENOTES) - {result['name']}\n")
            f.write(f"Délka tratě: {result['total_length_km']} km ({result['total_length_m']} m) | ")
            f.write(f"Nadmořská výška: {result['min_ele_m']} - {result['max_ele_m']} m n. m. | ")
            f.write(f"Počet zatáček: {result['corners_count']}\n")
            f.write("-" * 72 + "\n")
            for note in result["pacenotes"]:
                dist_str = f"[{note['distance_m']:6.1f} m]"
                if note["type"] == "corner":
                    f.write(f"{dist_str}  {note['short_label']:4s} | {note['call_cz']:35s} (R={note['radius_m']} m, d={note['length_m']} m)\n")
                else:
                    f.write(f"{dist_str}   ↑   | {note['call_cz']}\n")

        print(f"\n[TRAŤ] {result['name']}")
        print(f"       Délka: {result['total_length_km']} km | Zatáček: {result['corners_count']} | Celkem povelů: {len(result['pacenotes'])}")
        print("       Ukázka prvních 6 povelů rozpisu:")
        for note in result["pacenotes"][:6]:
            print(f"         • {note['distance_m']:6.1f} m -> {note['call_cz']} (R={note['radius_m']} m)")

    # Uložení spojeného souboru pro offline PWA aplikaci
    stages_bundle_path = os.path.join(pwa_data_dir, "stages.js")
    with open(stages_bundle_path, "w", encoding="utf-8") as f:
        f.write("// Automaticky generováno Python algoritmem ApexNotes (Fáze 2)\n")
        f.write("window.APEXNOTES_STAGES = ")
        json.dump(all_stages, f, ensure_ascii=False)
        f.write(";\n")

    print("\n" + "=" * 72)
    print(f"[HOTOVO] Rozpisy uloženy do: {out_dir}")
    print(f"[HOTOVO] Offline datový balíček pro PWA uložen do: {stages_bundle_path}")


if __name__ == "__main__":
    main()
