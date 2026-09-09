# Cloudflare Tunnel

Der Tunnel bringt die App ins Internet, ohne dass du am Router einen Port
öffnest. `cloudflared` baut eine ausgehende Verbindung zu Cloudflare auf; von
außen ist nichts an deinem Anschluss erreichbar.

```
Internet ──► Cloudflare ──► cloudflared ──► Nginx Proxy Manager ──► tasks
```

`cloudflared` zeigt auf **Nginx Proxy Manager**, nicht direkt auf die App.
So bleiben Zertifikate, HSTS und Zugriffsregeln an einer Stelle, und die App
sieht immer denselben Weg herein — egal ob eine Anfrage über den Tunnel oder
aus dem LAN kommt.

---

## Tunnel anlegen

1. Im Cloudflare Zero Trust Dashboard: **Networks → Tunnels → Create a tunnel**
2. Typ **Cloudflared**, Namen vergeben, Token kopieren.
3. Public Hostname konfigurieren:

| Feld | Wert |
|---|---|
| Subdomain | `tasks` |
| Domain | `deinedomain.de` |
| Service Type | `HTTP` |
| URL | `10.0.0.10:80` — die IP des NPM-LXC |

NPM läuft in einem eigenen LXC, `cloudflared` als Container im Docker-LXC.
Ein Containername wäre von dort aus nicht auflösbar, deshalb steht hier die
IP-Adresse des NPM-LXC.

Weil NPM das Let's-Encrypt-Zertifikat hält und *Force SSL* aktiv ist,
antwortet Port 80 mit einer Weiterleitung auf HTTPS. Cloudflare folgt ihr.
Wenn du stattdessen direkt auf `https://10.0.0.10:443` zeigst, setze **No TLS
Verify**, denn der Name im Zertifikat ist deine Domain, nicht eine IP.

---

## Container

Als eigener Stack im Docker-LXC. Er braucht kein besonderes Netz: Der Tunnel
baut nur ausgehende Verbindungen auf und erreicht NPM über dessen IP.

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN:?set TUNNEL_TOKEN}
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Den Token als Stack-Variable in Portainer setzen, nicht in die Datei
schreiben.

---

## Cloudflare-Einstellungen

Für den Host `tasks.deinedomain.de`:

| Einstellung | Wert | Warum |
|---|---|---|
| SSL/TLS Encryption Mode | **Full (strict)** | Cloudflare prüft das Zertifikat von NPM |
| Always Use HTTPS | an | |
| **Rocket Loader** | **aus** | injiziert Inline-Skripte, die die CSP blockiert |
| **Email Address Obfuscation** | **aus** | injiziert ebenfalls Inline-Skripte |
| Auto Minify | aus | unnötig, die Dateien sind bereits klein |
| Browser Integrity Check | an | |

> Rocket Loader ist der häufigste Grund, warum die Seite hinter Cloudflare
> weiß oder schwarz bleibt. Die Content-Security-Policy erlaubt kein
> `unsafe-inline`, und Rocket Loader funktioniert genau darüber. Aus lassen.

---

## Optional: Cloudflare Access davor

Zero Trust kann eine zweite Anmeldung *vor* die App setzen, sodass dein Server
ohne gültiges Cloudflare-Token gar nicht erst erreicht wird.

**Networks → Access → Applications → Add an application → Self-hosted**,
Domain `tasks.deinedomain.de`, Policy z.B. „Emails: deine@adresse.de".

Abwägung:

- **Dafür:** Der Ursprungsserver wird von Unbekannten nie berührt. Selbst eine
  Lücke in der App wäre von außen nicht erreichbar.
- **Dagegen:** Zwei Anmeldungen bei jedem Besuch, und du hängst an einem
  Cloudflare-Konto. Fällt es aus oder wird gesperrt, kommst du nur noch über
  das LAN heran.

Die App braucht Access nicht — sie ist eigenständig abgesichert. Es ist eine
zusätzliche Schicht, keine Voraussetzung.

Wenn du Access nutzt, ändere `TRUST_PROXY` **nicht**. Die App sieht weiterhin
nur NPM als direkten Gegenüber, und das ist die richtige Vertrauensgrenze.

---

## Prüfen

```bash
curl -sI https://tasks.deinedomain.de/healthz | head -20
```

Erwartet: `HTTP/2 200`, dazu `cf-ray` (Cloudflare war beteiligt),
`strict-transport-security` und `content-security-policy`.

Dass wirklich kein Port offen steht, prüfst du von außerhalb deines Netzes:

```bash
nmap -Pn -p 80,443 deine.oeffentliche.ip
```

Beide sollten gefiltert oder geschlossen sein — der Tunnel braucht keinen
eingehenden Port.

---

## Fehlersuche

**Error 1033 / Tunnel offline**
`docker logs cloudflared`. Meist ein falscher oder abgelaufener Token.

**502 von Cloudflare**
Der Tunnel erreicht NPM nicht. Die Service-URL muss die IP des NPM-LXC sein —
weder `localhost` noch ein Containername, denn NPM läuft nicht in diesem
Docker. Gegenprobe im Docker-LXC:

```bash
curl -I http://10.0.0.10:80
```

**Seite lädt, bleibt aber leer**
Fast sicher Rocket Loader. Ausschalten, Cloudflare-Cache leeren, neu laden.
In der Browser-Konsole steht dann eine CSP-Meldung zu einem Inline-Skript.

**Passkey-Dialog erscheint nicht**
Die aufgerufene Adresse weicht von `APP_ORIGIN` ab — etwa `www.` davor, oder
eine zweite Subdomain, die auf denselben Tunnel zeigt. Es gibt genau eine
gültige Adresse.
