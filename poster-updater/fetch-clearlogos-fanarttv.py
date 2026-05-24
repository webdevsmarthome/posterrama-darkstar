#!/usr/bin/env python3
"""
Posterrama Clearlogo Fetcher — fanart.tv (Stage 1 der Clearlogo-Pipeline)

Laedt fehlende Clearlogos von fanart.tv herunter und fuegt sie in
bestehende ZIP-PosterPacks ein. Quelle nach TMDB (Patch #35), greift
also nur fuer Filme, fuer die TMDB schon kein Logo hatte.

Prioritaet pro Film:
  1. hdmovielogo, Sprache 'de' (sortiert nach Likes desc)
  2. hdmovielogo, Sprache 'en' (Likes desc)
  3. hdmovielogo, Sprache '00' (sprachneutral, Likes desc)
  4. movielogo (Standard-Aufloesung) — gleiche Sprach-Reihenfolge

Markiert in metadata.json:
  clearlogo: "clearlogo.png"
  clearlogoSource: "fanarttv"

Negativ-Cache: cache/clearlogo-fetch-cache.json mit TTL 30 Tage.
"""

import os
import sys
import json
import time
import zipfile
import tempfile
import shutil
from datetime import datetime, timedelta

import requests

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CONFIG_PATH = os.path.join(PROJECT_ROOT, 'config.json')
COMPLETE_DIR = os.path.join(PROJECT_ROOT, 'media', 'complete')
CACHE_PATH = os.path.join(PROJECT_ROOT, 'cache', 'clearlogo-fetch-cache.json')

NEGATIVE_TTL = timedelta(days=30)

API_BASE = 'https://webservice.fanart.tv/v3/movies'

# --- Config laden --------------------------------------------------------
FANARTTV_API_KEY = None
try:
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
        FANARTTV_API_KEY = (cfg.get('fanarttv', {}).get('apiKey')
                            or cfg.get('fanartTv', {}).get('apiKey')
                            or cfg.get('fanart_tv', {}).get('apiKey'))
except Exception:
    pass

if not FANARTTV_API_KEY:
    print("[fanarttv] Kein fanart.tv-API-Key in config.json (fanarttv.apiKey) — Stage 1 wird uebersprungen.")
    sys.exit(0)


print("""
**************************************************************
*  Posterrama Clearlogo Fetcher — fanart.tv                  *
*  Stage 1 der Clearlogo-Pipeline                            *
**************************************************************
""")


# --- Cache-Helfer --------------------------------------------------------
def load_negative_cache():
    """Laedt den Negativ-Cache (Filme, fuer die fanart.tv kein Logo hat)."""
    if not os.path.isfile(CACHE_PATH):
        return {'noFanarttv': {}, 'noLocal': {}}
    try:
        with open(CACHE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if not isinstance(data, dict):
                return {'noFanarttv': {}, 'noLocal': {}}
            data.setdefault('noFanarttv', {})
            data.setdefault('noLocal', {})
            return data
    except Exception:
        return {'noFanarttv': {}, 'noLocal': {}}


def save_negative_cache(data):
    """Schreibt den Negativ-Cache atomar zurueck."""
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp = CACHE_PATH + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, CACHE_PATH)
    except Exception as e:
        print(f"   Cache-Schreibfehler: {e}")


def is_recently_skipped(cache, tmdb_id):
    """True, wenn der Film innerhalb TTL als 'kein Logo' markiert ist."""
    entry = cache.get('noFanarttv', {}).get(str(tmdb_id))
    if not entry:
        return False
    try:
        ts = datetime.fromisoformat(entry.replace('Z', '+00:00'))
        return datetime.utcnow().replace(tzinfo=ts.tzinfo) - ts < NEGATIVE_TTL
    except Exception:
        return False


def mark_skipped(cache, tmdb_id):
    cache.setdefault('noFanarttv', {})[str(tmdb_id)] = datetime.utcnow().isoformat() + 'Z'


# --- ZIP-Helfer ----------------------------------------------------------
def find_zips_needing_logo():
    """
    Findet alle ZIPs, die ein Logo brauchen.

    Gibt eine Liste von Tupeln (name, zpath, tmdb_id, current_source) zurueck.
    `current_source` ist None (kein Logo vorhanden) oder 'generated'
    (vorhandenes Logo war Text-Fallback und darf durch echtes ersetzt werden).
    """
    results = []
    for root, _dirs, files in os.walk(COMPLETE_DIR):
        for f in sorted(files):
            if not f.lower().endswith('.zip') or f.startswith('._'):
                continue
            zpath = os.path.join(root, f)
            name = f.replace('.zip', '').replace('.ZIP', '')

            try:
                with zipfile.ZipFile(zpath) as z:
                    entries = [e.lower() for e in z.namelist()]
                    has_logo = any('clearlogo' in e for e in entries)

                    # tmdbId + clearlogoSource aus metadata.json lesen
                    tmdb_id = None
                    src = None
                    if 'metadata.json' in z.namelist():
                        try:
                            meta = json.loads(z.read('metadata.json'))
                            tmdb_id = (meta.get('tmdbId')
                                       or meta.get('tmdb_id')
                                       or meta.get('ids', {}).get('tmdb'))
                            src = meta.get('clearlogoSource')
                        except Exception:
                            pass

                    if not has_logo and tmdb_id:
                        results.append((name, zpath, tmdb_id, None))
                    elif has_logo and src == 'generated' and tmdb_id:
                        # Text-Fallback darf von echtem Logo ersetzt werden
                        results.append((name, zpath, tmdb_id, 'generated'))
            except Exception:
                pass
    return results


