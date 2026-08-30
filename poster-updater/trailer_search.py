#!/usr/bin/env python3
"""
YouTube-Suche als Fallback fuer download-trailers.py.

Greift nur, wenn TMDB keinen Trailer kennt, keinen Treffer liefert oder das von
TMDB referenzierte Video nicht mehr verfuegbar ist. Beispiel 2026-08-30:
Toy Story 5 -- TMDB zeigte auf ein geloeschtes Video, die Suche fand den
offiziellen deutschen Trailer sofort.

Damit kein falsches Video in der Kiosk-Rotation landet, muss jeder Treffer
ALLE Pruefungen bestehen (Praezision vor Trefferquote -- ein fehlender Trailer
faellt nicht auf, ein falscher sofort):
  - Dauer 20 s bis 6 min (keine Clips, keine ganzen Filme, keine Reviews)
  - "Trailer" oder "Teaser" im Videotitel
  - keine Reactions/Reviews/Breakdowns/Fan-Made/Parodien/Making-ofs
  - Titelwort-Abgleich (deutscher ODER Originaltitel) mit Schwelle nach
    Titellaenge: 1-2 Woerter -> alle, 3-4 -> 75 %, ab 5 -> 60 %. Generische
    Woerter (trailer, official, deutsch, hd, ...), Jahreszahlen und
    Einzelbuchstaben zaehlen nicht; Zahlwoerter werden vereinheitlicht
    ("Thirteen"/"XIII" = 13).
  - Titel mit nur einem aussagekraeftigen Wort ("Driver", "The Quest")
    brauchen zusaetzlich das Filmjahr im Videotitel
  - steht eine Jahreszahl im Videotitel, muss sie zum Film passen (+-1)
Gelernt aus den Fehlgriffen des ersten Laufs (2026-08-30): "Beach Party
Animals (2006)" -> "The Quest (1996)", "Elvis & Priscilla" -> "Elvis & Nixon",
"Was ist Was - Unsere Erde" -> "PLANET 4K - Unsere Erde".

Rangfolge wie die TMDB-Prioritaet des Scripts: Sprache vor Offizialitaet
(deutscher Treffer schlaegt englischen "Official Trailer"), dann "official",
"Trailer" vor "Teaser", typische Trailerlaenge, Jahr im Titel.
"""

import re
import unicodedata

MIN_DURATION = 20
MAX_DURATION = 6 * 60
YEAR_TOLERANCE = 1

# Bewusst klein: Stoppwoerter verkleinern nur den Nenner des Abgleichs (= lockerer).
STOPWORDS = {
    'der', 'die', 'das', 'ein', 'eine', 'und', 'im', 'am', 'von', 'zu', 'den', 'dem',
    'the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'at', 'it',
    'le', 'la', 'les', 'el', 'los', 'il', 'de', 'du', 'des', 'et', 'y',
}
# Kommen in fast jedem Trailer-Titel vor -- sagen nichts ueber den Film.
GENERIC = {
    'trailer', 'teaser', 'film', 'movie', 'hd', 'uhd', '4k', '1080p', '2k',
    'official', 'offizieller', 'offizielle', 'offiziell', 'deutsch', 'german', 'ov', 'omu',
}
BAD_WORDS = (
    'reaction', 'reagiert', 'review', 'kritik', 'breakdown', 'explained', 'erklaert', 'erklärt',
    'fan made', 'fanmade', 'fan-made', 'concept', 'parody', 'parodie', 'recap',
    'deleted scene', 'clip', 'szene', 'behind the scenes', 'making of', 'making-of',
    'featurette', 'interview', 'analyse', 'analysis', 'theory', 'theorie', 'easter egg',
    'ganzer film', 'full movie', 'kompletter film', 'soundtrack', ' ost ',
)
GERMAN_HINTS = (
    'deutsch', 'german', 'synchro', 'offiziell', 'kino', 'untertitel',
    ' dt ', '(dt.)', 'ger)', 'ger ',
)
YEAR_RE = re.compile(r'(?<!\d)(19\d{2}|20\d{2})(?!\d)')

