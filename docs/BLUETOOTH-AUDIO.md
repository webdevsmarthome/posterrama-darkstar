# Bluetooth-Audio (Darkstar-Fork)

**Status:** Aktiv seit 2026-04-25
**Scope:** Pi-spezifische Installation (Darkstar-Fork), nicht Teil des Posterrama-Code-Releases
**Zweck:** Robuste Bluetooth-Audio-Anbindung für den Cinema-Kiosk — automatischer Reconnect nach Power-Cycle, Lautsprecher-Standby oder Reichweiten-Verlust, ohne dass jemand sich am Pi einloggen muss.

---

## Problem

Ein gepairter Bluetooth-Lautsprecher (hier: **Anker Soundcore 3**) verliert seine Verbindung zum Pi nach:

- Strom-Cycle (Pi UND Lautsprecher waren beide aus, Pi bootet schneller).
- Lautsprecher-Standby (Soundcore schaltet sich nach Inaktivität ab).
- Reichweiten-Verlust (Lautsprecher mitgenommen).

Der bluez-eigene `Trusted=yes`-Flag reicht **nicht zuverlässig**: er greift nur, wenn der Lautsprecher **advertised**, während bluez gerade scannt. Klassische BR/EDR-Geräte advertisen aber nur kurz nach dem Einschalten — wenn der Pi nach dem Lautsprecher bootet, verpasst er den Burst.

---

## Lösung — Drei Schichten

```
Schicht 1: bluez-eigener Reconnect (passiv)
  └─ Trusted=yes + AutoEnable + FastConnectable + ReconnectAttempts

Schicht 2: bluetooth-reconnect-soundcore.service (aktiv, Polling)
  └─ User-systemd-Service, alle 30s "bluetoothctl connect" wenn disconnected

Schicht 3: PipeWire/WirePlumber (Audio-Routing)
  └─ erkennt Soundcore als Default-Sink, sobald Bluetooth-Verbindung steht
```

Jede Schicht ist unabhängig. Wenn Schicht 1 greift, ist Schicht 2 idempotent (kein doppelter Connect). Wenn Schicht 1 versagt, deckt Schicht 2 innerhalb von 30s ab.

---

## Schicht 1: bluez Trust + main.conf-Tuning

**Pairing + Trust** (einmalig pro Lautsprecher):

```bash
SOUNDCORE_MAC="XX:XX:XX:XX:XX:XX"   # Anker Soundcore 3
bluetoothctl pair "$SOUNDCORE_MAC"
bluetoothctl trust "$SOUNDCORE_MAC"
bluetoothctl connect "$SOUNDCORE_MAC"
```

Persistent in `/var/lib/bluetooth/<adapter>/<device>/info`.

**main.conf-Tuning** (`/etc/bluetooth/main.conf`):

| Setting | Wert | Effekt |
|---|---|---|
| `[General]` `FastConnectable` | `true` | Größeres Page-Scan-Fenster → schnellerer Reconnect |
| `[Policy]` `AutoEnable` | `true` | Adapter wird beim Boot automatisch powered |
| `[Policy]` `ReconnectAttempts` | `7` | Anzahl Auto-Reconnect-Versuche |
| `[Policy]` `ReconnectIntervals` | `1,2,4,8,16,32,64` | Exponential Backoff in Sekunden |

Aktivieren mit `sudo sed -i` (siehe Setup-Anleitung unten).

**Greift wirksam** nach `sudo systemctl restart bluetooth` (kostet ~3s Audio-Pause) oder beim nächsten Reboot.

---

## Schicht 2: Watcher-User-Service

**Script:** `~/.local/bin/bluetooth-reconnect-soundcore.sh`

