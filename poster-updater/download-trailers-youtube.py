#!/usr/bin/env python3
"""
Posterrama YouTube Trailer Downloader
Sucht Trailer direkt auf YouTube (ohne TMDB) fuer Filme die noch keinen Trailer haben.
Sprache: Deutsch bevorzugt, Englisch als Fallback.
Aufloesung: Max. Full-HD (1080p).
Ausgabe: media/trailers/Film (Jahr)-trailer.mp4
"""

import os
import sys
import re
import json
import time
import unicodedata
import yt_dlp

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
TRAILER_DIR = os.path.join(PROJECT_ROOT, 'media', 'trailers')
COMPLETE_DIR = os.path.join(PROJECT_ROOT, 'media', 'complete')
TRAILER_INFO_PATH = os.path.join(TRAILER_DIR, 'trailer-info.json')

os.makedirs(TRAILER_DIR, exist_ok=True)

print("""
**************************************************************
*  Posterrama YouTube Trailer Downloader                     *
*  Direkte YouTube-Suche (ohne TMDB)                         *
*  Deutsch bevorzugt, max. Full-HD                           *
**************************************************************
""")

# --- trailer-info.json laden ---
trailer_info = {}
try:
    with open(TRAILER_INFO_PATH, 'r', encoding='utf-8') as f:
        trailer_info = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    pass

# --- Alle PosterPacks finden ---
all_zips = set()
for root, dirs, files in os.walk(COMPLETE_DIR):
    for f in files:
        if f.lower().endswith('.zip') and not f.startswith('._'):
            all_zips.add(unicodedata.normalize('NFC', f.replace('.zip', '').replace('.ZIP', '')))

# --- Vorhandene Trailer finden ---
existing_trailers = set()
for f in os.listdir(TRAILER_DIR):
    if f.endswith('-trailer.mp4') and os.path.getsize(os.path.join(TRAILER_DIR, f)) > 100000:
        existing_trailers.add(unicodedata.normalize('NFC', f.replace('-trailer.mp4', '')))

# --- Fehlende Trailer ermitteln ---
missing = sorted([z for z in all_zips if unicodedata.normalize('NFC', z) not in existing_trailers])

print(f"  PosterPacks gesamt: {len(all_zips)}")
print(f"  Trailer vorhanden:  {len(existing_trailers)}")
print(f"  Ohne Trailer:       {len(missing)}")

if not missing:
    print("\n  Alle Filme haben bereits Trailer. Nichts zu tun.")
    sys.exit(0)

print(f"\n  Starte YouTube-Suche fuer {len(missing)} Filme...\n")


def extract_title_year(name):
    """Extrahiert Titel und Jahr aus 'Film Title (2024)' oder 'Film Title (2024)[tmdb:NNN]'.
    Patch 51-kompatibel: optionaler [tmdb:NNN]-Suffix wird vor dem Match abgestrippt."""
    # Strippe optionalen TMDB-Hint
    hint_m = re.match(r'^(.+?)\s*\[tmdb:\d+\]\s*$', name)
    if hint_m:
        name = hint_m.group(1).strip()
    m = re.match(r'^(.+?)\s*\((\d{4})\)\s*$', name)
    if m:
        return m.group(1).strip(), m.group(2)
    return name, None


def search_youtube(query, max_results=5):
    """Sucht auf YouTube und gibt eine Liste von Video-Infos zurueck."""
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'ignoreerrors': True,
        'extract_flat': 'in_playlist',
        'playlist_items': f'1-{max_results}',
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            result = ydl.extract_info(f'ytsearch{max_results}:{query}', download=False)
            if result and 'entries' in result:
                return [e for e in result['entries'] if e]
    except Exception:
        pass
    return []


