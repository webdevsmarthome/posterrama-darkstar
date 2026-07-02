#!/usr/bin/env python3
import requests
import json
import zipfile
import os
import shutil
import re
import signal
import sys

print("""
**************************************************************
* Posterrama TMDB Export - Full-Blown-Solution                *
* Version 2026.07.02                                         *
*                                                            *
* CLEARLOGO + Multiple Posters/Backdrops (DE/EN/Textfrei)    *
* BEST nach TMDB Vote Average                                *
* FULL Cast + Crew (Director/Writer)                         *
* Budget/Revenue/Original Title                              *
* 'images'-Array fuer Posterrama Smart-Selection             *
* 15-50MB/ZIP (komplett)                                     *
**************************************************************
""")

# SIGTERM (z.B. Kill durch Orchestrator/Timeout) → SystemExit, damit die
# finally-Cleanups laufen und keine tmp_-Ordner liegen bleiben.
signal.signal(signal.SIGTERM, lambda *_a: sys.exit(143))

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CONFIG_PATH = os.path.join(PROJECT_ROOT, 'config.json')
FILMLISTE_PATH = 'filmliste.txt'
OUTPUT_DIR = os.environ.get('POSTERRAMA_TMDB_EXPORT_DIR') or os.path.join(
    PROJECT_ROOT, 'media', 'complete', 'tmdb-export')

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

BASE_URL = 'https://api.themoviedb.org/3'
IMG_URL = 'https://image.tmdb.org/t/p'

print(f"""
📋 KONFIGURATION:
   API-Key:   {TMDB_API_KEY[:4]}...{TMDB_API_KEY[-4:]}
   Output:    {OUTPUT_DIR}
   Filmliste: {FILMLISTE_PATH}
""")

auto_confirm = '--yes' in sys.argv
if not auto_confirm:
    if input("\nKorrekte Angaben? (J/N): ").strip().upper() != 'J':
        print("❌ Abgebrochen.")
        sys.exit(0)

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Verwaiste tmp_-Ordner aus abgestürzten/gekillten Läufen entfernen — die
# Namen sind index-basiert und passen nach Filmlisten-Änderung nie wieder.
for _stale in os.listdir('.'):
    if os.path.isdir(_stale) and re.match(r'^tmp_\d{3,}_', _stale):
        print(f"🧹 Entferne verwaisten Temp-Ordner: {_stale}")
        shutil.rmtree(_stale, ignore_errors=True)

if not os.path.exists(FILMLISTE_PATH):
    print(f"❌ {FILMLISTE_PATH} fehlt!")
    sys.exit(1)

with open(FILMLISTE_PATH, 'r', encoding='utf-8') as f:
    films = [line.strip() for line in f.readlines() if line.strip()]

# Format-Erweiterung: "Titel (Jahr)[tmdb:NNNN]" — die TMDB-ID-Hinweis-Syntax
# wird vom emby-sync geschrieben und erlaubt dem Downloader, die Suche zu
# überspringen und direkt die korrekte TMDB-ID zu verwenden (Prevention gegen
# falsche Mehrdeutigkeits-Treffer der TMDB-Suche).
TMDB_HINT_RE = re.compile(r'^(.+?)\s*\[tmdb:(\d+)\]\s*$')
def parse_filmliste_entry(line):
    m = TMDB_HINT_RE.match(line)
    if m:
        return m.group(1).strip(), int(m.group(2))
    return line.strip(), None

print(f"\n🎬 {len(films)} Filme gefunden (FULL IMAGES)")

def api_call(endpoint, params=None):
    # Kopie statt Mutation: kein Mutable-Default, und ein vom Aufrufer
    # gesetztes 'language' (z.B. en-US-Tagline-Fallback) bleibt erhalten.
    params = dict(params or {})
    params['api_key'] = TMDB_API_KEY
    params.setdefault('language', 'de-DE')
    try:
        r = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=15)
        if r.status_code != 200:
            print(f"   ⚠️  API {endpoint}: HTTP {r.status_code}")
        return r.json()
    except Exception as e:
        print(f"   ⚠️  API {endpoint}: {e}")
        return None

