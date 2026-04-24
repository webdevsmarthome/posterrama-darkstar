# Kiosk Performance Tuning (Pi 4)

**Status:** Aktiv seit 2026-04-24
**Scope:** Lokale Pi-Installation (Darkstar-Fork), Chromium-Kiosk auf `cinema.html`
**Zweck:** Chromium-Kiosk am Raspberry Pi 4 so konfigurieren, dass Trailer und Poster-Fade-Transitions im Portrait-Modus ruckelfrei laufen — ohne auf Bildqualität zu verzichten, die der Betrachter am Monitor tatsächlich sieht.

---

## Rahmenbedingungen

- **Hardware:** Raspberry Pi 4 Model B (4 GB), VC4-KMS-Treiber, BCM2835-Codec für H.264 in Hardware
- **Display:** Dell U2720Q 27" 4K, angeschlossen an HDMI-0 (HDMI-A-1)
- **Montage:** Portrait (270° gedreht) — Cinema-Modus zeigt hochformatige Poster
- **Compositor:** `labwc` (wlroots-basiert, Wayland)
- **Browser:** Chromium (Debian Trixie, Version 147+), Kiosk-Modus

## Das Problem

Bei 3840×2160 @ 60 Hz + 270° Rotation + Chromium-Kiosk waren folgende Symptome sichtbar:

1. **Trailer ruckeln** — sowohl YouTube (VP9/AV1, software-dekodiert) als auch lokale HTML5-Videos
2. **Fade-Transitions zwischen Postern stockten**
3. **Chromium-CPU-Summe ~270 % bei 60 Hz** — nahe am Limit der VC4-Software-Rotation

Ursachen:
- VC4 auf Pi 4 hat **keine Hardware-Rotationsebene** — Drehung läuft im Compositor als Shader, Kosten skalieren mit Pixelanzahl
- 4K-Rendering + Software-Rotation + 60-Hz-Output ist an der Pi-4-Kapazitätsgrenze
- Chromium-GPU-Defaults auf ARM Linux sind konservativ (viele Features per GPU-Blocklist deaktiviert)

## Lösung

Drei Stellschrauben, gemeinsam angewandt:

### 1. Auflösung 1920×1080 @ 60 Hz statt 4K

Der Dell U2720Q skaliert 1080p intern auf 4K mit Hardware-Scaler (im Display, nicht auf der Pi-GPU — also "kostenlos"). Sichtbare Qualität ist am 27"-Portrait-Monitor bei normalem Viewing-Abstand praktisch identisch.

**Konfiguration** in `~/.config/kanshi/config`:

```
profile dell_u2720q {
    output "Dell Inc. DELL U2720Q B3JBZ13" enable mode 1920x1080@60Hz position 0,0 transform 270
}
```

Reload: `kill -HUP $(pgrep kanshi)`.

Effekt:
- GPU-Pixelarbeit um **Faktor 4** reduziert (1080p vs 4K)
- Software-Rotation auf 1080p-Surface ist deutlich günstiger
- Lokale Trailer sind meist 1080p-Source → kein Upscaling-Overhead mehr
- Monitor-interne Skalierung füllt 4K-Panel

### 2. Chromium-Flags

In `~/.local/bin/posterrama-kiosk.sh` (Launcher-Script, s. u.) werden vier Flags ergänzt, die auf Pi 4 spürbare Entlastung bringen:

| Flag | Wirkung |
|---|---|
| `--ignore-gpu-blocklist` | Hebt die VC4-Blocklist-Einträge auf, sodass GPU-Features (Accelerated 2D, GPU-Rasterization) greifen |
| `--enable-gpu-rasterization` | Erzwingt GPU-basiertes Rendern der 2D-Inhalte (Default wäre auf Pi oft CPU) |
| `--enable-zero-copy` | Vermeidet CPU↔GPU-Speicher-Kopien für Texturen |
| `--canvas-oop-rasterization` | Out-of-process Canvas-Rasterization (entlastet Renderer-Prozess) |

Zusätzlich weiterhin aktiv (unverändert):
- `--ozone-platform=wayland` + `--enable-features=UseOzonePlatform` — native Wayland statt XWayland
- `--autoplay-policy=no-user-gesture-required` — Trailer-Autoplay

### 3. Launcher-Script statt Inline-Heredoc im Autostart

Ursprünglich stand der komplette Chromium-Befehl mit allen Flags als `while true; do chromium ... ; done &`-Schleife direkt im labwc-Autostart. Problem: Bash parst den Loop-Body einmal bei labwc-Start; spätere Edits an der Datei wirken **nicht** — neue Flags erreichen den nächsten Chromium-Relaunch nicht.

Lösung: Chromium-Aufruf in ein eigenes Script auslagern. Der Autostart-Loop ruft das Script bei jeder Iteration frisch auf, Flag-Änderungen wirken sofort beim nächsten Chromium-Neustart (z. B. `pkill -u $UID '^chromium$'`).

**`~/.local/bin/posterrama-kiosk.sh`:**

