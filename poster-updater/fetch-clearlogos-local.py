#!/usr/bin/env python3
"""
Posterrama Clearlogo Fetcher — Plex/Jellyfin Local (Stage 2 der Pipeline)

Sucht Clearlogos im lokalen Media-Server (Plex und/oder Jellyfin/Emby),
wenn weder TMDB noch fanart.tv ein Logo geliefert haben. Mapping
tmdbId → ratingKey/itemId erfolgt via die Provider-IDs der Server selbst.

Markiert in metadata.json:
  clearlogo: "clearlogo.png"
  clearlogoSource: "plex" oder "jellyfin"

Negativ-Cache: cache/clearlogo-fetch-cache.json key 'noLocal' mit TTL 7 Tage
(kuerzer als fanart.tv, weil Server-Inhalt sich oft aendert).
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
ENV_PATH = os.path.join(PROJECT_ROOT, '.env')
COMPLETE_DIR = os.path.join(PROJECT_ROOT, 'media', 'complete')
CACHE_PATH = os.path.join(PROJECT_ROOT, 'cache', 'clearlogo-fetch-cache.json')

NEGATIVE_TTL = timedelta(days=7)


# --- .env-Parser (einfach genug fuer KEY=VALUE) -------------------------
def load_env(path):
    env = {}
    if not os.path.isfile(path):
        return env
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                v = v.strip().strip('"').strip("'")
                env[k.strip()] = v
    except Exception:
        pass
    return env


ENV = load_env(ENV_PATH)


def get_token(token_env_var):
    if not token_env_var:
        return None
    return os.environ.get(token_env_var) or ENV.get(token_env_var)


# --- Config laden --------------------------------------------------------
try:
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        CFG = json.load(f)
except Exception as e:
    print(f"[local] Config nicht lesbar: {e}")
    sys.exit(1)

SERVERS = []
for srv in CFG.get('mediaServers', []) or []:
    if not srv.get('enabled'):
        continue
    typ = (srv.get('type') or '').lower()
    if typ not in ('plex', 'jellyfin', 'emby'):
        continue
    token = get_token(srv.get('tokenEnvVar')) or srv.get('token')
    if not token:
        continue
    hostname = srv.get('hostname') or srv.get('host')
    port = srv.get('port') or (32400 if typ == 'plex' else 8096)
    ssl = bool(srv.get('ssl'))
    if not hostname:
        continue
    scheme = 'https' if ssl else 'http'
    SERVERS.append({
        'name': srv.get('name') or typ,
        'type': typ,
        'base': f"{scheme}://{hostname}:{port}",
        'token': token,
    })

if not SERVERS:
    print("[local] Keine aktivierten Media-Server in config.json — Stage 2 wird uebersprungen.")
    sys.exit(0)


print(f"""
**************************************************************
*  Posterrama Clearlogo Fetcher — Plex/Jellyfin Local        *
*  Stage 2 der Clearlogo-Pipeline ({len(SERVERS)} Server aktiv)
**************************************************************
""")


# --- Cache-Helfer --------------------------------------------------------
def load_negative_cache():
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
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp = CACHE_PATH + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, CACHE_PATH)
    except Exception as e:
        print(f"   Cache-Schreibfehler: {e}")


def is_recently_skipped(cache, tmdb_id):
    entry = cache.get('noLocal', {}).get(str(tmdb_id))
    if not entry:
        return False
    try:
        ts = datetime.fromisoformat(entry.replace('Z', '+00:00'))
        return datetime.utcnow().replace(tzinfo=ts.tzinfo) - ts < NEGATIVE_TTL
    except Exception:
        return False


def mark_skipped(cache, tmdb_id):
    cache.setdefault('noLocal', {})[str(tmdb_id)] = datetime.utcnow().isoformat() + 'Z'


# --- ZIP-Scanner ---------------------------------------------------------
def find_zips_needing_logo():
    """ZIPs, die fanart.tv nicht versorgen konnte (kein Clearlogo oder generated)."""
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
                    if not tmdb_id:
                        continue
                    if not has_logo:
                        results.append((name, zpath, tmdb_id, None))
                    elif has_logo and src == 'generated':
                        results.append((name, zpath, tmdb_id, 'generated'))
            except Exception:
                pass
    return results


# --- Media-Server-Suche -------------------------------------------------
def fetch_logo_from_jellyfin(server, tmdb_id):
    """Sucht den Film via TMDB-Provider-ID und holt das Logo."""
    base, token = server['base'], server['token']
    try:
        r = requests.get(
            f"{base}/Items",
            params={
                'api_key': token,
                'AnyProviderIdEquals': f"Tmdb.{tmdb_id}",
                'IncludeItemTypes': 'Movie',
                'Recursive': 'true',
                'Fields': 'ProviderIds',
                'Limit': 1,
            },
            timeout=10,
        )
        if r.status_code != 200:
            return None
        items = (r.json().get('Items') or [])
        if not items:
            return None
        item_id = items[0].get('Id')
        if not item_id:
            return None

        img = requests.get(
            f"{base}/Items/{item_id}/Images/Logo",
            params={'api_key': token, 'format': 'png'},
            timeout=15,
        )
        if img.status_code == 200 and len(img.content) > 1000:
            return img.content
    except Exception:
        pass
    return None


def fetch_logo_from_plex(server, tmdb_id):
    """Sucht den Film via Plex-Library-Search und prueft auf Clearlogo."""
    base, token = server['base'], server['token']
    headers = {'X-Plex-Token': token, 'Accept': 'application/json'}
    try:
        # Schritt 1: alle Movie-Sections finden
        r = requests.get(f"{base}/library/sections", headers=headers, timeout=10)
        if r.status_code != 200:
            return None
        sections = (r.json().get('MediaContainer', {}).get('Directory') or [])
        movie_keys = [s.get('key') for s in sections if s.get('type') == 'movie']

        # Schritt 2: in jeder Section nach TMDB-GUID suchen
        target_guid = f"tmdb://{tmdb_id}"
        item_key = None
        for sk in movie_keys:
            r2 = requests.get(
                f"{base}/library/sections/{sk}/all",
                headers=headers,
                params={'guid': target_guid},
                timeout=15,
            )
            if r2.status_code != 200:
                continue
            mc = r2.json().get('MediaContainer', {})
            for it in (mc.get('Metadata') or []):
                guids = [g.get('id') for g in (it.get('Guid') or [])]
                if target_guid in guids or any(target_guid in (g or '') for g in guids):
                    item_key = it.get('ratingKey')
                    break
            if item_key:
                break

        if not item_key:
            return None

        # Schritt 3: Metadata mit clearLogo abrufen
        r3 = requests.get(
            f"{base}/library/metadata/{item_key}",
            headers=headers,
            timeout=10,
        )
        if r3.status_code != 200:
            return None
        md = r3.json().get('MediaContainer', {}).get('Metadata', [])
        if not md:
            return None
        item = md[0]
        clear_logo = (item.get('clearLogo')
                      or item.get('thumb')  # Notnagel, NICHT Default
                      )
        # Genauer: Plex stellt clearLogo als attribute oder unter /library/metadata/{key}/clearLogo
        logo_path = item.get('clearLogo')
        if not logo_path:
            return None

        # Plex liefert Pfade relativ zur Library, mit Token konkat
        if logo_path.startswith('/'):
            img_url = f"{base}{logo_path}?X-Plex-Token={token}"
        else:
            img_url = logo_path

        img = requests.get(img_url, headers=headers, timeout=15)
        if img.status_code == 200 and len(img.content) > 1000:
            return img.content
    except Exception:
        pass
    return None


def fetch_logo_from_any_server(tmdb_id):
    """Fragt alle aktiven Server der Reihe nach an. Erster Treffer gewinnt."""
    for server in SERVERS:
        if server['type'] == 'plex':
            logo = fetch_logo_from_plex(server, tmdb_id)
        else:
            logo = fetch_logo_from_jellyfin(server, tmdb_id)
        if logo:
            return logo, server['type'], server['name']
    return None, None, None


# --- ZIP-Patch ----------------------------------------------------------
def patch_zip_with_logo(zip_path, logo_bytes, source_label):
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.zip')
    os.close(tmp_fd)
    try:
        with zipfile.ZipFile(zip_path, 'r') as old_zip:
            with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as new_zip:
                meta_updated = False
                for item in old_zip.infolist():
                    name = item.filename
                    if name.lower().endswith(('clearlogo.png', 'clearlogo.jpg',
                                              'clearlogo.jpeg', 'clearlogo.webp')):
                        continue
                    if name == 'metadata.json':
                        try:
                            meta = json.loads(old_zip.read(name))
                        except Exception:
                            meta = {}
                        meta['clearlogo'] = 'clearlogo.png'
                        meta['clearlogoSource'] = source_label
                        new_zip.writestr('metadata.json',
                                         json.dumps(meta, indent=2, ensure_ascii=False))
                        meta_updated = True
                    else:
                        new_zip.writestr(item, old_zip.read(name))
                new_zip.writestr('clearlogo.png', logo_bytes)
                if not meta_updated:
                    new_zip.writestr('metadata.json',
                                     json.dumps({
                                         'clearlogo': 'clearlogo.png',
                                         'clearlogoSource': source_label,
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
    candidates_all = find_zips_needing_logo()

    skipped_cache = 0
    candidates = []
    for c in candidates_all:
        if is_recently_skipped(cache, c[2]) and c[3] != 'generated':
            skipped_cache += 1
            continue
        candidates.append(c)

    print(f"  Kandidaten: {len(candidates_all)} (davon {skipped_cache} via Cache uebersprungen)")
    print(f"  Verbleibend: {len(candidates)}\n")

    erfolg = 0
    kein_logo = 0
    fehler = 0

    for i, (name, zpath, tmdb_id, src) in enumerate(candidates, 1):
        prefix = f"  [{i}/{len(candidates)}]"
        suffix = " (replace generated)" if src == 'generated' else ""
        try:
            logo, server_type, server_name = fetch_logo_from_any_server(tmdb_id)
            if not logo:
                print(f"{prefix} {name} — kein Logo lokal{suffix}")
                mark_skipped(cache, tmdb_id)
                kein_logo += 1
                continue

            if patch_zip_with_logo(zpath, logo, server_type):
                kb = len(logo) / 1024
                print(f"{prefix} {name} — Logo aus {server_name} ({kb:.0f} KB){suffix}")
                erfolg += 1
                cache.get('noLocal', {}).pop(str(tmdb_id), None)
            else:
                fehler += 1
        except Exception as e:
            print(f"{prefix} {name} — Fehler: {e}")
            fehler += 1

        if i % 30 == 0:
            time.sleep(1)

    save_negative_cache(cache)

    print(f"""
==============================
  Ergebnis (Local):
  Eingebaut:       {erfolg}
  Kein Logo:       {kein_logo}
  Fehler:          {fehler}
  Cache-Skip:      {skipped_cache}
  Gesamt geprueft: {len(candidates_all)}
==============================
""")
    return 0 if fehler == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