def download_image(img_path, local_path):
    if not img_path: return False
    url = f"{IMG_URL}/w1280{img_path}"
    try:
        r = requests.get(url, timeout=15)
        if r.status_code != 200:
            return False
        with open(local_path, 'wb') as f:
            f.write(r.content)
        return True
    except Exception:
        return False

def remove_partial_zip(path):
    # Halbfertiges ZIP nicht liegen lassen — sonst gilt der Film beim
    # nächsten Lauf als "vorhanden" und wird für immer übersprungen.
    try:
        os.remove(path)
    except OSError:
        pass

erfolgreich = 0
uebersprungen = 0
fehler = 0
try:
    for i, raw_film in enumerate(films, 1):
        # Parse optional [tmdb:NNNN] hint
        film, tmdb_hint = parse_filmliste_entry(raw_film)
        print(f"\n🔄 [{i}/{len(films)}] {film}" + (f"  (TMDB-Hint: {tmdb_hint})" if tmdb_hint else ""))

        year_match = re.search(r'\((\d{4})\)', film)
        year = year_match.group(1) if year_match else ""
        clean_title = re.sub(r'\s*\(\d{4}\)', '', film).strip()

        zip_name = f"{clean_title} ({year}).zip"
        zip_path = os.path.join(OUTPUT_DIR, zip_name)

        if os.path.exists(zip_path):
            print(f"   ⏭️  ZIP vorhanden: {zip_name}")
            uebersprungen += 1
            continue

        tmp_dir = None
        try:
            movie_id = None
            if tmdb_hint:
                # Direkt die gehintete ID verwenden — keine Suche → keine falsche Treffer
                movie_id = tmdb_hint
                verify = api_call(f'movie/{movie_id}')
                if not verify or not verify.get('id'):
                    print(f"   ⚠️  TMDB-Hint {tmdb_hint} nicht auflösbar, Fallback auf Suche")
                    movie_id = None

            if not movie_id:
                search = api_call('search/movie', {'query': clean_title, 'year': year})
                if not search or not search.get('results'):
                    # Retry without year filter (sometimes year mismatch prevents results)
                    search = api_call('search/movie', {'query': clean_title})
                    if not search or not search.get('results'):
                        print(f"   ❌ Kein TMDB-Treffer fuer: '{clean_title}' ({year})")
                        fehler += 1
                        continue
                movie_id = search['results'][0]['id']

            # CORE DATA + FULL IMAGES
            details = api_call(f'movie/{movie_id}')
            if not details:
                print(f"   ❌ Details Fehler (ID: {movie_id})")
                fehler += 1
                continue

            # Ohne include_image_language filtert TMDB die Galerie auf das
            # 'language' des Requests (de) — EN-Poster, textfreie Backdrops
            # (iso_639_1 = null) und die meisten Clearlogos fehlen dann.
            images = api_call(f'movie/{movie_id}/images', {'include_image_language': 'de,en,null'})
            videos = api_call(f'movie/{movie_id}/videos', {'include_video_language': 'de,en'})
            credits = api_call(f'movie/{movie_id}/credits')
            release_dates = api_call(f'movie/{movie_id}/release_dates')

            # CERTIFICATION (DE bevorzugt, US Fallback)
            certification = ""
            if release_dates and release_dates.get('results'):
                cert_de = cert_us = ""
                for country in release_dates['results']:
                    iso = country.get('iso_3166_1', '')
                    for rel in country.get('release_dates', []):
                        c = (rel.get('certification') or '').strip()
                        if c:
                            if iso == 'DE' and not cert_de: cert_de = c
                            if iso == 'US' and not cert_us: cert_us = c
                certification = cert_de or cert_us

            # DIRECTORS + STUDIOS
            directors_list = []
            if credits and credits.get('crew'):
                directors_list = [c['name'] for c in credits['crew'] if c.get('job') == 'Director']
            studios_list = [c['name'] for c in details.get('production_companies', [])]

            # TEMP DIRECTORY (Cleanup garantiert im finally)
            safe_title = re.sub(r'[^\w-]+', '_', clean_title)[:20].strip('_') or 'film'
            tmp_dir = os.path.join(os.getcwd(), f"tmp_{i:03d}_{safe_title}")
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir)
            os.makedirs(f"{tmp_dir}/people", exist_ok=True)

            # CLEARLOGO (DE > EN > textfrei)
            clearlogo_path = ""
            if images and images.get('logos'):
                for want in ('de', 'en', None):
                    for logo in images['logos']:
                        if logo.get('iso_639_1') == want and logo.get('file_path'):
                            clearlogo_path = logo['file_path']
                            break
                    if clearlogo_path:
                        break
                if clearlogo_path:
                    download_image(clearlogo_path, f"{tmp_dir}/clearlogo.png")

            # BEST POSTERS (DE vor EN, dann Vote Average; erst filtern, dann
            # Top 5 — sonst verdrängen die zahlreichen EN-Poster die DE-Treffer)
            posters = []
            if images and images.get('posters'):
                candidates = [p for p in images['posters']
                              if (p.get('iso_639_1') or 'xx')[:2] in ['de', 'en']]
                candidates.sort(key=lambda x: (0 if x.get('iso_639_1') == 'de' else 1,
                                               -(x.get('vote_average') or 0)))
                for j, p in enumerate(candidates[:5]):
                    lang = (p.get('iso_639_1') or 'xx')[:2]
                    fname = f"poster_{lang}_{j+1}.jpg"
                    if download_image(p.get('file_path'), f"{tmp_dir}/{fname}"):
                        posters.append(fname)

            # BEST BACKDROPS (DE/EN/textfrei — Backdrops sind meist ohne Text)
            backdrops = []
            if images and images.get('backdrops'):
                candidates = [b for b in images['backdrops']
                              if (b.get('iso_639_1') or 'xx')[:2] in ['de', 'en', 'xx']]
                candidates.sort(key=lambda x: x.get('vote_average') or 0, reverse=True)
                for j, b in enumerate(candidates[:3]):
                    lang = (b.get('iso_639_1') or 'xx')[:2]
                    fname = f"backdrop_{lang}_{j+1}.jpg"
                    if download_image(b.get('file_path'), f"{tmp_dir}/{fname}"):
                        backdrops.append(fname)

            # FALLBACK Bilder
            download_image(details.get('poster_path'), f"{tmp_dir}/poster.jpg")
            download_image(details.get('backdrop_path'), f"{tmp_dir}/background.jpg")
            download_image(details.get('poster_path'), f"{tmp_dir}/thumbnail.jpg")

            # FULL CAST & CREW
            people_imgs = []
            cast_data = []
            if credits:
                # Cast (Top 15)
                for person in credits.get('cast', [])[:15]:
                    if person.get('profile_path'):
                        safe_name = re.sub(r'[^\w\s-]', '_', person['name']).strip().replace(' ', '_')
                        img_path = f"people/{safe_name}.jpg"
                        if download_image(person['profile_path'], f"{tmp_dir}/{img_path}"):
                            people_imgs.append(img_path)
                            cast_data.append({
                                "name": person['name'],
                                "role": person.get('character', ''),
                                "thumb": img_path
                            })

                # Crew (Director/Writer)
                for person in credits.get('crew', [])[:5]:
                    job = person.get('job', '')
                    if job in ['Director', 'Regisseur', 'Writer', 'Autor', 'Screenplay'] and person.get('profile_path'):
                        safe_name = re.sub(r'[^\w\s-]', '_', person['name']).strip().replace(' ', '_')
                        img_path = f"people/{safe_name}_crew.jpg"
                        if download_image(person['profile_path'], f"{tmp_dir}/{img_path}"):
                            people_imgs.append(img_path)
                            cast_data.append({
                                "name": person['name'],
                                "role": f"{job}",
                                "thumb": img_path
                            })

            # TRAILER (DE bevorzugt, EN Fallback)
            trailer = ""
            if videos and videos.get('results'):
                for want in ('de', 'en'):
                    for v in videos['results']:
                        if v.get('site') == 'YouTube' and v.get('type') == 'Trailer' and v.get('iso_639_1') == want:
                            trailer = f"https://www.youtube.com/watch?v={v['key']}"
                            break
                    if trailer:
                        break

            # TAGLINE (DE bevorzugt, EN Fallback)
            tagline = (details.get('tagline') or '').strip()
            if not tagline:
                details_en = api_call(f'movie/{movie_id}', {'language': 'en-US'})
                if details_en:
                    tagline = (details_en.get('tagline') or '').strip()

            # ULTIMATE METADATA
            metadata = {
                "itemType": "movie",
                "title": details.get('title', clean_title),
                "originalTitle": details.get('original_title', ''),
                "tagline": tagline,
                "year": int(year) if year else 0,
                "tmdbId": movie_id,
                "imdbId": details.get('imdb_id') or '',
                "genres": [g['name'] for g in details.get('genres', [])],
                "overview": details.get('overview', ''),
                "rating": round(details.get('vote_average') or 0, 3),
                "releaseDate": details.get('release_date', ''),
                "runtimeMs": (details.get('runtime') or 0) * 60000,
                "budget": details.get('budget', 0),
                "revenue": details.get('revenue', 0),
                "contentRating": certification,
                "director": directors_list[0] if directors_list else "",
                "directors": directors_list,
                "studio": studios_list[0] if studios_list else "",
                "studios": studios_list,
                "cast": cast_data,
                "peopleImages": people_imgs,
                "trailer": trailer,
                "clearlogo": "clearlogo.png" if os.path.exists(f"{tmp_dir}/clearlogo.png") else "",
                "images": {
                    "posters": posters,
                    "backdrops": backdrops,
                    "primaryPoster": posters[0] if posters else "poster.jpg",
                    "primaryBackdrop": backdrops[0] if backdrops else "background.jpg"
                },
                "source": "tmdb-ultimate"
            }

            with open(f"{tmp_dir}/metadata.json", 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)

            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                for root, _, files in os.walk(tmp_dir):
                    for file in files:
                        zf.write(os.path.join(root, file), os.path.relpath(os.path.join(root, file), tmp_dir))

            # ZIP-Größe
            zip_size = os.path.getsize(zip_path) / (1024*1024)
            erfolgreich += 1

            # ULTIMATE STATUS (aus metadata, nicht vom Dateisystem — der
            # tmp-Ordner ist gleich weg)
            has_clearlogo = bool(metadata['clearlogo'])
            poster_count = len(posters)
            backdrop_count = len(backdrops)
            cast_count = len([p for p in people_imgs if 'crew' not in p])
            crew_count = len([p for p in people_imgs if 'crew' in p])
            has_trailer = bool(trailer)

            status = f"({poster_count} Posters, {backdrop_count} Backdrops, {zip_size:.1f}MB"
            if has_clearlogo: status += " | 🌟 Clearlogo"
            status += f" | C{cast_count} Cast, W{crew_count} Crew"
            if has_trailer: status += " | 🎬 Trailer"

            print(f"   ✅ {zip_name} {status}")

        except KeyboardInterrupt:
            remove_partial_zip(zip_path)
            raise
        except Exception as e:
            print(f"   ❌ Fehler bei '{film}': {e}")
            remove_partial_zip(zip_path)
            fehler += 1
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)

except KeyboardInterrupt:
    print("\n\n⛔ Abbruch durch Benutzer (Ctrl+C) — Temp-Ordner aufgeräumt.")

print(f"\n🏆 ULTIMATE FERTIG! {erfolgreich} erfolgreich | {uebersprungen} übersprungen | {fehler} Fehler (von {len(films)})")
