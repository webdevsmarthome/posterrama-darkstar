# Cloudflare-Tunnel (Darkstar-Fork)

**Status:** Aktiv seit 2026-04-25
**Scope:** Pi-spezifische Installation (Darkstar-Fork), nicht Teil des Posterrama-Code-Releases
**Zweck:** Posterrama von außerhalb des LANs erreichbar machen — ohne Port-Forwarding, ohne dynamisches DNS, ohne öffentliche Exposition des Pi.

---

## Architektur

```
                    Internet
                       │
                       ▼
        ┌──────────────────────────────┐
        │  Cloudflare Edge (anycast)   │
        │  posterrama.example.com ──► Tunnel      │
        │     ▲                        │
        │     │ Cloudflare Access      │
        │     │ (E-Mail-OTP-Login)     │
        └─────┴────────────────────────┘
                       │ QUIC (outbound, kein Port-Forwarding)
                       ▼
        ┌──────────────────────────────┐
        │  cloudflared.service (Pi)    │
        │  4 persistente Connections   │
        │  zu muc01/muc03/vie05/vie06  │
        └──────────────────────────────┘
                       │ http://localhost:4000
                       ▼
        ┌──────────────────────────────┐
        │  Posterrama (PM2)            │
        │  app.set('trust proxy', 1)   │
        └──────────────────────────────┘
```

**Drei Vorteile gegenüber Port-Forwarding:**
- Kein offener Port am Router → keine Internet-exponierte IP.
- TLS terminiert bei Cloudflare → kein Cert-Management auf dem Pi.
- Cloudflare Access kann E-Mail-OTP-Login vorschalten → Cinema/Wallart sind nicht mehr "wer-die-URL-kennt-kommt-rein".

---

## Komponenten

### Tunnel

| Property | Wert |
|---|---|
| Name | `pr-go27` |
| ID | `<TUNNEL-ID>` |
| Public-Hostname | `posterrama.example.com` |
| Origin | `http://localhost:4000` |
| Edge-Connections | 4 (QUIC) |

### Files

| Pfad | Owner | Permissions | Zweck |
|---|---|---|---|
| `/etc/cloudflared/config.yml` | root:root | 644 | Ingress-Regeln, Tunnel-ID, Credentials-Pfad |
| `/etc/cloudflared/<tunnel-id>.json` | root:root | 600 | Tunnel-Credentials (bei `service install` nach `/etc/` kopiert) |
| `/etc/systemd/system/cloudflared.service` | root:root | 644 | Vom `cloudflared service install` generiert |
| `~/.cloudflared/cert.pem` | helmut | 644 | Account-Cert für Tunnel-CRUD (`create`, `delete`, `route`) — NICHT für Tunnel-Run nötig |

### Service

`cloudflared.service` (System-systemd):
- `enabled` (`WantedBy=multi-user.target`)
- `After=network-online.target` (wartet auf DNS/Routing)
- Läuft als `cloudflared`-User
- Auto-Update via `cloudflared-update.timer` (täglich)

---

## Cloudflare Access (vorgeschaltete Auth)

Vor jedem Aufruf von `https://posterrama.example.com/` zeigt Cloudflare die Access-Login-Page (`<your-tenant>.cloudflareaccess.com/cdn-cgi/access/login/posterrama.example.com`):

1. User gibt seine E-Mail-Adresse ein.
2. Cloudflare schickt einen 6-stelligen Code.
3. Code eintragen → JWT-Cookie wird gesetzt → 24h gültig.

**Konfiguriert im Zero Trust Dashboard:**
1. https://one.dash.cloudflare.com → Access → Applications
2. Application für `posterrama.example.com` (Self-hosted)
3. Policy: Allow → Include → Emails → `you@example.com`

**Origin-Header:** Cloudflare reicht `Cf-Access-Authenticated-User-Email` an Posterrama durch (kann theoretisch für SSO genutzt werden, wird aktuell nicht ausgewertet — Posterrama-Admin-Login + 2FA bleibt zusätzlich aktiv).

---

## Setup-Anleitung (für Disaster-Recovery / Re-Install)

