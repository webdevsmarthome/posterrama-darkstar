#!/usr/bin/env python3
"""
Posterrama Trailer Type Scanner
Scannt alle vorhandenen Trailer in media/trailers/ und ermittelt den Typ
(DE-offiziell, DE, EN-offiziell, EN) per TMDB API.
Ergebnis wird in media/trailers/trailer-info.json gespeichert.
"""

import requests
import os
import sys
import re
import json
import time

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CONFIG_PATH = os.path.join(PROJECT_ROOT, 'config.json')
TRAILER_DIR = os.path.join(PROJECT_ROOT, 'media', 'trailers')
TRAILER_INFO_PATH = os.path.join(TRAILER_DIR, 'trailer-info.json')
BASE_URL = 'https://api.themoviedb.org/3'

# TMDB API Key aus config.json lesen
TMDB_API_KEY = None
try:
    with open(CONFIG_PATH, 'r', encoding='utf-8') as _cf:
        _cfg = json.load(_cf)
        TMDB_API_KEY = (_cfg.get('tmdbSource', {}).get('apiKey')
                       or _cfg.get('tmdb', {}).get('apiKey')
                       or None)
except Exception:
    pass

if not TMDB_API_KEY:
    print("TMDB API Key fehlt in config.json (tmdbSource.apiKey)!")
    sys.exit(1)

print("""
**************************************************************
*  Posterrama Trailer Type Scanner                           *
*  Ermittelt Trailer-Typen fuer bestehende Trailer           *
**************************************************************
""")

# Bestehende trailer-info.json laden
trailer_info = {}
try:
    with open(TRAILER_INFO_PATH, 'r', encoding='utf-8') as f:
        trailer_info = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    pass

print(f"  Trailer-Dir:  {TRAILER_DIR}")
print(f"  Bestehende Eintraege in trailer-info.json: {len(trailer_info)}")

# Alle Trailer-Dateien finden
trailer_files = [f for f in os.listdir(TRAILER_DIR)
                 if f.endswith('-trailer.mp4') and os.path.getsize(os.path.join(TRAILER_DIR, f)) > 100000]
trailer_files.sort()

print(f"  Trailer-Dateien gefunden: {len(trailer_files)}")

# Nur Trailer ohne Typ-Info scannen
to_scan = []
for tf in trailer_files:
    name = tf.replace('-trailer.mp4', '')
    if name not in trailer_info:
        to_scan.append(name)

print(f"  Davon ohne Typ-Info: {len(to_scan)}")
if not to_scan:
    print("\n  Alle Trailer haben bereits Typ-Info. Nichts zu tun.")
    sys.exit(0)

print(f"\n  Starte Scan...\n")


def api_call(endpoint, language='de-DE'):
    params = {'api_key': TMDB_API_KEY, 'language': language}
    try:
        r = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=15)
        if r.status_code == 429:
            time.sleep(2)
            r = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=15)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def find_best_trailer(videos):
    trailers = [v for v in (videos or []) if v.get('site') == 'YouTube' and v.get('type') == 'Trailer']
    if not trailers:
        return None
    trailers.sort(key=lambda v: v.get('official', False), reverse=True)
    return trailers[0]


def find_trailer_type(movie_id):
    # Deutsche Trailer
    videos_de = api_call(f'movie/{movie_id}/videos', language='de-DE')
    if videos_de and videos_de.get('results'):
        best = find_best_trailer(videos_de['results'])
        if best:
            return 'DE-offiziell' if best.get('official') else 'DE'

    # Englische Trailer als Fallback
    videos_en = api_call(f'movie/{movie_id}/videos', language='en-US')
    if videos_en and videos_en.get('results'):
        best = find_best_trailer(videos_en['results'])
        if best:
            return 'EN-offiziell' if best.get('official') else 'EN'

    return 'unbekannt'


erfolg = 0
fehler = 0

for i, name in enumerate(to_scan, 1):
    m = re.match(r'^(.+?)\s*\((\d{4})\)\s*$', name)
    if not m:
        print(f"   [{i}/{len(to_scan)}] {name} — Format ungueltig")
        fehler += 1
        continue

    clean_title = m.group(1).strip()
    year = m.group(2)

    # TMDB-Suche
    search_params = {'api_key': TMDB_API_KEY, 'language': 'de-DE', 'query': clean_title, 'year': year}
    try:
        r = requests.get(f"{BASE_URL}/search/movie", params=search_params, timeout=15)
        search = r.json() if r.status_code == 200 else None
    except Exception:
        search = None

    if not search or not search.get('results'):
        search_params.pop('year', None)
        try:
            r = requests.get(f"{BASE_URL}/search/movie", params=search_params, timeout=15)
            search = r.json() if r.status_code == 200 else None
        except Exception:
            search = None

    if not search or not search.get('results'):
        print(f"   [{i}/{len(to_scan)}] {name} — kein TMDB-Treffer")
        trailer_info[name] = 'unbekannt'
        fehler += 1
        continue

    movie_id = search['results'][0]['id']
    ttype = find_trailer_type(movie_id)
    trailer_info[name] = ttype
    print(f"   [{i}/{len(to_scan)}] {name} — {ttype}")
    erfolg += 1

    # Rate limiting
    if i % 30 == 0:
        time.sleep(1)

# Speichern
try:
    with open(TRAILER_INFO_PATH, 'w', encoding='utf-8') as f:
        json.dump(trailer_info, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"\n  trailer-info.json gespeichert ({len(trailer_info)} Eintraege)")
except Exception as e:
    print(f"\n  Fehler beim Speichern: {e}")

print(f"""
==============================
  Ergebnis:
  Erkannt:  {erfolg}
  Fehler:   {fehler}
  Gesamt:   {len(to_scan)}
==============================
""")
