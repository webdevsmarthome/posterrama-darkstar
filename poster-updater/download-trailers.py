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
import unicodedata
import yt_dlp
from trailer_search import search_youtube_trailer_candidates

print("""
**************************************************************
*  Posterrama Trailer Downloader                             *
*  Deutsch bevorzugt, max. Full-HD                           *
**************************************************************
""")

import json

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CONFIG_PATH = os.path.join(PROJECT_ROOT, 'config.json')
FILMLISTE_PATH = 'filmliste.txt'
TRAILER_DIR = os.path.join(PROJECT_ROOT, 'media', 'trailers')
TRAILER_INFO_PATH = os.path.join(TRAILER_DIR, 'trailer-info.json')

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

# Titel-Dubletten (gleicher Titel, anderes Jahr -- Original und Remake): Fuer sie
# muss ein per YouTube-Suche gefundener Trailer das Jahr im Videotitel tragen,
# sonst bekommt "Der Hauptmann von Koepenick (1931)" den Trailer von 1956.
_title_counts = {}
for _e in films:
    _t = re.sub(r'\s*\[tmdb:\d+\]\s*$', '', _e)
    _t = re.sub(r'\s*\(\d{4}\)\s*$', '', _t).strip().lower()
    _title_counts[_t] = _title_counts.get(_t, 0) + 1
duplicate_titles = {t for t, n in _title_counts.items() if n > 1}
if duplicate_titles:
    print(f"  Titel-Dubletten (Jahr im Trailer-Titel Pflicht): {len(duplicate_titles)}\n")

