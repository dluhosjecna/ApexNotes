"""
ApexNotes – Generátor offline české audio banky (Fáze 3)
Vygeneruje sadu 40+ zvukových vzorků ve složce pwa/audio/ + přehledový katalog audio_bank.json.
"""

import os
import json
import math
import wave
import struct

AUDIO_SAMPLES = {
    # Pravé zatáčky 1-6
    "P1": {"text": "Pravá jedna", "freq": 520, "beeps": 2},
    "P2": {"text": "Pravá dva", "freq": 480, "beeps": 2},
    "P3": {"text": "Pravá tři", "freq": 440, "beeps": 1},
    "P4": {"text": "Pravá čtyři", "freq": 400, "beeps": 1},
    "P5": {"text": "Pravá pět", "freq": 360, "beeps": 1},
    "P6": {"text": "Pravá šest", "freq": 330, "beeps": 1},
    # Levé zatáčky 1-6
    "L1": {"text": "Levá jedna", "freq": 520, "beeps": 2},
    "L2": {"text": "Levá dva", "freq": 480, "beeps": 2},
    "L3": {"text": "Levá tři", "freq": 440, "beeps": 1},
    "L4": {"text": "Levá čtyři", "freq": 400, "beeps": 1},
    "L5": {"text": "Levá pět", "freq": 360, "beeps": 1},
    "L6": {"text": "Levá šest", "freq": 330, "beeps": 1},
    # Modifikátory a varování
    "vracak": {"text": "Vracák", "freq": 660, "beeps": 3},
    "utahuje": {"text": "Utahuje", "freq": 580, "beeps": 2},
    "otevira": {"text": "Otevírá", "freq": 350, "beeps": 1},
    "dlouha": {"text": "Dlouhá", "freq": 380, "beeps": 1},
    "horizont": {"text": "Přes horizont", "freq": 620, "beeps": 2},
    "pozor_horizont": {"text": "Pozor horizont", "freq": 700, "beeps": 3},
    "do": {"text": "Do", "freq": 420, "beeps": 1},
    "nebe": {"text": "Nebe", "freq": 640, "beeps": 2},
    "brzda": {"text": "Brzda!", "freq": 750, "beeps": 3},
    "klouze": {"text": "Klouže", "freq": 600, "beeps": 2},
    "nekatovat": {"text": "Nekatovat", "freq": 610, "beeps": 2},
    "katovat": {"text": "Katovat", "freq": 370, "beeps": 1},
    "uzke": {"text": "Úzké", "freq": 560, "beeps": 2},
    "mostek": {"text": "Můstek", "freq": 590, "beeps": 2},
    "skok": {"text": "Skok", "freq": 680, "beeps": 2},
    # Metráže / rovinky
    "dist_30": {"text": "Třicet", "freq": 310, "beeps": 1},
    "dist_40": {"text": "Čtyřicet", "freq": 310, "beeps": 1},
    "dist_50": {"text": "Padesát", "freq": 310, "beeps": 1},
    "dist_60": {"text": "Šedesát", "freq": 310, "beeps": 1},
    "dist_80": {"text": "Osmdesát", "freq": 310, "beeps": 1},
    "dist_100": {"text": "Sto", "freq": 300, "beeps": 1},
    "dist_120": {"text": "Sto dvacet", "freq": 300, "beeps": 1},
    "dist_150": {"text": "Sto padesát", "freq": 300, "beeps": 1},
    "dist_200": {"text": "Dvě stě", "freq": 290, "beeps": 1},
    "dist_250": {"text": "Dvě stě padesát", "freq": 290, "beeps": 1},
    "dist_300": {"text": "Tři sta", "freq": 280, "beeps": 1},
    "dist_400": {"text": "Čtyři sta", "freq": 280, "beeps": 1},
    "dist_500": {"text": "Pět set", "freq": 280, "beeps": 1},
    # Start / Cíl
    "start_54321": {"text": "Pět, čtyři, tři, dva, jedna, start!", "freq": 880, "beeps": 3},
    "cil": {"text": "Cíl rychlostní zkoušky", "freq": 500, "beeps": 2}
}


def write_cue_wav(filepath: str, freq: float, beeps: int):
    """Vytvoří krátký čistý WAV akustický signál (rally intercom cue) před hlasovým povelem."""
    sample_rate = 22050
    duration_s = 0.14 * beeps
    n_samples = int(sample_rate * duration_s)

    with wave.open(filepath, "w") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)

        frames = bytearray()
        for i in range(n_samples):
            t = i / sample_rate
            beep_idx = int(t / 0.14)
            local_t = t - beep_idx * 0.14
            if local_t < 0.09:
                env = math.sin((local_t / 0.09) * math.pi)
                f = freq * (1.0 + 0.08 * beep_idx)
                val = int(12000 * env * math.sin(2.0 * math.pi * f * local_t))
            else:
                val = 0
            frames.extend(struct.pack("<h", val))
        wav_file.writeframes(frames)


def main():
    audio_dir = os.path.join(os.path.dirname(__file__), "pwa", "audio")
    os.makedirs(audio_dir, exist_ok=True)

    catalog = {}
    for code, info in AUDIO_SAMPLES.items():
        filename = f"{code}.wav"
        filepath = os.path.join(audio_dir, filename)
        write_cue_wav(filepath, info["freq"], info["beeps"])
        catalog[code] = {
            "code": code,
            "text_cz": info["text"],
            "file": f"audio/{filename}",
            "freq": info["freq"],
            "beeps": info["beeps"]
        }

    with open(os.path.join(audio_dir, "audio_bank.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    print(f"[OK] Vygenerováno {len(catalog)} zvukových souborů v: {audio_dir}")


if __name__ == "__main__":
    main()
