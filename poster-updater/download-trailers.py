#!/usr/bin/env python3
"""
Posterrama Trailer Downloader
Laedt YouTube-Trailer fuer alle Filme der Filmliste herunter.
Sprache: Deutsch bevorzugt, Englisch als Fallback.
Aufloesung: Max. Full-HD (1080p).
Ausgabe: media/trailers/Film (Jahr)-trailer.mp4
"""

import requests
import os
import sys
import re
import yt_dlp
from dotenv import load_dotenv

print("""
**************************************************************
*  Posterrama Trailer Downloader                             *
*  Deutsch bevorzugt, max. Full-HD                           *
**************************************************************
""")

import json

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
load_dotenv(os.path.join(PROJECT_ROOT, '.env'))

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
FILMLISTE_PATH = os.getenv('FILMLISTE_PATH', 'filmliste.txt')
TRAILER_DIR = os.path.join(PROJECT_ROOT, 'media', 'trailers')
TRAILER_INFO_PATH = os.path.join(TRAILER_DIR, 'trailer-info.json')

# Fallback: TMDB API Key aus config.json lesen
if not TMDB_API_KEY or TMDB_API_KEY == 'false':
    try:
        with open(os.path.join(PROJECT_ROOT, 'config.json'), 'r', encoding='utf-8') as _cf:
            _cfg = json.load(_cf)
            TMDB_API_KEY = (_cfg.get('tmdbSource', {}).get('apiKey')
                           or _cfg.get('tmdb', {}).get('apiKey')
                           or None)
    except Exception:
        pass

if not TMDB_API_KEY or TMDB_API_KEY == 'false':
    print("❌ TMDB_API_KEY fehlt in .env und config.json!")
    sys.exit(1)

os.makedirs(TRAILER_DIR, exist_ok=True)
trailer_info = {}
try:
    with open(TRAILER_INFO_PATH, 'r', encoding='utf-8') as _f:
        trailer_info = json.load(_f)
except (FileNotFoundError, json.JSONDecodeError):
    pass

BASE_URL = 'https://api.themoviedb.org/3'

print(f"""
  Filmliste:   {FILMLISTE_PATH}
  Trailer-Dir: {TRAILER_DIR}
""")

# --- Filmliste lesen ---
try:
    with open(FILMLISTE_PATH, 'r', encoding='utf-8') as f:
        films = [line.strip() for line in f if line.strip()]
except FileNotFoundError:
    print(f"❌ Filmliste nicht gefunden: {FILMLISTE_PATH}")
    sys.exit(1)

print(f"  Filme gesamt: {len(films)}\n")

erfolg = 0
uebersprungen = 0
fehler = 0
kein_trailer = 0


def api_call(endpoint, language='de-DE'):
    """TMDB API Aufruf"""
    params = {'api_key': TMDB_API_KEY, 'language': language}
    try:
        r = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=15)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def find_best_trailer(videos):
    """
    Aus einer Liste von TMDB-Video-Ergebnissen den besten Trailer waehlen.
    Prioritaet: Offizieller Trailer (Studio) > Inoffizieller Trailer (KinoCheck etc.)
    """
    trailers = [v for v in (videos or []) if v.get('site') == 'YouTube' and v.get('type') == 'Trailer']
    if not trailers:
        return None
    # Offizielle zuerst, dann nach Veroeffentlichungsdatum (neueste zuerst)
    trailers.sort(key=lambda v: (not v.get('official', False), v.get('published_at', '') or ''), reverse=False)
    trailers.sort(key=lambda v: v.get('official', False), reverse=True)
    return trailers[0]