erfolg = 0
uebersprungen = 0
fehler = 0
kein_trailer = 0
suche_erfolg = 0   # davon per YouTube-Suche (Fallback) geladen


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
    """Laedt YouTube-Video als MP4 herunter, max. 1080p, H.264-codiert.

    H.264 (vcodec=avc1) statt AV1 erzwingen, damit die mp4-Trailer auf allen
    Browsern und Geraeten abspielen — Safari (insbesondere Intel-Macs und
    aeltere Versionen) kann AV1 nicht decoden, was zu schwarzen Trailern fuehrt.
    Fallback-Kette: H.264-mp4 -> beliebiges mp4 ohne AV1 -> bestes mp4 -> 1080p.
    """
    ydl_opts = {
        'format': (
            'bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/'
            'best[height<=1080][vcodec^=avc1][ext=mp4]/'
            'bestvideo[height<=1080][vcodec!*=av01][ext=mp4]+bestaudio[ext=m4a]/'
            'best[height<=1080][ext=mp4]/'
            'best[height<=1080]'
        ),
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


def search_fallback(i, entry, clean_title, original_title, year, trailer_path, exclude_ids=()):
    """
    YouTube-Suche als Fallback (trailer_search.py). Greift, wenn TMDB keinen
    Treffer/Trailer hat oder das TMDB-Video nicht mehr verfuegbar ist.
    Gibt das Sprach-Label ('DE'/'EN') zurueck, wenn ein Trailer geladen wurde,
    sonst None. Der gewaehlte Videotitel wird protokolliert, damit Fehlgriffe
    im Trailer-Log des Admins sofort auffallen.
    """
    candidates = search_youtube_trailer_candidates(
        clean_title, original_title, year, exclude_ids=exclude_ids,
        require_year=clean_title.strip().lower() in duplicate_titles,
    )
    # Bis zu drei Kandidaten: ist der beste nicht (mehr) ladbar, der naechste.
    for cand in candidates:
        print(f"   🔎 [{i}/{len(films)}] {entry} — Suche: \"{cand['title']}\" "
              f"({cand['duration']} s, {cand['label']}) ...", end='', flush=True)
        if download_trailer(cand['url'], trailer_path):
            size_mb = os.path.getsize(trailer_path) / (1024 * 1024)
            print(f" ✅ {size_mb:.1f} MB")
            return cand['label']
        print(" ❌ nicht ladbar")
        if os.path.exists(trailer_path):
            os.remove(trailer_path)
    return None


# Format-Erweiterung (Patch 51): Filmliste-Einträge können einen optionalen
# TMDB-ID-Hinweis tragen, z.B. "Hamlet (2000)[tmdb:10688]". Seit z-17 wird der
# Hint genutzt: Der Film wird direkt per ID nachgeschlagen statt per unscharfer
# Titelsuche -- die lieferte fuer "Elvis & Priscilla" den Film "Elvis & Nixon"
# und fuer den Nicht-Film "SOUND TRAILER V01" den Film "Scream VI".
TMDB_HINT_RE = re.compile(r'^(.+?)\s*\[tmdb:(\d+)\]\s*$')

# --- Hauptschleife ---
for i, entry in enumerate(films, 1):
    # Optionaler [tmdb:NNN]-Hint: abstrippen, ID merken
    hint_match = TMDB_HINT_RE.match(entry)
    if hint_match:
        entry_for_match = hint_match.group(1).strip()
        tmdb_id_hint = int(hint_match.group(2))
    else:
        entry_for_match = entry
        tmdb_id_hint = None

    # Titel und Jahr extrahieren: "Film (2024)"
    m = re.match(r'^(.+?)\s*\((\d{4})\)\s*$', entry_for_match)
    if not m:
        print(f"   ⚠️  Format ungueltig: '{entry}' — erwartet: 'Titel (Jahr)'")
        fehler += 1
        continue

    clean_title = unicodedata.normalize('NFC', m.group(1).strip())
    year = m.group(2)
    entry = unicodedata.normalize('NFC', entry_for_match)
    trailer_filename = f"{clean_title} ({year})-trailer.mp4"
    trailer_path = os.path.join(TRAILER_DIR, trailer_filename)

    # Bereits vorhanden?
    if os.path.exists(trailer_path) and os.path.getsize(trailer_path) > 100000:
        print(f"   ⏭️  [{i}/{len(films)}] {entry} — bereits vorhanden")
        uebersprungen += 1
        continue

    # TMDB: bei [tmdb:ID]-Hint direkt nachschlagen (eindeutig), sonst Titelsuche
    search = None
    if tmdb_id_hint:
        details = api_call(f'movie/{tmdb_id_hint}', language='de-DE')
        if details and details.get('id'):
            search = {'results': [details]}

    if not search:
        search_params = {'api_key': TMDB_API_KEY, 'language': 'de-DE', 'query': clean_title, 'year': year}
        try:
            r = requests.get(f"{BASE_URL}/search/movie", params=search_params, timeout=15)
            if r.status_code == 200:
                search = r.json()
        except Exception:
            pass

    if not search or not search.get('results'):
        # Retry ohne Jahr
        search_params = {'api_key': TMDB_API_KEY, 'language': 'de-DE', 'query': clean_title}
        try:
            r = requests.get(f"{BASE_URL}/search/movie", params=search_params, timeout=15)
            if r.status_code == 200:
                search = r.json()
        except Exception:
            pass

    if not search or not search.get('results'):
        print(f"   ⚠️  [{i}/{len(films)}] {entry} — kein TMDB-Treffer, versuche YouTube-Suche")
        label = search_fallback(i, entry, clean_title, None, year, trailer_path)
        if label:
            erfolg += 1
            suche_erfolg += 1
            trailer_info[entry] = label
        else:
            print(f"   ❌ [{i}/{len(films)}] {entry} — kein TMDB-Treffer, Suche ohne Ergebnis")
            fehler += 1
        continue

    movie = search['results'][0]
    movie_id = movie['id']
    # Originaltitel nur fuer die YouTube-Suche uebernehmen, wenn TMDB plausibel
    # denselben Film meint (Erscheinungsjahr +-1). Sonst sucht ein fremder
    # Originaltitel den falschen Film ("Beach Party Animals" -> "The Quest").
    _release_year = (movie.get('release_date') or '')[:4]
    original_title = (
        movie.get('original_title')
        if _release_year.isdigit() and abs(int(_release_year) - int(year)) <= 1
        else None
    )

    # Trailer-URL finden
    youtube_url, lang = find_trailer_url(movie_id)
    if not youtube_url:
        label = search_fallback(i, entry, clean_title, original_title, year, trailer_path)
        if label:
            erfolg += 1
            suche_erfolg += 1
            trailer_info[entry] = label
        else:
            print(f"   ⚠️  [{i}/{len(films)}] {entry} — kein Trailer bei TMDB, Suche ohne Ergebnis")
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
        # TMDB-Video nicht (mehr) verfuegbar -> YouTube-Suche, das tote Video ausschliessen
        failed_id = re.search(r'v=([\w-]+)', youtube_url)
        label = search_fallback(i, entry, clean_title, original_title, year, trailer_path,
                                exclude_ids=(failed_id.group(1),) if failed_id else ())
        if label:
            erfolg += 1
            suche_erfolg += 1
            trailer_info[entry] = label
        else:
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
  🔎 davon per Suche: {suche_erfolg}
  ⏭️  Uebersprungen:  {uebersprungen}
  ⚠️  Kein Trailer:   {kein_trailer}
  ❌ Fehler:          {fehler}
  Gesamt:             {len(films)}
==============================
""")

# Maschinenlesbare Ergebniszeile fuer lib/poster-updater-runner.js, der daraus
# eine Zeile im Server-Log baut (Warnung bei Fehlern). Format nicht aendern:
# der Runner parst genau diese Schluessel.
print(f"TRAILER-SUMMARY downloaded={erfolg} skipped={uebersprungen} "
      f"no_trailer={kein_trailer} failed={fehler} total={len(films)} searched={suche_erfolg}")
