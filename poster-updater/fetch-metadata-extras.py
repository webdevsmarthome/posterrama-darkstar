#!/usr/bin/env python3
"""
Posterrama Metadata-Extras Fetcher
Laedt fehlende Certification (FSK), Director und Studio von TMDB
und fuegt sie in die metadata.json der bestehenden ZIP-Posterpacks ein.
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
*  Posterrama Metadata-Extras Fetcher                        *
*  Certification (FSK), Director, Studio                     *
**************************************************************
""")


def api_call(endpoint, params=None):
    if params is None:
        params = {}
    params['api_key'] = TMDB_API_KEY
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


def fetch_certification(tmdb_id):
    """Holt FSK/Certification: DE bevorzugt, US Fallback."""
    data = api_call(f'movie/{tmdb_id}/release_dates')
    if not data:
        return ''
    cert_de = ''
    cert_us = ''
    for country in data.get('results', []):
        iso = country.get('iso_3166_1', '')
        for rel in country.get('release_dates', []):
            c = (rel.get('certification') or '').strip()
            if c:
                if iso == 'DE' and not cert_de:
                    cert_de = c
                if iso == 'US' and not cert_us:
                    cert_us = c
    return cert_de or cert_us


def fetch_directors(tmdb_id):
    """Holt Regisseur(e) aus Credits."""
    data = api_call(f'movie/{tmdb_id}/credits', {'language': 'de-DE'})
    if not data:
        return []
    return [c['name'] for c in data.get('crew', []) if c.get('job') == 'Director']


def fetch_studios(tmdb_id):
    """Holt Studios aus Movie-Details."""
    data = api_call(f'movie/{tmdb_id}', {'language': 'de-DE'})
    if not data:
        return []
    return [c['name'] for c in data.get('production_companies', [])]


def needs_update(meta):
    """Prueft ob mindestens eines der drei Felder fehlt."""
    has_cert = bool((meta.get('contentRating') or '').strip())
    has_dir = bool(meta.get('director') or meta.get('directors'))
    has_studio = bool(meta.get('studio') or meta.get('studios'))
    return not (has_cert and has_dir and has_studio)


def update_metadata_in_zip(zip_path, updates):
    """Aktualisiert Felder in der metadata.json im ZIP."""
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.zip')
    os.close(tmp_fd)
    try:
        with zipfile.ZipFile(zip_path, 'r') as old_zip:
            meta_name = None
            for name in old_zip.namelist():
                if name.endswith('metadata.json'):
                    meta_name = name
                    break
            if not meta_name:
                os.remove(tmp_path)
                return False

            meta = json.loads(old_zip.read(meta_name))
            for k, v in updates.items():
                meta[k] = v

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


# --- ZIPs finden die Updates brauchen ---
def find_zips_needing_update():
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
                            if needs_update(meta):
                                tmdb_id = meta.get('tmdbId')
                                results.append((name, zpath, tmdb_id))
                            break
            except Exception:
                pass
    return results


# --- Hauptprogramm ---
print(f"  Suche ZIPs mit fehlenden Metadaten in: {COMPLETE_DIR}\n")

zips = find_zips_needing_update()
print(f"  Gefunden: {len(zips)} ZIPs mit fehlenden Daten\n")

if not zips:
    print("  Alle ZIPs haben bereits Certification, Director und Studio!")
    sys.exit(0)

erfolg = 0
fehler = 0

for i, (name, zpath, tmdb_id) in enumerate(zips, 1):
    # TMDB-ID ermitteln falls nicht vorhanden
    if not tmdb_id:
        title, year = extract_title_year(name)
        tmdb_id = search_tmdb(title, year)
        if not tmdb_id:
            print(f"   ❌ [{i}/{len(zips)}] {name} — kein TMDB-Treffer")
            fehler += 1
            continue

    # Daten holen
    certification = fetch_certification(tmdb_id)
    directors = fetch_directors(tmdb_id)
    studios = fetch_studios(tmdb_id)

    updates = {
        'contentRating': certification,
        'director': directors[0] if directors else '',
        'directors': directors,
        'studio': studios[0] if studios else '',
        'studios': studios,
    }

    # In ZIP schreiben
    if update_metadata_in_zip(zpath, updates):
        parts = []
        if certification:
            parts.append(f"FSK:{certification}")
        if directors:
            parts.append(f"Dir:{directors[0]}")
        if studios:
            parts.append(f"Studio:{studios[0]}")
        print(f"   ✅ [{i}/{len(zips)}] {name} — {', '.join(parts) or 'keine Daten'}")
        erfolg += 1
    else:
        print(f"   ❌ [{i}/{len(zips)}] {name} — ZIP-Update fehlgeschlagen")
        fehler += 1

    # Rate Limiting
    if i % 20 == 0:
        time.sleep(1)

print(f"""
==============================
  Ergebnis:
  ✅ Aktualisiert: {erfolg}
  ❌ Fehler:       {fehler}
  Gesamt:          {len(zips)}
==============================
""")