# Zahlwoerter -> Ziffern, damit "Ocean's 13" und "Ocean's Thirteen" zusammenfinden.
_NUMBER_WORDS = {
    'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6', 'seven': '7',
    'eight': '8', 'nine': '9', 'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
    'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17', 'eighteen': '18',
    'nineteen': '19', 'twenty': '20',
    'eins': '1', 'zwei': '2', 'drei': '3', 'vier': '4', 'fuenf': '5', 'funf': '5', 'sechs': '6',
    'sieben': '7', 'acht': '8', 'neun': '9', 'zehn': '10', 'elf': '11', 'zwoelf': '12', 'zwolf': '12',
    'dreizehn': '13',
    'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9',
    'x': '10', 'xi': '11', 'xii': '12', 'xiii': '13', 'xiv': '14', 'xv': '15',
}


def _tokens(text):
    """Kleingeschriebene, akzentfreie Wortmenge: ohne Stoppwoerter, generische
    Woerter, Jahreszahlen und Einzelzeichen; Zahlwoerter vereinheitlicht."""
    text = unicodedata.normalize('NFKD', text or '')
    text = ''.join(c for c in text if not unicodedata.combining(c))
    out = set()
    for word in re.findall(r'[a-z0-9]+', text.lower()):
        word = _NUMBER_WORDS.get(word, word)
        if len(word) < 2 or word in STOPWORDS or word in GENERIC or YEAR_RE.fullmatch(word):
            continue
        out.add(word)
    return out


def _required_overlap(token_count):
    if token_count <= 2:
        return 1.0
    if token_count <= 4:
        return 0.75
    return 0.6


def _years_in(text):
    return [int(y) for y in YEAR_RE.findall(text or '')]


def _year_matches(years, year):
    return any(abs(y - year) <= YEAR_TOLERANCE for y in years)


def title_match(film_title, video_title, film_year=None, require_year=False):
    """
    Anteil der Film-Titelwoerter im Videotitel (0..1), oder None, wenn der Titel
    die laengenabhaengige Schwelle verfehlt bzw. das Jahr im Videotitel fehlt,
    obwohl es Pflicht ist.
    """
    film_tokens = _tokens(film_title)
    if not film_tokens:
        return None
    overlap = len(film_tokens & _tokens(video_title)) / len(film_tokens)
    if overlap < _required_overlap(len(film_tokens)):
        return None
    # Jahr im Videotitel ist Pflicht bei Ein-Wort-Titeln, bei Filmen vor 1980 und
    # bei Titel-Dubletten der Filmliste (require_year): Klassiker haben oft
    # gleichnamige Remakes ("Der Hauptmann von Koepenick" 1931/1956, Anaconda,
    # Die Mumie, Godzilla, Nikita ...), und die echten Trailer alter Filme tragen
    # auf YouTube das Jahr praktisch immer im Titel (alle korrekten Treffer der
    # Testlaeufe taten es).
    needs_year = require_year or len(film_tokens) == 1 or (film_year is not None and film_year < 1980)
    if needs_year and not (film_year and _year_matches(_years_in(video_title), film_year)):
        return None
    return overlap


def score_candidate(cand, film_titles, year=None, require_year=False):
    """Bewertet ein Suchergebnis. None = ungeeignet, sonst je hoeher, desto besser.
    film_titles: [deutscher Titel, optional Originaltitel] -- Reihenfolge zaehlt.
    require_year: Jahr im Videotitel ist Pflicht (Titel-Dublette in der Filmliste)."""
    title = cand.get('title') or ''
    low = f' {title.lower()} '
    duration = cand.get('duration')
    if duration is None or not (MIN_DURATION <= duration <= MAX_DURATION):
        return None
    if 'trailer' not in low and 'teaser' not in low:
        return None
    if any(bad in low for bad in BAD_WORDS):
        return None

    film_year = int(year) if year and str(year).isdigit() else None
    years = _years_in(title)
    if film_year and years and not _year_matches(years, film_year):
        return None  # Jahr im Videotitel widerspricht dem Film

    titles = [t for t in film_titles if t]
    matches = [
        m for m in (title_match(t, title, film_year, require_year) for t in titles) if m is not None
    ]
    if not matches:
        return None

    score = max(matches)
    german_title = titles[0] if titles else None
    original_title = titles[1] if len(titles) > 1 else None
    if is_german(cand, german_title, original_title):
        score += 0.5  # Sprache vor Offizialitaet (wie DE-offiziell > DE > EN-offiziell > EN)
    if 'official' in low or 'offiziell' in low:
        score += 0.3
    if 'trailer' in low:
        score += 0.1
    if 60 <= duration <= 200:
        score += 0.1
    if film_year and _year_matches(years, film_year):
        score += 0.1
    return score


