# Monitor Power Watcher

**Status:** Aktiv seit 2026-04-24
**Scope:** Lokale Pi-Installation (Darkstar-Fork), nicht Teil des Posterrama-Code-Releases
**Zweck:** CPU/GPU-Last am Raspberry Pi reduzieren, wenn der direkt angeschlossene Monitor ausgeschaltet ist — ohne den Posterrama-Server zu pausieren, der weiterhin andere Clients bedient.

---

## Problem

Der Raspberry Pi 4 betreibt im Kiosk-Modus ein lokales Chromium (`http://localhost:4000/cinema.html`). Wenn der Dell U2720Q physisch ausgeschaltet wird:

- Kappt der Monitor das HDMI-Signal **nicht** (HPD bleibt oben, `/sys/class/drm/card1-HDMI-A-1/status` = `connected`).
- Folglich erkennt weder der Wayland-Compositor (`labwc`) noch Chromium, dass das Display dunkel ist.
- Chromium rendert mit voller Last weiter (gemessen: 160–275 % CPU über mehrere Prozesse), YouTube-Trailer laufen inkl. Audio.
- Die `Page Visibility API` löst nicht aus, weil das Fenster compositor-seitig sichtbar bleibt.

## Lösung

Ein User-Systemd-Service pollt alle 7 s per **DDC/CI** den Power-State des Monitors und friert das Chromium-Kiosk per `SIGSTOP` ein, sobald der Monitor aus ist. Bei Wieder-Einschalten: `SIGCONT`.

**Warum SIGSTOP/SIGCONT und nicht Output-Abschaltung?**
Die offensichtliche Alternative — `wlr-randr --output HDMI-A-1 --off` — ist auf dem Pi 4 mit VC4-KMS-Treiber + libliftoff defekt. Nach `--off` scheitert jeder Versuch des Re-Enable mit:

```
[libliftoff] drmCrtcGetSequence: Invalid argument
[types/output/swapchain.c] Swapchain for output 'HDMI-A-1' failed test
[backend/drm/libliftoff.c] liftoff_output_apply failed: Operation not permitted
```

Der CRTC-Zustand bleibt inkonsistent, ein Reboot ist dann erforderlich. **Nicht verwenden.**

## Komponenten

### 1. Watcher-Script

`~/.local/bin/monitor-power-watch.sh` — Bash-Endlosschleife, die:

1. Wartet bis der Wayland-Socket verfügbar ist (für robusten Start).
2. Initial per `ddcutil getvcp D6` den Power-State erfasst; falls Monitor beim Start bereits aus ist, sofort SIGSTOP.
3. Danach alle 7 s pollt. Bei Zustandswechsel:
   - `on → off`: `kill -STOP` an `pgrep -u <uid> '^chromium$'`
   - `off → on`: `kill -CONT` an dieselbe Menge, **plus** 300 ms später ein virtueller ArrowRight-Tastendruck via `wtype -k Right`. Dadurch wird in `cinema-display.js` der Keyboard-Handler getriggert (`window.__posterramaPlayback.next()`) → sofort neues Poster. Ohne diesen Schritt wäre beim Wieder-Einschalten kurz das eingefrorene alte Poster sichtbar.
4. Beim Beenden (TERM/INT/HUP/EXIT) immer `SIGCONT` an alle `^chromium$`-Prozesse — Cleanup-Trap verhindert, dass Chromium eingefroren zurückbleibt, wenn der Service stirbt.

**Wichtiges Detail**: Das Pattern `^chromium$` (nicht `-f chromium`) matched nur auf den Prozessnamen (`comm`), nicht auf die komplette Kommandozeile. Sonst würden Shell-Scripts, die das Wort "chromium" irgendwo im Body haben (z. B. Diagnose-Snippets), versehentlich mit eingefroren.

### 2. Systemd-User-Unit

`~/.config/systemd/user/monitor-power-watch.service`:

```ini
[Unit]
Description=Monitor power watcher (DDC/CI → Chromium SIGSTOP/SIGCONT)
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=/home/helmut/.local/bin/monitor-power-watch.sh
ExecStopPost=/usr/bin/pkill -CONT -u %U ^chromium$
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- Läuft als User-Service (kein Root nötig).
- `ExecStopPost` ist Gürtel-und-Hosenträger: Falls der Trap im Script nicht greift (z. B. SIGKILL durch Systemd-Timeout), sendet Systemd selbst noch einmal SIGCONT.
- `Restart=on-failure` fängt DDC-Hänger o. Ä. ab.

### 3. Voraussetzungen

- Pakete `ddcutil` und `wtype` installiert (`sudo apt install ddcutil wtype`).
- Kernelmodul `i2c_dev` geladen.
- `/dev/i2c-*` existieren (auf Pi 4 mit VC4-KMS automatisch).
- User in Gruppen `i2c` und `video`.
- Wayland-Compositor muss `wlr-virtual-keyboard-unstable-v1`-Protokoll unterstützen (labwc tut es).

Vom Dell U2720Q antwortet `ddcutil getvcp D6` mit:

| Monitor-Zustand | Rückgabe |
|---|---|
| An | `sl=0x01` (DPM: On, DPMS: Off) |
| Soft-Off (Taster) | `Display not found` (DDC-Kanal abgeschaltet) |

Die *Unterscheidung* ist das Signal — nicht der numerische Wert selbst. Andere Monitore liefern ggf. `sl=0x04` statt eines Timeouts.

## Setup

```bash
# 1. ddcutil + wtype installieren (einmalig)
sudo apt install ddcutil wtype