```bash
#!/bin/bash
set -u

SOUNDCORE_MAC="XX:XX:XX:XX:XX:XX"
INTERVAL=30

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
trap 'log "Watcher beendet"; exit 0' TERM INT HUP

is_connected() {
    timeout 5 bluetoothctl info "$SOUNDCORE_MAC" 2>/dev/null | grep -qE '^\s*Connected:\s+yes'
}

attempt_connect() {
    timeout 15 bluetoothctl connect "$SOUNDCORE_MAC" 2>&1 | grep -qE 'Connection successful|already.*connected'
}

log "Watcher gestartet (Soundcore 3, $SOUNDCORE_MAC, Polling ${INTERVAL}s)"

prev=""
while true; do
    is_connected && curr=connected || curr=disconnected

    if [[ "$curr" == "disconnected" ]]; then
        if attempt_connect; then
            log "→ Verbindung hergestellt"
            prev=connected
        else
            if [[ "$prev" != "disconnected" ]]; then
                log "→ Soundcore 3 nicht erreichbar (aus / außer Reichweite)"
                prev=disconnected
            fi
        fi
    else
        if [[ "$prev" != "connected" ]]; then
            log "→ Verbindung steht"
            prev=connected
        fi
    fi

    sleep "$INTERVAL"
done
```

**Wichtige Eigenschaften:**
- **State-machine, kein Tick-Spam:** Loggt nur Übergänge, nicht jeden Tick.
- **`timeout`-Wrapper** um `bluetoothctl`: verhindert Hänger bei bluez-Timeout.
- **Idempotent:** `bluetoothctl connect` auf bereits verbundenem Gerät ist no-op.
- **Trap auf Cleanup:** Loggt geordneten Exit.

**Systemd-User-Unit:** `~/.config/systemd/user/bluetooth-reconnect-soundcore.service`

```ini
[Unit]
Description=Auto-reconnect Bluetooth Soundcore 3
After=bluetooth.target graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=/home/helmut/.local/bin/bluetooth-reconnect-soundcore.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

**Boot-Persistenz erfordert `loginctl enable-linger helmut`**, sonst startet der User-systemd-Manager erst beim Login (siehe `feedback_power_loss_resilient`). Linger ist auf dieser Installation aktiviert.

---

## Schicht 3: PipeWire-Audio-Stack

PipeWire/WirePlumber/pipewire-pulse als User-Services (alle `enabled`). Kein PulseAudio installiert, daher **`pactl` ist nicht verfügbar** — für Audio-Diagnose stattdessen `wpctl` nutzen (PipeWire-nativ).

### Sinks anzeigen

```bash
wpctl status
```

Beispiel-Output (verkürzt):

```
Audio
 ├─ Sinks:
 │      35. Built-in Audio Digital Stereo (HDMI) [vol: 0.40]
 │      57. Built-in Audio Stereo               [vol: 0.40]
 │  *   95. Soundcore 3                         [vol: 0.39]
 │
 └─ Streams:
        88. Chromium
             89. output_FR       > Soundcore 3:playback_FR  [active]
             91. output_FL       > Soundcore 3:playback_FL  [active]
```

`*` markiert den Default-Sink. Wenn Soundcore verbunden ist, wird er automatisch als Default gewählt (WirePlumber-Default-Behavior).

### Default manuell setzen

```bash
wpctl set-default <sink-id>           # z.B. 95 für Soundcore 3
wpctl set-volume <sink-id> 0.5        # Lautstärke 50%
```

---

## Setup-Anleitung (für Disaster-Recovery / neuen Lautsprecher)

```bash
# 1. Bluetooth + PipeWire installiert? (sollte standard auf Raspberry Pi OS sein)
sudo apt install bluez bluez-tools pipewire pipewire-pulse wireplumber

# 2. Bluetooth-Service enabled
sudo systemctl enable --now bluetooth

# 3. Pairen (Lautsprecher in Pairing-Mode versetzen)
bluetoothctl
> scan on
# Warten bis "[NEW] Device XX:XX:XX:... Soundcore 3" erscheint
> scan off
> pair XX:XX:XX:XX:XX:XX
> trust XX:XX:XX:XX:XX:XX
> connect XX:XX:XX:XX:XX:XX
> exit

# 4. main.conf-Tuning
sudo cp /etc/bluetooth/main.conf /etc/bluetooth/main.conf.bak.$(date +%Y%m%d)
sudo sed -i \
    -e 's|^#FastConnectable = false$|FastConnectable = true|' \
    -e 's|^#ReconnectAttempts=7$|ReconnectAttempts=7|' \
    -e 's|^#ReconnectIntervals=1,2,4,8,16,32,64$|ReconnectIntervals=1,2,4,8,16,32,64|' \
    -e 's|^#AutoEnable=true$|AutoEnable=true|' \
    /etc/bluetooth/main.conf