def find_trailer_url(movie_id):
    """
    Sucht den besten Trailer fuer einen Film.
    Prioritaet: Deutsch offiziell > Deutsch inoffiziell > Englisch offiziell > Englisch inoffiziell
    """
    # 1. Deutsche Trailer suchen
    videos_de = api_call(f'movie/{movie_id}/videos', language='de-DE')
    if videos_de and videos_de.get('results'):
        best = find_best_trailer(videos_de['results'])
        if best:
            label = 'DE-offiziell' if best.get('official') else 'DE'
            return f"https://www.youtube.com/watch?v={best['key']}", label

    # 2. Englische Trailer als Fallback
    videos_en = api_call(f'movie/{movie_id}/videos', language='en-US')
    if videos_en and videos_en.get('results'):
        best = find_best_trailer(videos_en['results'])
        if best:
            label = 'EN-offiziell' if best.get('official') else 'EN'
            return f"https://www.youtube.com/watch?v={best['key']}", label

    return None, None


def download_trailer(youtube_url, output_path):
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
            ydl.download([youtube_url])
        return True
    except Exception as e:
        print(f"      yt-dlp Fehler: {e}")
        return False


# --- Hauptschleife ---
for i, entry in enumerate(films, 1):
    # Titel und Jahr extrahieren: "Film (2024)"
    m = re.match(r'^(.+?)\s*\((\d{4})\)\s*$', entry)
    if not m:
        print(f"   ⚠️  Format ungueltig: '{entry}' — erwartet: 'Titel (Jahr)'")
        fehler += 1
        continue

    clean_title = m.group(1).strip()
    year = m.group(2)
    trailer_filename = f"{clean_title} ({year})-trailer.mp4"
    trailer_path = os.path.join(TRAILER_DIR, trailer_filename)

    # Bereits vorhanden?
    if os.path.exists(trailer_path) and os.path.getsize(trailer_path) > 100000:
        print(f"   ⏭️  [{i}/{len(films)}] {entry} — bereits vorhanden")
        uebersprungen += 1
        continue

    # TMDB-Suche
    search = api_call('search/movie', language='de-DE')
    search = None
    search_params = {'api_key': TMDB_API_KEY, 'language': 'de-DE', 'query': clean_title, 'year': year}
    try:
        r = requests.get(f"{BASE_URL}/search/movie", params=search_params, timeout=15)
        if r.status_code == 200:
            search = r.json()
    except Exception:
        pass

    if not search or not search.get('results'):
        # Retry ohne Jahr
        search_params.pop('year', None)
        try:
            r = requests.get(f"{BASE_URL}/search/movie", params=search_params, timeout=15)
            if r.status_code == 200:
                search = r.json()
        except Exception:
            pass

    if not search or not search.get('results'):
        print(f"   ❌ [{i}/{len(films)}] {entry} — kein TMDB-Treffer")
        fehler += 1
        continue

    movie_id = search['results'][0]['id']

    # Trailer-URL finden
    youtube_url, lang = find_trailer_url(movie_id)
    if not youtube_url:
        print(f"   ⚠️  [{i}/{len(films)}] {entry} — kein Trailer bei TMDB")
        kein_trailer += 1
        continue

    # Trailer herunterladen
    print(f"   ⬇️  [{i}/{len(films)}] {entry} ({lang}) ...", end='', flush=True)
    if download_trailer(youtube_url, trailer_path):
        size_mb = os.path.getsize(trailer_path) / (1024 * 1024)
        print(f" ✅ {size_mb:.1f} MB")
        erfolg += 1
        # Trailer-Typ persistieren
        trailer_info[entry] = lang
    else:
        print(f" ❌ Download fehlgeschlagen")
        # Aufraumen bei Fehler
        if os.path.exists(trailer_path):
            os.remove(trailer_path)
        fehler += 1

# --- trailer-info.json speichern ---
try:
    with open(TRAILER_INFO_PATH, 'w', encoding='utf-8') as _f:
        json.dump(trailer_info, _f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"  💾 trailer-info.json gespeichert ({len(trailer_info)} Eintraege)")
except Exception as e:
    print(f"  ⚠️  trailer-info.json konnte nicht gespeichert werden: {e}")

# --- Zusammenfassung ---
print(f"""
==============================
  Ergebnis:
  ✅ Heruntergeladen: {erfolg}
  ⏭️  Uebersprungen:  {uebersprungen}
  ⚠️  Kein Trailer:   {kein_trailer}
  ❌ Fehler:          {fehler}
  Gesamt:             {len(films)}
==============================
""")