def is_german(cand, german_title=None, original_title=None):
    """Deutscher Trailer? Hinweiswoerter (deutsch/german/offiziell/kino) oder
    Umlaute/ß im Videotitel -- oder das Video traegt den deutschen Filmtitel
    statt des Originaltitels ("Arielle die Meerjungfrau" statt "The Little
    Mermaid"). Letzteres nur, wenn der Originaltitel selbst lateinisch und
    mehrwortig ist -- bei japanischen Originaltiteln waere die Regel wertlos."""
    title = cand.get('title') or ''
    low = f' {title.lower()} '
    if any(hint in low for hint in GERMAN_HINTS) or any(c in title for c in 'äöüÄÖÜß'):
        return True
    if not german_title or not original_title:
        return False
    if german_title.strip().lower() == original_title.strip().lower():
        return False
    if len(_tokens(original_title)) < 2:
        return False
    german_hit = title_match(german_title, title)
    original_hit = title_match(original_title, title)
    return german_hit is not None and german_hit >= 0.8 and original_hit is None


def rank_candidates(entries, film_titles, year=None, exclude_ids=(), require_year=False):
    """Geeignete Suchergebnisse, beste zuerst."""
    ranked = []
    for entry in entries or []:
        if not entry or entry.get('id') in exclude_ids:
            continue
        score = score_candidate(entry, film_titles, year, require_year)
        if score is not None:
            ranked.append((score, entry))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [entry for _, entry in ranked]


def pick_candidate(entries, film_titles, exclude_ids=(), year=None):
    """Bestes geeignetes Suchergebnis oder None."""
    ranked = rank_candidates(entries, film_titles, year, exclude_ids)
    return ranked[0] if ranked else None


def build_queries(title, original_title, year):
    """Deutsch zuerst, dann Originaltitel, dann neutral."""
    queries = [f'{title} {year} trailer deutsch']
    if original_title and original_title.strip().lower() != title.strip().lower():
        queries.append(f'{original_title} {year} official trailer')
    queries.append(f'{title} {year} trailer')
    return queries


def _to_candidate(entry, german_title=None, original_title=None):
    video_id = entry.get('id')
    return {
        'id': video_id,
        'url': entry.get('url') or entry.get('webpage_url') or f'https://www.youtube.com/watch?v={video_id}',
        'label': 'DE' if is_german(entry, german_title, original_title) else 'EN',
        'title': entry.get('title'),
        'duration': entry.get('duration'),
    }


def search_youtube_trailer_candidates(title, original_title, year, exclude_ids=(),
                                      max_results=10, max_candidates=3, extract=None,
                                      require_year=False):
    """
    Sucht per yt-dlp (ytsearch) Trailer-Kandidaten, beste zuerst (max. max_candidates).
    Es zaehlt die erste Query, die brauchbare Treffer liefert (deutsch vor Original).
    require_year: Jahr im Videotitel ist Pflicht (Titel-Dublette in der Filmliste).
    `extract` ist injizierbar (Tests); Standard: yt_dlp flat extraction.
    """
    if extract is None:
        import yt_dlp

        def extract(query):
            opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': 'in_playlist',
                'noplaylist': True,
                'socket_timeout': 30,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f'ytsearch{max_results}:{query}', download=False)
            return (info or {}).get('entries') or []

    # Reihenfolge ist Bedeutung: [deutscher Titel, Originaltitel] (siehe score_candidate)
    film_titles = [title] + ([original_title] if original_title and original_title != title else [])
    for query in build_queries(title, original_title, year):
        try:
            entries = extract(query)
        except Exception:
            continue
        ranked = rank_candidates(entries, film_titles, year, exclude_ids, require_year)
        if ranked:
            return [_to_candidate(e, title, original_title) for e in ranked[:max_candidates]]
    return []


def search_youtube_trailer(title, original_title, year, exclude_ids=(), max_results=6, extract=None):
    """Bester Kandidat als (url, label, video_title, duration) oder (None, None, None, None)."""
    cands = search_youtube_trailer_candidates(
        title, original_title, year, exclude_ids=exclude_ids, max_results=max_results, extract=extract
    )
    if not cands:
        return None, None, None, None
    best = cands[0]
    return best['url'], best['label'], best['title'], best['duration']