sudo systemctl restart bluetooth

# 5. Watcher-Script + User-Unit ablegen (siehe oben)
chmod +x ~/.local/bin/bluetooth-reconnect-soundcore.sh

# 6. Linger aktivieren (falls noch nicht gesetzt)
sudo loginctl enable-linger $USER

# 7. Watcher enabled + start
systemctl --user daemon-reload
systemctl --user enable --now bluetooth-reconnect-soundcore.service

# 8. Verifikation
systemctl --user status bluetooth-reconnect-soundcore.service
sudo journalctl _SYSTEMD_USER_UNIT=bluetooth-reconnect-soundcore.service -f
```

**Bei anderem Lautsprecher:** `SOUNDCORE_MAC` im Skript anpassen, alle Pairing-Schritte mit der neuen MAC wiederholen, Watcher restarten.

---

## Verifikation

### Manueller Test

1. Soundcore ausschalten → nach maximal 30s erscheint im Watcher-Log:
   ```
   → Soundcore 3 nicht erreichbar (aus / außer Reichweite)
   ```
2. Soundcore wieder einschalten → nach maximal 30s:
   ```
   → Verbindung hergestellt
   ```

Live-Mitlesen:
```bash
sudo journalctl _SYSTEMD_USER_UNIT=bluetooth-reconnect-soundcore.service -f
```

### Boot-Test

Nach `sudo reboot`:
- Soundcore wird erkannt + verbunden, sobald Pi-Boot abgeschlossen UND Lautsprecher in Reichweite/eingeschaltet ist.
- Worst-case-Latenz: 30s nach beidem-da-sein (Watcher-Polling-Intervall).

### Audio-Test

Posterrama-Kiosk → Trailer abspielen lassen → Audio sollte aus Soundcore kommen. Falls nicht: `wpctl status` zeigt aktiven Sink, Stream-Routing mit `*` markiert.

---

## Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Watcher loggt "nicht erreichbar" obwohl Lautsprecher an | Reichweite, Akku, Pairing-Mode. `bluetoothctl info <MAC>` für Detail-Status. |
| `bluetoothctl connect` schlägt fehl mit "Failed to connect: br-connection-profile-unavailable" | bluez-Profile-Cache korrupt: `sudo systemctl restart bluetooth` + Watcher-Restart. |
| Audio kommt aus HDMI statt Soundcore | `wpctl set-default <soundcore-sink-id>`. Falls dauerhaft: WirePlumber-Default-Routing-Policy in `~/.config/wireplumber/main.lua.d/` setzen. |
| `pactl: Kommando nicht gefunden` | Korrekt — kein PulseAudio installiert. Stattdessen `wpctl` nutzen. |
| Watcher läuft, Bluetooth-Adapter aber nicht powered | `bluetoothctl power on` einmalig. Falls nach Reboot wieder weg: `AutoEnable=true` in `main.conf` prüfen + `bluetooth.service` restart. |
| Nach Linger-Aktivierung startet Watcher trotzdem nicht beim Boot | `systemctl --user is-enabled bluetooth-reconnect-soundcore.service` prüfen, ggf. `enable` neu setzen. User-Manager-Status: `loginctl show-user $USER -p Linger`. |

---

## Sicherheitseigenschaften

- **Pairing-Schlüssel** sind im bluez-Store (`/var/lib/bluetooth/<adapter>/<device>/info`, root-readable, 0600).
- **Watcher hat keine Privilegien**: läuft als User, nutzt nur `bluetoothctl`-User-API.
- **Kein offener Bluetooth-Port** für Pairing-Anfragen: `bluetoothctl discoverable off` (Default).

---

## Abhängigkeiten zum Posterrama-Projekt

Keine. Bluetooth-Audio-Setup ist Posterrama-agnostisch — würde mit jedem Audio-Sink funktionieren. Einziger Berührungspunkt: Chromium-Kiosk öffnet `cinema.html` und gibt Trailer-Audio über den aktiven PipeWire-Default-Sink aus, das ist nach diesem Setup automatisch der Soundcore.
