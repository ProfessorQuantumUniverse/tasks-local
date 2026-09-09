# Reverse Proxy

Der Container spricht nur HTTP auf Port 8080. TLS, Zertifikate und der Weg von
außen sind Sache deines Proxy — wie du den aufsetzt, weißt du besser als diese
Datei. Hier steht nur, was die App davon tatsächlich mitbekommt.

Gedacht ist der Aufbau für Cloudflare Tunnel vor Nginx Proxy Manager:

```
Browser ──► Cloudflare ──► cloudflared ──► NPM (TLS) ──► docker-lxc:8080
```

Traefik, Caddy oder nacktes nginx tun es genauso. Läuft der Proxy in einem
anderen LXC als Docker — der übliche Fall — gibt es kein gemeinsames
Docker-Netz, der Proxy zielt also auf `<docker-lxc-ip>:8080`.

---

## Die drei Punkte, die zählen

**1. `APP_ORIGIN` muss zeichengenau die Adresse sein, die im Browser steht.**
Passkeys sind kryptografisch daran gebunden. `www.` davor ist bereits eine
andere Relying Party, und deine Passkeys gelten dort nicht. Ein späterer
Wechsel entwertet jeden registrierten Passkey.

**2. Der Browser muss HTTPS sehen — wo TLS endet, ist der App egal.**
Die Sitzungs-Cookies tragen das `__Host-`-Präfix und sind `Secure`, WebAuthn
verlangt einen sicheren Kontext. Beides betrifft die Verbindung *Browser ↔
Edge*. Terminiert Cloudflare das TLS, reicht das vollkommen; dein Proxy darf
dahinter unverschlüsselt mit dem Container reden.

**3. `TRUST_PROXY` auf die IP des Proxy setzen.**
Sonst sieht die App jede Anfrage als vom Proxy kommend: Das Rate-Limit gilt
dann für alle Geräte gemeinsam und im Sicherheitsprotokoll steht überall die
Proxy-Adresse. Welche Adresse wirklich ankommt, verrät `docker logs tasks` im
Feld `remoteAddress`.

Nimm dort **keinen** Bereich wie `uniquelocal`: Der Port liegt im LAN, jeder
Host im LAN ist in einem privaten Bereich und könnte `X-Forwarded-For` selbst
setzen. `true` erst recht nicht.

---

## Stolpersteine

**Redirect-Loop mit Cloudflare Tunnel.** Zeigt der Tunnel auf `http://npm:80`
und NPM hat *Force SSL* an, gibt cloudflared die Umleitung an den Browser
weiter — der landet wieder am selben Punkt. `ERR_TOO_MANY_REDIRECTS`.
Entweder *Force SSL* aus und in Cloudflare **Always Use HTTPS** an, oder den
Tunnel auf `https://npm:443` zeigen lassen.

**Let's Encrypt scheitert mit 403.** Die HTTP-01-Challenge läuft durch
Cloudflare und wird von Cloudflare Access, Bot Fight Mode oder einer
WAF-Regel geblockt. Das trifft auch jede automatische Erneuerung — also nicht
freischalten, sondern ausweichen: **DNS-01** mit einem Cloudflare-API-Token,
oder ein **Cloudflare Origin Certificate** (15 Jahre, kein ACME). Oder auf
NPM ganz auf ein Zertifikat verzichten, siehe Punkt 2.

**Kein Caching, keine Websockets.** Der App-Server setzt seine Cache-Header
selbst (`no-store` für die API, ETag für den Rest); ein Proxy-Cache davor
bringt nichts und kann nach einem Deploy altes JavaScript mit neuem HTML
mischen. Websockets nutzt die App nicht. `client_max_body_size` musst du nicht
anfassen — der Server lehnt Bodies über 2 MB selbst ab.

**Der Port liegt im LAN.** Ohne Regel erreicht ihn jedes Gerät im Netz.
Anmelden geht darüber nicht (Passkeys hängen an `APP_ORIGIN` und brauchen
einen sicheren Kontext), Cookies gehen über http nie raus, Schreibzugriffe
scheitern an der Origin-Prüfung — übrig bleiben Anmeldeseite und `/healthz`.
Zumachen trotzdem, auf dem Docker-Host in der Kette `DOCKER-USER`, weil eine
gewöhnliche `ufw`-Regel bei veröffentlichten Docker-Ports nicht greift:

```bash
iptables -I DOCKER-USER -p tcp --dport 8080 -s <proxy-ip> -j ACCEPT
```

```bash
iptables -A DOCKER-USER -p tcp --dport 8080 -j DROP
```

Wer den Port lieber gar nicht im LAN hätte und den Proxy auf demselben
Docker-Host betreibt: `docker-compose.override.yml.example` enthält die
Variante mit gemeinsamem Docker-Netz.

---

## Prüfen

Direkt am Container:

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(console.log)"
```

Vom Proxy aus — das ist der Schritt, der die Netzstrecke testet:

```bash
curl -s http://<docker-lxc-ip>:8080/healthz
```

Von außen, inklusive Security-Headern:

```bash
curl -sI https://tasks.deinedomain.de/healthz
```

Erwartet: `200`, dazu `content-security-policy` und — wenn TLS bis zur App
durchgereicht wird — `strict-transport-security`.

---

## Wenn es klemmt

| Symptom | Ursache |
|---|---|
| `502` / `Error 1033` | Proxy erreicht `<docker-lxc-ip>:8080` nicht. Von dort curlen, dann Firewall prüfen. Ein Container*name* ist von einem anderen LXC aus nicht auflösbar. |
| Anmeldeseite lädt, kein Passkey-Dialog | Keine HTTPS-Adresse, oder sie weicht von `APP_ORIGIN` ab. Im Log prüfen: `"origin":"https://…","rpID":"…"` |
| „Anfrage blockiert. Öffne die App über ihre konfigurierte Adresse." | Der `Origin`-Header passt nicht zu `APP_ORIGIN`. Es gibt genau eine gültige Adresse — so ist es gewollt. |
| Nach dem Anmelden sofort abgemeldet | Das Cookie kommt nicht an. Praktisch immer fehlendes HTTPS im Browser. |
| Rate-Limit greift zu früh | `TRUST_PROXY` zeigt nicht auf den Proxy. |