# 2. Script und Unit ablegen (siehe oben)

# 3. Script ausführbar machen
chmod +x ~/.local/bin/monitor-power-watch.sh

# 4. Unit laden und starten
systemctl --user daemon-reload
systemctl --user enable --now monitor-power-watch.service
```

## Betrieb & Verifikation

### Status prüfen

```bash
systemctl --user status monitor-power-watch.service
```

Die Logs enthalten Transition-Marker:

```
[2026-04-24 12:11:29] Übergang on → off
[2026-04-24 12:11:29] Monitor aus → SIGSTOP an Chromium-Prozesse
[2026-04-24 12:11:29]   eingefroren: 10 Prozesse
[2026-04-24 12:12:31] Übergang off → on
[2026-04-24 12:12:31] Monitor an → SIGCONT an Chromium-Prozesse
[2026-04-24 12:12:31]   aufgetaut: 10 Prozesse
```

### Erwartete Wirkung

| Zustand | Chromium-Prozess-States | CPU (Summe) |
|---|---|---|
| Monitor an | `Sl`, `S`, `Rl` (sleeping/running) | 100–250 % (Last-abhängig) |
| Monitor aus (eingefroren) | alle `T` oder `Tl` (stopped) | **0,0 %** |
| Monitor aus, ungefreezed (Watcher aus) | `Sl`, `Rl` | 50–275 % (Throttling zufallsabhängig) |

### Messen während der Aus-Phase

```bash
# Bestätigt, dass alle Chromium-Prozesse SIGSTOP'd sind
ps -u "$(id -u)" -o stat,comm --no-headers | awk '$2=="chromium" {n[$1]++} END {for(s in n) print s": "n[s]}'

# CPU-Summe
top -b -n 2 -d 10 -p $(pgrep -d, '^chromium$' -u "$(id -u)") | \
  awk 'NR>1 && $NF=="chromium" {cpu+=$9} END {printf "CPU-Summe: %.1f%%\n", cpu}'
```

## Latenz & Timing

- **Detektions-Latenz**: 0–7 s (Polling-Intervall `INTERVAL=7` im Script).
- **Signal-Verzögerung**: Vernachlässigbar (SIGSTOP/SIGCONT sind Syscalls, <1 ms).
- **Chromium-Wiederaufnahme**: Trailer laufen genau dort weiter, wo sie gestoppt wurden; WebSocket zum Posterrama-Server verbindet sich bei Bedarf neu (bislang keine Probleme beobachtet).

## Bekannte Einschränkungen

1. **Crashpad-Handler werden nicht eingefroren** — `chrome_crashpad_handler` hat nicht `comm=chromium`, wird vom Pattern `^chromium$` bewusst ausgeschlossen. Harmlos, minimale Last (~0 %).
2. **Monitor-Hersteller-abhängig** — Funktioniert, solange der Monitor bei Soft-Off den DDC-Kanal abschaltet. Bei Monitoren, die DDC im Standby aktiv lassen, müsste man das Script auf `sl=0x04/0x05`-Werte anpassen.
3. **Polling, kein Event** — Kein DRM-Hotplug, da der Pi den Monitor durchgehend als `connected` sieht. 7-Sekunden-Granularität ist der Kompromiss.
4. **Greift nur das lokale Kiosk an** — Der Posterrama-Node.js-Server (`server.js`, PM2-verwaltet) wird **nicht** angefasst. Andere Clients (andere Pis, Browser, WebSocket-verbundene Displays) laufen ungestört weiter. Das ist bewusst so.

## Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Monitor an, aber schwarzes Bild | Chromium evtl. in einem Bad-State nach Testsequenz. Fix: `pkill -u 1000 '^chromium$'` — der Loop in `~/.config/labwc/autostart` startet es neu. |
| Service startet, pausiert aber nicht | `ddcutil detect` manuell prüfen; sicherstellen, dass der User in Gruppe `i2c` ist. |
| Chromium bleibt nach `systemctl stop` eingefroren | Sollte nicht passieren (ExecStopPost + Trap), aber manuell: `pkill -CONT -u 1000 '^chromium$'` |
| `failed to apply configuration` in `~/.xsession-errors` | libliftoff/VC4-Bug (siehe oben). Kommt vor, wenn Output per `wlr-randr --off` disabled wurde — nicht nutzen. Rettung: `kanshi` SIGHUP, ggf. Reboot. |

## Historische Alternativen (verworfen)

1. **`wlr-randr --output X --off`** — libliftoff-Bug, siehe oben.
2. **Page Visibility API** — Chromium markiert das Tab nicht als `hidden`, solange der Compositor den Output als aktiv führt. Liefert das falsche Signal.
3. **DRM-Hotplug-Watcher** — Monitor kappt HPD nicht. Kein Event.
4. **Posterrama pausieren (Backend)** — Keine Option: würde alle Clients betreffen.
5. **`wlopm` (Wayland Output Power Management)** — Nicht getestet, da `SIGSTOP` das Problem bereits löst.

## Abhängigkeiten zum Posterrama-Projekt

Keine. Dieses Setup ist Posterrama-agnostisch und würde auch mit einer anderen Web-App funktionieren, die in Chromium-Kiosk läuft. Einziger Berührungspunkt: Die `cinema.html` von Posterrama ist das Ziel des Kiosk-Browsers.