def find_best_trailer_url(title, year):
    """
    Sucht auf YouTube nach dem besten Trailer.
    Prioritaet: Deutsch > Englisch
    Gibt (url, label) zurueck.
    """
    search_queries = [
        (f'{title} {year} Trailer Deutsch', True),
        (f'{title} {year} Trailer German', True),
        (f'{title} Trailer Deutsch', True),
        (f'{title} {year} Official Trailer', False),
        (f'{title} {year} Trailer', False),
    ]

    for query, is_de_search in search_queries:
        results = search_youtube(query, max_results=5)
        for video in results:
            vid_title = (video.get('title') or '').lower()
            vid_id = video.get('id')
            if not vid_id:
                continue

            # Filter: muss "trailer" im Titel haben
            if 'trailer' not in vid_title:
                continue

            # Laenge filtern: Trailer sind typischerweise 20s - 5min
            duration = video.get('duration')
            if duration and (duration < 20 or duration > 600):
                continue

            vid_url = f'https://www.youtube.com/watch?v={vid_id}'

            # Label bestimmen
            is_official = any(kw in vid_title for kw in ['official', 'offiziell', 'offizieller'])
            is_german = any(kw in vid_title for kw in ['deutsch', 'german'])

            if is_german or is_de_search:
                label = 'DE-offiziell' if is_official else 'DE'
            else:
                label = 'EN-offiziell' if is_official else 'EN'

            return vid_url, label

    return None, None


def download_trailer(url, output_path):
    """Laedt YouTube-Video als MP4 herunter, max. 1080p."""
    ydl_opts = {
        'format': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]',
        'outtmpl': output_path,
        'merge_output_format': 'mp4',
        'quiet': True,
        'no_warnings': True,
        'noprogress': True,
        'socket_timeout': 30,
        'retries': 3,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        return True
    except Exception as e:
        print(f"      yt-dlp Fehler: {e}")
        return False


# --- Hauptschleife ---
erfolg = 0
kein_trailer = 0
fehler = 0

for i, name in enumerate(missing, 1):
    title, year = extract_title_year(name)
    if not year:
        print(f"   ⚠️  [{i}/{len(missing)}] {name} — kein Jahr erkannt")
        fehler += 1
        continue

    name = unicodedata.normalize('NFC', name)
    trailer_path = os.path.join(TRAILER_DIR, f"{name}-trailer.mp4")

    # YouTube-Suche
    url, lang = find_best_trailer_url(title, year)
    if not url:
        print(f"   ⚠️  [{i}/{len(missing)}] {name} — kein Trailer auf YouTube")
        kein_trailer += 1
        continue

    # Download
    print(f"   ⬇️  [{i}/{len(missing)}] {name} ({lang}) ...", end='', flush=True)
    if download_trailer(url, trailer_path):
        if os.path.exists(trailer_path) and os.path.getsize(trailer_path) > 100000:
            size_mb = os.path.getsize(trailer_path) / (1024 * 1024)
            print(f" ✅ {size_mb:.1f} MB")
            erfolg += 1
            trailer_info[name] = lang
        else:
            print(f" ❌ Datei zu klein oder fehlt")
            if os.path.exists(trailer_path):
                os.remove(trailer_path)
            fehler += 1
    else:
        print(f" ❌ Download fehlgeschlagen")
        if os.path.exists(trailer_path):
            os.remove(trailer_path)
        fehler += 1

    # Rate limiting — etwas Abstand zwischen Downloads
    time.sleep(3)

# --- trailer-info.json speichern ---
try:
    with open(TRAILER_INFO_PATH, 'w', encoding='utf-8') as f:
        json.dump(trailer_info, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"\n  💾 trailer-info.json aktualisiert ({len(trailer_info)} Eintraege)")
except Exception as e:
    print(f"\n  ⚠️  trailer-info.json Fehler: {e}")

# --- Zusammenfassung ---
print(f"""
==============================
  Ergebnis:
  ✅ Heruntergeladen: {erfolg}
  ⚠️  Kein Trailer:   {kein_trailer}
  ❌ Fehler:          {fehler}
  Gesamt:             {len(missing)}
==============================
""")