```bash
# 1. cloudflared installieren (offizielles Debian-Paket, ARM64)
cd /tmp
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb

# 2. Cloudflare-Account-Login (Browser-Auth)
cloudflared tunnel login
# → URL wird ausgegeben → im Desktop-Browser öffnen → example.com auswählen → Authorize
# → cert.pem landet in ~/.cloudflared/

# 3. Tunnel anlegen (oder existierenden via "tunnel list" identifizieren)
cloudflared tunnel create pr-go27
# → Tunnel-ID + credentials.json

# 4. DNS-Route (legt automatisch CNAME posterrama.example.com → <tunnel-id>.cfargotunnel.com an)
cloudflared tunnel route dns pr-go27 posterrama.example.com

# 5. Credentials und Config nach /etc/cloudflared/
sudo mkdir -p /etc/cloudflared
TUNNEL_ID=$(cloudflared tunnel list -o json | jq -r '.[] | select(.name=="pr-go27") | .id')
sudo cp ~/.cloudflared/${TUNNEL_ID}.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/${TUNNEL_ID}.json
sudo chown root:root /etc/cloudflared/${TUNNEL_ID}.json

sudo tee /etc/cloudflared/config.yml > /dev/null <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/${TUNNEL_ID}.json

loglevel: info
transport-loglevel: warn

ingress:
  - hostname: posterrama.example.com
    service: http://localhost:4000
    originRequest:
      connectTimeout: 30s
      keepAliveConnections: 100
      keepAliveTimeout: 90s
      httpHostHeader: posterrama.example.com
  - service: http_status:404
EOF

# 6. Config validieren
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate

# 7. systemd-Service installieren + starten
sudo cloudflared service install
sudo systemctl enable --now cloudflared

# 8. Status
sudo systemctl status cloudflared
cloudflared tunnel info pr-go27   # 4 Edge-Connections sollten da sein
```

**Cloudflare Access Application separat anlegen** (Zero Trust Dashboard, nur GUI — cloudflared-CLI kann das nicht).

---

## Verifikation

### Tunnel-Status

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 20 --no-pager
cloudflared tunnel info pr-go27   # ohne sudo, sonst sucht es cert.pem in /root
```

Erwartung: 4 Connections über Edge-Standorte (München/Wien). Wenn weniger: WiFi-Probleme oder Cloudflare-Edge-Wartung.

### End-to-End

```bash
# HTTPS-Aufruf von außerhalb des LANs:
curl -sS -o /dev/null -w "HTTP %{http_code} | %{time_total}s\n" https://posterrama.example.com/
# Erwartung: HTTP 302 (CF-Access-Redirect zur Login-Page)

# Origin direkt:
curl -sS http://localhost:4000/health
# Erwartung: {"status":"ok",...}
```

### Posterrama-trust-proxy

`server.js:1032` setzt `app.set('trust proxy', 1)`. Damit kommt die echte Client-IP aus `X-Forwarded-For` an, nicht `127.0.0.1`. Beweis im Log: `tail -f logs/posterrama-*.log` während Aufruf von außen — `clientIp` sollte die externe IP sein, nicht die Loopback.

---

## Boot-Persistenz

| Komponente | Status |
|---|---|
| `cloudflared.service` | enabled, `WantedBy=multi-user.target`, `After=network-online.target` |
| Tunnel-Credentials | `/etc/cloudflared/` survived Reboot (root-owned) |
| Cloudflare-Edge | persistente Tunnel-Routes auf Cloudflare-Seite (Tunnel bleibt registriert) |
| Auto-Update | `cloudflared-update.timer` (System-Standard nach Install) |

Nach Power-Cycle: cloudflared startet 6-7s nach `network-online.target`, baut die 4 Edge-Connections in <5s neu auf. Public-URL ist nach ~30s wieder erreichbar.

---

## Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| `cloudflared tunnel info` → "Cannot determine default origin certificate" | mit sudo aufgerufen → sucht cert.pem in /root. Ohne sudo aufrufen oder `TUNNEL_ORIGIN_CERT=~/.cloudflared/cert.pem` setzen |
| HTTP 502 von außen | Posterrama läuft nicht (`pm2 status`) oder Origin-URL in config.yml falsch |
| HTTP 530 von außen | Tunnel down (`systemctl status cloudflared`) |
| Cloudflare-Access-Login → "Access Denied" | Policy fehlt — im Zero Trust Dashboard Application für `posterrama.example.com` prüfen, Allow-Policy für Email anlegen |
| Tunnel verbindet, aber WebSocket bricht ab | Posterrama selbst prüfen — Tunnel reicht WebSocket nativ durch, kein extra Config nötig |

---

## Sicherheitseigenschaften

- **Kein offener Port am Router** — Tunnel ist outbound-only.
- **TLS-Termination bei Cloudflare** — Posterrama-Origin ist HTTP, keine Cert-Wartung.
- **DDoS-Schutz** — Cloudflare-Edge filtert vor Tunnel-Forwarding.
- **Cloudflare Access als zweite Verteidigungslinie** — Selbst wenn Posterrama-Admin-Login kompromittiert wäre, käme niemand an `/admin` ohne CF-Access-OTP.
- **Posterrama hat eigene Auth** (Login + 2FA) — defense in depth.

---

## Abhängigkeiten zum Posterrama-Projekt

Keine. Cloudflare-Tunnel ist Posterrama-agnostisch — würde mit jeder lokal lauschenden HTTP-App funktionieren. Einziger Berührungspunkt: `app.set('trust proxy', 1)` in `server.js`, damit Posterrama die echte Client-IP aus dem Tunnel-Forward-Header liest.
