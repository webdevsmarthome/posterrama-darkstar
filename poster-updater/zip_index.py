"""
TMDB-ID -> vorhandene PosterPack-ZIPs (z-20).

Die zwei Emby-Server benennen denselben Film teils unterschiedlich ("Top Gun -
Maverick" / "Top Gun: Maverick"). Poster- und Trailer-Script benennen ZIP und
Trailer nach dem Filmlisten-Titel und prueften bisher nur, ob genau diese Datei
existiert -- jede Schreibweise bekam so ein eigenes PosterPack und einen eigenen
Trailer.

Quelle ist der ZIP-Scan-Cache des Servers (cache/zip-scan-cache.json): Er enthaelt
die metadata.json jedes ZIPs, es muss kein ZIP geoeffnet werden. Frisch geladene
ZIPs fehlen darin bis zum naechsten Playlist-Refresh -- innerhalb eines Laufs
tragen die Scripts neu erzeugte IDs deshalb selbst nach.
"""
import json
import os
import re
import unicodedata


def load_zip_tmdb_index(project_root):
    """dict: TMDB-ID (str) -> set der ZIP-Namen ohne .zip (NFC), nur existierende Dateien."""
    cache_path = os.path.join(project_root, 'cache', 'zip-scan-cache.json')
    index = {}
    try:
        with open(cache_path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
    except (OSError, ValueError):
        return index
    if not isinstance(cache, dict):
        return index
    for zip_path, entry in cache.items():
        meta = (entry or {}).get('z') if isinstance(entry, dict) else None
        tmdb_id = (meta or {}).get('tmdbId')
        if tmdb_id in (None, '') or not os.path.exists(zip_path):
            continue
        name = re.sub(r'\.zip$', '', os.path.basename(zip_path), flags=re.IGNORECASE)
        index.setdefault(str(tmdb_id), set()).add(unicodedata.normalize('NFC', name))
    return index
