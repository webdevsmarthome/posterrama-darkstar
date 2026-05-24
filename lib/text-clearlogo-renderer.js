'use strict';

/**
 * Text-Clearlogo-Renderer
 *
 * Letzte Stufe der Clearlogo-Pipeline: rendert den Filmtitel als weißen,
 * stilisierten Schriftzug auf transparentem Hintergrund — Notlösung für
 * Filme, für die weder TMDB, fanart.tv noch der lokale Media-Server ein
 * Logo liefern. Output ist ein 1200×400 PNG mit Alpha-Kanal.
 *
 * Render-Engine: Sharp + librsvg via SVG-Buffer. Fonts werden über Pango
 * aus dem System geladen (auf Pi: DejaVu Sans Bold).
 */

const sharp = require('sharp');

const CANVAS_W = 1200;
const CANVAS_H = 400;

function escapeXml(s) {
    return String(s == null ? '' : s).replace(
        /[<>&"']/g,
        c =>
            ({
                '<': '&lt;',
                '>': '&gt;',
                '&': '&amp;',
                '"': '&quot;',
                "'": '&apos;',
            })[c]
    );
}

// Heuristik: nominelle Schriftgröße abhängig von Titellänge. Empirisch
// kalibriert für DejaVu Sans Bold (Pi-Default-Font), char-width-Faktor
// ≈ 0.62. textLength wird von librsvg ignoriert, daher ist die Größe
// das einzige Mittel gegen Clipping. Sehr lange Titel werden in 2 Zeilen
// gesetzt (splitTitleIntoLines).
function pickFontSize(title) {
    const len = String(title || '').length;
    if (len <= 4) return 220;
    if (len <= 8) return 170;
    if (len <= 12) return 130;
    if (len <= 16) return 105;
    if (len <= 22) return 80;
    if (len <= 30) return 60;
    if (len <= 40) return 46;
    return 38;
}

// Long titles auf 2 Zeilen splitten: bevorzugt am natürlichen
// Trennzeichen (" - ", " – ", " — ", " | ", ": "), sonst am
// nächstgelegenen Leerzeichen zur Mitte. Erlaubt jeder Zeile
// trotzdem die volle Fontgröße eines kürzeren Titels.
function splitTitleIntoLines(title) {
    const s = String(title || '').trim();
    if (s.length <= 22) return [s];
    const separators = [' – ', ' — ', ' - ', ' | ', ': '];
    for (const sep of separators) {
        const idx = s.indexOf(sep);
        if (idx > 0 && idx < s.length - sep.length) {
            return [s.slice(0, idx).trim(), s.slice(idx + sep.length).trim()];
        }
    }
    // Fallback: am Leerzeichen nächstmöglich zur Mitte splitten
    const mid = Math.floor(s.length / 2);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ' ') {
            const dist = Math.abs(i - mid);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }
    }
    if (bestIdx > 0) {
        return [s.slice(0, bestIdx).trim(), s.slice(bestIdx + 1).trim()];
    }
    return [s];
}

function buildSvg(title) {
    const lines = splitTitleIntoLines(title);
    // Pro Zeile eigene Fontgröße, dann nimm die kleinere (beide Zeilen
    // gleich groß damit es proportional aussieht).
    const sizes = lines.map(pickFontSize);
    const fontSize = Math.min(...sizes);
    const safeLines = lines.map(escapeXml);
    const isMultiline = safeLines.length > 1;
    // Zeilenpositionen: bei 1 Zeile zentriert; bei 2 Zeilen ein wenig
    // auseinander mit fontSize * 1.05 als line-height
    const lineHeight = Math.round(fontSize * 1.05);
    let textLines;
    if (isMultiline) {
        const totalH = lineHeight * (safeLines.length - 1);
        const startY = CANVAS_H / 2 - totalH / 2;
        textLines = safeLines
            .map((t, i) => `<tspan x="${CANVAS_W / 2}" y="${startY + i * lineHeight}">${t}</tspan>`)
            .join('');
    } else {
        textLines = `<tspan x="${CANVAS_W / 2}" y="${CANVAS_H / 2}">${safeLines[0]}</tspan>`;
    }

    // SVG mit Drop-Shadow-Filter + weißem Fill + schwarzem Stroke.
    // Font-Stack startet mit kondensierten/bold System-Fonts; auf einem
    // typischen Posterrama-Server (Pi, Debian) löst Pango das zu
    // DejaVu Sans Bold auf, was für Clearlogo-Optik akzeptabel ist.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" width="${CANVAS_W}" height="${CANVAS_H}">
  <defs>
    <filter id="dshadow" x="-10%" y="-10%" width="120%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="5"/>
      <feOffset dx="0" dy="6"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <text font-family="'DejaVu Sans','Liberation Sans',Impact,sans-serif"
        font-size="${fontSize}"
        font-weight="900"
        fill="#ffffff"
        stroke="#000000"
        stroke-width="${Math.max(3, Math.round(fontSize * 0.05))}"
        paint-order="stroke fill"
        text-anchor="middle"
        dominant-baseline="central"
        filter="url(#dshadow)">${textLines}</text>
</svg>`;
}

async function renderTextClearlogo(title) {
    const svg = buildSvg(title);
    return sharp(Buffer.from(svg), { density: 144 })
        .resize(CANVAS_W, CANVAS_H, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

module.exports = {
    renderTextClearlogo,
    buildSvg,
    pickFontSize,
    splitTitleIntoLines,
    CANVAS_W,
    CANVAS_H,
};
