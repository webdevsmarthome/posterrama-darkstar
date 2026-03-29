#!/usr/bin/env python3
"""
Posterrama Tagline Fetcher
Laedt fehlende Taglines von TMDB und fuegt sie in die metadata.json der bestehenden ZIP-Posterpacks ein.
Prioritaet: Deutsche Tagline > Englische Tagline
"""

import os
import sys
import re
import json
import time
import zipfile
import tempfile
import shutil
import requests

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CONFIG_PATH = os.path.join(PROJECT_ROOT, 'config.json')
COMPLETE_DIR = os.path.join(PROJECT_ROOT, 'media', 'complete')

# TMDB API Key aus config.json
TMDB_API_KEY = None
try:
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
        TMDB_API_KEY = (cfg.get('tmdbSource', {}).get('apiKey')
                       or cfg.get('tmdb', {}).get('apiKey'))
except Exception:
    pass

if not TMDB_API_KEY:
    print("TMDB API Key fehlt in config.json!")
    sys.exit(1)

BASE_URL = 'https://api.themoviedb.org/3'

print("""
**************************************************************
*  Posterrama Tagline Fetcher                                *
*  Deutsch bevorzugt, Englisch als Fallback                  *
**************************************************************
""")


def api_call(endpoint, language='de-DE'):
    params = {'api_key': TMDB_API_KEY, 'language': language}
    try:
        r = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def extract_title_year(name):
    m = re.match(r'^(.+?)\s*\((\d{4})\)\s*$', name)
    if m:
        return m.group(1).strip(), m.group(2)
    return name, None


def search_tmdb(title, year):
    """TMDB-Suche nach Film, gibt movie_id zurueck oder None."""
    params = {'api_key': TMDB_API_KEY, 'language': 'de-DE', 'query': title}
    if year:
        params['year'] = year
    try:
        r = requests.get(f"{BASE_URL}/search/movie", params=params, timeout=15)
        if r.status_code == 200:
            data = r.json()
            if data.get('results'):
                return data['results'][0]['id']
    except Exception:
        pass
    # Retry ohne Jahr
    if year:
        params.pop('year', None)
        try:
            r = requests.get(f"{BASE_URL}/search/movie", params=params, timeout=15)
            if r.status_code == 200:
                data = r.json()
                if data.get('results'):
                    return data['results'][0]['id']
        except Exception:
            pass
    return None


def fetch_tagline(tmdb_id):
    """Holt Tagline: erst Deutsch, dann Englisch."""
    details_de = api_call(f'movie/{tmdb_id}', language='de-DE')
    if details_de:
        tagline = (details_de.get('tagline') or '').strip()
        if tagline:
            return tagline, 'DE'

    details_en = api_call(f'movie/{tmdb_id}', language='en-US')
    if details_en:
        tagline = (details_en.get('tagline') or '').strip()
        if tagline:
            return tagline, 'EN'

    return None, None


def update_metadata_in_zip(zip_path, tagline):
    """Aktualisiert das tagline-Feld in der metadata.json im ZIP."""
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.zip')
    os.close(tmp_fd)

    try:
        with zipfile.ZipFile(zip_path, 'r') as old_zip:
            # metadata.json finden
            meta_name = None
            for name in old_zip.namelist():
                if name.endswith('metadata.json'):
                    meta_name = name
                    break

            if not meta_name:
                os.remove(tmp_path)
                return False

            # metadata.json lesen und tagline setzen
            meta = json.loads(old_zip.read(meta_name))
            meta['tagline'] = tagline

            # ZIP neu schreiben mit aktualisierter metadata.json
            with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as new_zip:
                for item in old_zip.infolist():
                    if item.filename == meta_name:
                        new_zip.writestr(item, json.dumps(meta, indent=2, ensure_ascii=False))
                    else:
                        new_zip.writestr(item, old_zip.read(item.filename))

        shutil.move(tmp_path, zip_path)
        return True
    except Exception as e:
        print(f"      ZIP-Fehler: {e}")
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        return False


# --- ZIPs ohne Tagline finden ---
def find_zips_without_tagline():
    results = []
    for root, dirs, files in os.walk(COMPLETE_DIR):
        for f in sorted(files):
            if not f.lower().endswith('.zip') or f.startswith('._'):
                continue
            zpath = os.path.join(root, f)
            name = f.replace('.zip', '').replace('.ZIP', '')
            try:
                with zipfile.ZipFile(zpath) as z:
                    for entry in z.namelist():
                        if entry.endswith('metadata.json'):
                            meta = json.loads(z.read(entry))
                            tagline = (meta.get('tagline') or '').strip()
                            if not tagline:
                                results.append((name, zpath))
                            break
            except Exception:
                pass
    return results


# --- Hauptprogramm ---
print(f"  Suche ZIPs ohne Tagline in: {COMPLETE_DIR}\n")

zips = find_zips_without_tagline()
print(f"  Gefunden: {len(zips)} ZIPs ohne Tagline\n")

if not zips:
    print("  Alle ZIPs haben bereits eine Tagline!")
    sys.exit(0)

erfolg = 0
keine_tagline = 0
fehler = 0

for i, (name, zpath) in enumerate(zips, 1):
    title, year = extract_title_year(name)

    # TMDB suchen
    tmdb_id = search_tmdb(title, year)
    if not tmdb_id:
        print(f"   ❌ [{i}/{len(zips)}] {name} — kein TMDB-Treffer")
        fehler += 1
        continue

    # Tagline holen
    tagline, lang = fetch_tagline(tmdb_id)
    if not tagline:
        print(f"   ⚠️  [{i}/{len(zips)}] {name} — keine Tagline bei TMDB")
        keine_tagline += 1
        continue

    # In ZIP schreiben
    if update_metadata_in_zip(zpath, tagline):
        print(f"   ✅ [{i}/{len(zips)}] {name} ({lang}): \"{tagline}\"")
        erfolg += 1
    else:
        print(f"   ❌ [{i}/{len(zips)}] {name} — ZIP-Update fehlgeschlagen")
        fehler += 1

    # Rate Limiting: alle 30 Filme 1s Pause
    if i % 30 == 0:
        time.sleep(1)

print(f"""
==============================
  Ergebnis:
  ✅ Aktualisiert:    {erfolg}
  ⚠️  Keine Tagline:  {keine_tagline}
  ❌ Fehler:          {fehler}
  Gesamt:             {len(zips)}
==============================
""")