```bash
#!/bin/bash
env XCURSOR_THEME=blank-cursor XCURSOR_SIZE=32 chromium \
    --kiosk --noerrdialogs \
    --disable-infobars --disable-session-crashed-bubble \
    --autoplay-policy=no-user-gesture-required --no-first-run \
    --disable-features=Translate,PasswordManagerOnboarding \
    --password-store=basic --use-mock-keychain \
    --deny-permission-prompts \
    --ozone-platform=wayland --enable-features=UseOzonePlatform \
    --ignore-gpu-blocklist \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --canvas-oop-rasterization \
    http://localhost:4000/cinema.html
```

**`~/.config/labwc/autostart`** (relevanter Block):

```bash
while true; do
  /home/helmut/.local/bin/posterrama-kiosk.sh
  sleep 2
done &
```

## Setup

```bash
# 1. Launcher-Script ablegen
install -m 0755 posterrama-kiosk.sh ~/.local/bin/posterrama-kiosk.sh

# 2. labwc-Autostart: while-Loop auf Script umstellen (siehe oben)

# 3. kanshi-Mode auf 1080p@60Hz
sed -i 's/3840x2160@60Hz/1920x1080@60Hz/' ~/.config/kanshi/config

# 4. Kanshi neu laden + Chromium-Loop neu anstoßen
kill -HUP $(pgrep kanshi)
pkill -u "$(id -u)" '^chromium$'   # Loop restartet Chromium mit neuen Flags
```

## Verifikation

```bash
# Aktueller Display-Mode
wlr-randr | grep -A1 HDMI-A-1 | grep current
# → 1920x1080 px, 60.000000 Hz (current)

# Chromium hat die neuen Flags
pid=$(pgrep -u "$(id -u)" '^chromium$' | while read p; do
  cmd=$(tr '\0' ' ' < /proc/$p/cmdline)
  [[ "$cmd" == *"--kiosk"* ]] && echo "$p" && break
done)
tr '\0' '\n' < /proc/$pid/cmdline | grep -E "ignore-gpu|zero-copy|canvas-oop|gpu-rasterization"

# Pi-Throttling-Status (sollte 0x0 sein, nicht 0x50000 o. ä.)
vcgencmd get_throttled
```

Während ein Trailer läuft:
```bash
# Live Throttle/Temp/Voltage beobachten
watch -n 1 'vcgencmd get_throttled; vcgencmd measure_temp; vcgencmd measure_volts core'
```

## Beobachtete Zahlen (Referenz)

| Konfiguration | Chromium Σ CPU | Trailer-Flüssigkeit | Fade-Transitions |
|---|---|---|---|
| 4K @ 30 Hz + Portrait | 130–180 % | Judder (5:4-Pulldown bei 24fps) | spürbar stockend |
| 4K @ 60 Hz + Portrait | 240–280 % | immer noch ruckeln (GPU-Limit) | stockend |
| **1080p @ 60 Hz + Portrait** | **spürbar niedriger** | **ruckelfrei** | **flüssig** |

Bei gleichzeitigem Throttling (`throttled != 0x0`, z. B. bei Undervoltage) reicht auch die 1080p-Konfiguration nicht — dort muss Hardware (Netzteil, Kühlung) zuerst in Ordnung sein.

## Zusammenhang mit dem Monitor Power Watcher

Der Kiosk-Launcher spawnt Chromium normalerweise, der Monitor-Power-Watcher (siehe `MONITOR-POWER-WATCHER.md`) friert es per SIGSTOP ein, wenn der Monitor aus ist. Beim Auftauen sendet der Watcher zusätzlich einen `wtype -k Right`, damit Cinema direkt aufs nächste Poster springt statt den eingefrorenen Frame zu zeigen.

Die beiden Systeme sind entkoppelt:
- Launcher-Script (dieser Doku) → Chromium-Lifecycle + Flags
- Watcher-Service (`monitor-power-watch.service`) → Power-Management

Änderungen am einen erfordern keine Anpassung am anderen.

## Was NICHT hilft (getestet)

- **4K @ 30 Hz beibehalten, nur Flags setzen** — GPU bleibt Limiting Factor, Trailer ruckeln weiter
- **VAAPI-Flags** (`--enable-features=VaapiVideoDecoder`) — Mesa auf Pi 4 exponiert kein VAAPI für VC4; keine Wirkung
- **`--use-gl=egl`** — marginaler Unterschied zu ANGLE-Default auf Pi 4
- **Chromium-Version wechseln (Stable vs. Beta)** — keine merkbare Änderung im Trailer-Playback
- **Disable Accelerated Video Decode** — führt zu noch stärkerem Ruckeln, eher Gegenrichtung

## Zukünftige Optimierungen (nicht umgesetzt)

- **Chromium-Window nativ in Portrait rendern** (Dimensionen 1080×1920, keine Compositor-Rotation mehr) → würde Software-Rotation komplett eliminieren. Erfordert aber ein CSS-Portrait-Layout im Cinema oder manuelles Rotieren der Page. Nicht nötig, solange 1080p ausreichend flüssig läuft.
- **Raspberry Pi 5** — mit V3D 7.1.7 und Hardware-Rotationsebene wäre 4K60 Portrait voraussichtlich ohne Tricks machbar.