def fetch_logo_url(tmdb_id):
    """
    Holt die beste Clearlogo-URL von fanart.tv.

    Reihenfolge: hdmovielogo > movielogo, Sprachen de > en > 00.
    Innerhalb jeder Sprach-Gruppe sortiert nach 'likes' descending.
    """
    try:
        r = requests.get(
            f'{API_BASE}/{tmdb_id}',
            params={'api_key': FANARTTV_API_KEY},
            timeout=15,
        )
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            return None
        data = r.json()
    except Exception:
        return None

    def pick_from(field):
        logos = data.get(field, []) or []
        if not logos:
            return None
        # Pools nach Sprache
        de = [l for l in logos if l.get('lang') == 'de']
        en = [l for l in logos if l.get('lang') == 'en']
        neutral = [l for l in logos if l.get('lang') in ('00', None, '')]
        for pool in (de, en, neutral):
            if pool:
                try:
                    pool.sort(key=lambda x: int(x.get('likes', 0) or 0),
                              reverse=True)
                except Exception:
                    pass
                url = pool[0].get('url')
                if url:
                    return url
        return None

    return pick_from('hdmovielogo') or pick_from('movielogo')


def download_image(url):
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 200 and len(r.content) > 1000:
            return r.content
    except Exception:
        pass
    return None


def patch_zip_with_logo(zip_path, logo_bytes):
    """
    Schreibt clearlogo.png ins ZIP und setzt metadata.json:
      clearlogo = 'clearlogo.png'
      clearlogoSource = 'fanarttv'

    Bestehende clearlogo-Dateien (z. B. aus Stage 4 'generated')
    werden ersetzt.
    """
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.zip')
    os.close(tmp_fd)
    try:
        with zipfile.ZipFile(zip_path, 'r') as old_zip:
            with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as new_zip:
                meta_updated = False
                for item in old_zip.infolist():
                    name = item.filename
                    # Existierende clearlogo-Varianten ueberschreiben (skip beim Kopieren)
                    if name.lower().endswith(('clearlogo.png', 'clearlogo.jpg',
                                              'clearlogo.jpeg', 'clearlogo.webp')):
                        continue
                    if name == 'metadata.json':
                        try:
                            meta = json.loads(old_zip.read(name))
                        except Exception:
                            meta = {}
                        meta['clearlogo'] = 'clearlogo.png'
                        meta['clearlogoSource'] = 'fanarttv'
                        new_zip.writestr('metadata.json',
                                         json.dumps(meta, indent=2, ensure_ascii=False))
                        meta_updated = True
                    else:
                        new_zip.writestr(item, old_zip.read(name))

                # clearlogo immer ans Ende, damit es das alte ersetzt
                new_zip.writestr('clearlogo.png', logo_bytes)

                # Falls keine metadata.json existierte, leg eine an
                if not meta_updated:
                    new_zip.writestr('metadata.json',
                                     json.dumps({
                                         'clearlogo': 'clearlogo.png',
                                         'clearlogoSource': 'fanarttv',
                                     }, indent=2, ensure_ascii=False))

        shutil.move(tmp_path, zip_path)
        return True
    except Exception as e:
        print(f"      ZIP-Fehler: {e}")
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        return False


# --- Main ---------------------------------------------------------------
def main():
    cache = load_negative_cache()
    candidates = find_zips_needing_logo()

    skipped_cache = 0
    initial_count = len(candidates)
    candidates = [c for c in candidates
                  if not is_recently_skipped(cache, c[2])
                  or c[3] == 'generated']
    skipped_cache = initial_count - len(candidates)

    print(f"  Kandidaten: {initial_count} (davon {skipped_cache} via Cache uebersprungen)")
    print(f"  Verbleibend: {len(candidates)}\n")

    erfolg = 0
    kein_logo = 0
    fehler = 0

    for i, (name, zpath, tmdb_id, src) in enumerate(candidates, 1):
        prefix = f"  [{i}/{len(candidates)}]"
        suffix = " (replace generated)" if src == 'generated' else ""
        try:
            logo_url = fetch_logo_url(tmdb_id)
            if not logo_url:
                print(f"{prefix} {name} — kein Logo bei fanart.tv{suffix}")
                mark_skipped(cache, tmdb_id)
                kein_logo += 1
                continue

            logo_bytes = download_image(logo_url)
            if not logo_bytes:
                print(f"{prefix} {name} — Download fehlgeschlagen{suffix}")
                fehler += 1
                continue

            if patch_zip_with_logo(zpath, logo_bytes):
                kb = len(logo_bytes) / 1024
                print(f"{prefix} {name} — Logo eingebaut ({kb:.0f} KB){suffix}")
                erfolg += 1
                # Aus dem Negativ-Cache entfernen, falls dort
                cache.get('noFanarttv', {}).pop(str(tmdb_id), None)
            else:
                fehler += 1
        except Exception as e:
            print(f"{prefix} {name} — Fehler: {e}")
            fehler += 1

        # Rate-Limiting: 30 Calls / Sekunde ist fanart.tv-Limit; wir sind
        # konservativ und legen alle 30 Filme 1 s Pause ein.
        if i % 30 == 0:
            time.sleep(1)

    save_negative_cache(cache)

    print(f"""
==============================
  Ergebnis (fanart.tv):
  Eingebaut:       {erfolg}
  Kein Logo:       {kein_logo}
  Fehler:          {fehler}
  Cache-Skip:      {skipped_cache}
  Gesamt geprueft: {initial_count}
==============================
""")
    return 0 if fehler == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
