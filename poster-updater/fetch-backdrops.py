#!/usr/bin/env python3
"""
Posterrama Backdrop Fetcher
Laedt fehlende Backgrounds/Backdrops von TMDB herunter und fuegt sie in bestehende ZIP-Posterpacks ein.
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
*  Posterrama Backdrop Fetcher                               *
*  TMDB → fehlende Backgrounds in ZIPs einfuegen            *
**************************************************************
""")


def find_zips_without_backdrop():
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
                    if not any('background' in e or 'backdrop' in e for e in entries):
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
    params = {'api_key': TMDB_API_KEY, 'query': title, 'language': 'de-DE'}
    if year:
        params['year'] = year
    try:
        r = requests.get(f'{BASE_URL}/search/movie', params=params, timeout=15)
        if r.status_code == 200:
            results = r.json().get('results', [])
            if results:
                return results[0]['id']
    except Exception:
        pass
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


def fetch_backdrop_url(tmdb_id):
    try:
        r = requests.get(
            f'{BASE_URL}/movie/{tmdb_id}/images',
            params={'api_key': TMDB_API_KEY},
            timeout=15
        )
        if r.status_code != 200:
            return None
        backdrops = r.json().get('backdrops', [])
        if not backdrops:
            return None
        # Best: highest vote_average, prefer no language (neutral)
        backdrops.sort(key=lambda x: (x.get('vote_average', 0), x.get('width', 0)), reverse=True)
        best = backdrops[0]
        if best.get('file_path'):
            return IMG_URL + best['file_path']
    except Exception:
        pass
    return None


def download_image(url):
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 200 and len(r.content) > 5000:
            return r.content
    except Exception:
        pass
    return None


def add_backdrop_to_zip(zip_path, img_bytes):
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.zip')
    os.close(tmp_fd)
    try:
        with zipfile.ZipFile(zip_path, 'r') as old_zip:
            with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as new_zip:
                for item in old_zip.infolist():
                    new_zip.writestr(item, old_zip.read(item.filename))
                new_zip.writestr('background.jpg', img_bytes)

        # Update metadata.json if present
        with zipfile.ZipFile(tmp_path, 'r') as z:
            if 'metadata.json' in z.namelist():
                try:
                    meta = json.loads(z.read('metadata.json'))
                    images = meta.get('images', {})
                    if not images.get('primaryBackdrop'):
                        images['primaryBackdrop'] = 'background.jpg'
                        meta['images'] = images
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
missing = find_zips_without_backdrop()
print(f"  Posterpacks ohne Background: {len(missing)}")
print(f"  Starte TMDB-Suche...\n")

erfolg = 0
kein_backdrop = 0
fehler = 0

for i, (name, zpath) in enumerate(missing, 1):
    title, year = extract_title_year(name)
    if not year:
        fehler += 1
        continue

    tmdb_id = search_tmdb(title, year)
    if not tmdb_id:
        print(f"   [{i}/{len(missing)}] {name} — kein TMDB-Treffer")
        kein_backdrop += 1
        continue

    url = fetch_backdrop_url(tmdb_id)
    if not url:
        print(f"   [{i}/{len(missing)}] {name} — kein Backdrop bei TMDB")
        kein_backdrop += 1
        continue

    img_bytes = download_image(url)
    if not img_bytes:
        print(f"   [{i}/{len(missing)}] {name} — Download fehlgeschlagen")
        fehler += 1
        continue

    if add_backdrop_to_zip(zpath, img_bytes):
        size_kb = len(img_bytes) / 1024
        print(f"   [{i}/{len(missing)}] {name} — Backdrop hinzugefuegt ({size_kb:.0f} KB)")
        erfolg += 1
    else:
        fehler += 1

    if i % 30 == 0:
        time.sleep(1)

print(f"""
==============================
  Ergebnis:
  Hinzugefuegt: {erfolg}
  Kein Backdrop: {kein_backdrop}
  Fehler:        {fehler}
  Gesamt:        {len(missing)}
==============================
""")
