#!/usr/bin/env python3
"""
Posterrama Clearlogo Fetcher
Laedt fehlende Clearlogos von TMDB herunter und fuegt sie in bestehende ZIP-PosterPacks ein.
Prioritaet: Deutsche Logos > Englische Logos
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
IMG_URL = 'https://image.tmdb.org/t/p/original'

print("""
**************************************************************
*  Posterrama Clearlogo Fetcher                              *
*  TMDB → fehlende Clearlogos in ZIPs einfuegen             *
**************************************************************
""")


def find_zips_without_clearlogo():
    """Findet alle ZIPs ohne Clearlogo."""
    results = []
    for root, dirs, files in os.walk(COMPLETE_DIR):
        for f in sorted(files):
            if not f.lower().endswith('.zip') or f.startswith('._'):
                continue
            zpath = os.path.join(root, f)
            name = f.replace('.zip', '').replace('.ZIP', '')
            try:
                with zipfile.ZipFile(zpath) as z:
                    entries = [e.lower() for e in z.namelist()]
                    if not any('clearlogo' in e for e in entries):
                        results.append((name, zpath))
            except Exception:
                pass
    return results


def extract_title_year(name):
    m = re.match(r'^(.+?)\s*\((\d{4})\)\s*$', name)
    if m:
        return m.group(1).strip(), m.group(2)
    return name, None


def search_tmdb(title, year):
    """Sucht Film auf TMDB und gibt die tmdbId zurueck."""
    params = {
        'api_key': TMDB_API_KEY,
        'query': title,
        'language': 'de-DE',
    }
    if year:
        params['year'] = year

    try:
        r = requests.get(f'{BASE_URL}/search/movie', params=params, timeout=15)
        if r.status_code != 200:
            return None
        results = r.json().get('results', [])
        if results:
            return results[0]['id']
    except Exception:
        pass

    # Retry without year
    if year:
        params.pop('year', None)
        try:
            r = requests.get(f'{BASE_URL}/search/movie', params=params, timeout=15)
            if r.status_code == 200:
                results = r.json().get('results', [])
                if results:
                    return results[0]['id']
        except Exception:
            pass

    return None


def fetch_clearlogo_url(tmdb_id):
    """Holt die beste Clearlogo-URL von TMDB (DE bevorzugt, dann EN)."""
    try:
        r = requests.get(
            f'{BASE_URL}/movie/{tmdb_id}/images',
            params={'api_key': TMDB_API_KEY},
            timeout=15
        )
        if r.status_code != 200:
            return None

        data = r.json()
        logos = data.get('logos', [])
        if not logos:
            return None

        # Prioritaet: DE > EN > andere, dann nach vote_average
        de_logos = [l for l in logos if l.get('iso_639_1') == 'de' and l.get('file_path', '').endswith('.png')]
        en_logos = [l for l in logos if l.get('iso_639_1') == 'en' and l.get('file_path', '').endswith('.png')]
        other_logos = [l for l in logos if l.get('file_path', '').endswith('.png')]

        best = None
        for pool in [de_logos, en_logos, other_logos]:
            if pool:
                pool.sort(key=lambda x: x.get('vote_average', 0), reverse=True)
                best = pool[0]
                break

        if best and best.get('file_path'):
            return IMG_URL + best['file_path']
    except Exception:
        pass

    return None


def download_image(url):
    """Laedt ein Bild herunter und gibt die Bytes zurueck."""
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 200 and len(r.content) > 1000:
            return r.content
    except Exception:
        pass
    return None


def add_clearlogo_to_zip(zip_path, logo_bytes):
    """Fuegt clearlogo.png in ein bestehendes ZIP ein."""
    # Create temp file, copy old ZIP + add logo, then replace
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.zip')
    os.close(tmp_fd)

    try:
        # Copy existing ZIP and add clearlogo
        with zipfile.ZipFile(zip_path, 'r') as old_zip:
            with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as new_zip:
                for item in old_zip.infolist():
                    new_zip.writestr(item, old_zip.read(item.filename))
                new_zip.writestr('clearlogo.png', logo_bytes)

        # Also update metadata.json if present
        with zipfile.ZipFile(tmp_path, 'r') as z:
            names = z.namelist()
            if 'metadata.json' in names:
                try:
                    meta = json.loads(z.read('metadata.json'))
                    if 'clearlogo' not in meta or not meta['clearlogo']:
                        meta['clearlogo'] = 'clearlogo.png'
                        # Rewrite with updated metadata
                        tmp2_fd, tmp2_path = tempfile.mkstemp(suffix='.zip')
                        os.close(tmp2_fd)
                        with zipfile.ZipFile(tmp2_path, 'w', zipfile.ZIP_DEFLATED) as new_zip2:
                            for item in z.infolist():
                                if item.filename == 'metadata.json':
                                    new_zip2.writestr('metadata.json', json.dumps(meta, indent=2, ensure_ascii=False))
                                else:
                                    new_zip2.writestr(item, z.read(item.filename))
                        shutil.move(tmp2_path, tmp_path)
                except Exception:
                    pass

        # Replace original
        shutil.move(tmp_path, zip_path)
        return True
    except Exception as e:
        print(f"      ZIP-Fehler: {e}")
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        return False


# --- Main ---
missing = find_zips_without_clearlogo()
print(f"  PosterPacks ohne Clearlogo: {len(missing)}")
print(f"  Starte TMDB-Suche...\n")

erfolg = 0
kein_logo = 0
fehler = 0

for i, (name, zpath) in enumerate(missing, 1):
    title, year = extract_title_year(name)
    if not year:
        print(f"   [{i}/{len(missing)}] {name} — kein Jahr erkannt")
        fehler += 1
        continue

    # Search TMDB
    tmdb_id = search_tmdb(title, year)
    if not tmdb_id:
        print(f"   [{i}/{len(missing)}] {name} — kein TMDB-Treffer")
        kein_logo += 1
        continue

    # Fetch logo URL
    logo_url = fetch_clearlogo_url(tmdb_id)
    if not logo_url:
        print(f"   [{i}/{len(missing)}] {name} — kein Clearlogo bei TMDB")
        kein_logo += 1
        continue

    # Download image
    logo_bytes = download_image(logo_url)
    if not logo_bytes:
        print(f"   [{i}/{len(missing)}] {name} — Download fehlgeschlagen")
        fehler += 1
        continue

    # Add to ZIP
    if add_clearlogo_to_zip(zpath, logo_bytes):
        size_kb = len(logo_bytes) / 1024
        print(f"   [{i}/{len(missing)}] {name} — Clearlogo hinzugefuegt ({size_kb:.0f} KB)")
        erfolg += 1
    else:
        fehler += 1

    # Rate limiting
    if i % 30 == 0:
        time.sleep(1)

print(f"""
==============================
  Ergebnis:
  Hinzugefuegt: {erfolg}
  Kein Logo:    {kein_logo}
  Fehler:       {fehler}
  Gesamt:       {len(missing)}
==============================
""")
