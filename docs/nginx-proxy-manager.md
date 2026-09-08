# Nginx Proxy Manager einrichten

Der App-Container hört auf Port 8080, veröffentlicht ihn aber **nicht** auf dem
Docker-Host. Erreichbar ist er nur über das gemeinsame Docker-Netz. Damit ist
der Reverse Proxy der einzige Weg zur App — nichts im LAN kann versehentlich
direkt darauf zugreifen.

---

## 1. Gemeinsames Netz sicherstellen

Beide Container müssen im selben Docker-Netz liegen, sonst kann NPM den Namen
`tasks` nicht auflösen.

Netze anzeigen:

```bash
docker network ls
```

Prüfen, in welchem Netz NPM steckt (Container-Name ggf. anpassen):

```bash
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' nginx-proxy-manager
```

Den gefundenen Namen als `PROXY_NETWORK` im Stack setzen, z.B.:

```
PROXY_NETWORK=npm_default
```

Danach den Tasks-Stack neu deployen. Kontrolle:

```bash
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' tasks
```

Beide Ausgaben müssen mindestens ein gemeinsames Netz enthalten.

---

## 2. Proxy Host anlegen

In der NPM-Oberfläche: **Hosts → Proxy Hosts → Add Proxy Host**

### Reiter „Details"

| Feld | Wert | Warum |
|---|---|---|
| Domain Names | `tasks.deinedomain.de` | Muss **exakt** dem `APP_ORIGIN` entsprechen |
| Scheme | `http` | TLS endet bei NPM, dahinter ist das Docker-Netz |
| Forward Hostname / IP | `tasks` | Der Container-Name, nicht eine IP |
| Forward Port | `8080` | |
| Cache Assets | **aus** | Der App-Server setzt seine Cache-Header selbst |
| Block Common Exploits | **an** | |
| Websockets Support | aus | Die App nutzt keine WebSockets |

> **Kein Trailing Slash und kein Pfad** bei den Domain Names. Und die Domain
> muss zeichengenau mit `APP_ORIGIN` übereinstimmen — schon `www.` davor
> bedeutet für den Browser eine andere Relying Party, und deine Passkeys
> gelten dort nicht.

### Reiter „SSL"

| Feld | Wert |
|---|---|
| SSL Certificate | *Request a new SSL Certificate* |
| Force SSL | **an** |
| HTTP/2 Support | an |
| HSTS Enabled | **an** |
| HSTS Subdomains | nach Bedarf |

Force SSL ist nicht optional: Die Sitzungs-Cookies tragen das `__Host-`
Präfix und werden vom Browser nur über HTTPS überhaupt angenommen. Ohne TLS
bleibst du dauerhaft abgemeldet.

### Reiter „Advanced"

Normalerweise leer lassen. NPM setzt `X-Forwarded-For` und `X-Forwarded-Proto`
bereits selbst, und die App vertraut diesen Headern nur, wenn sie aus einem
privaten Netz kommen (`TRUST_PROXY`).

Falls du die Weitergabe der echten Client-IP explizit erzwingen willst:

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

Uploads sind winzig (JSON-Import), ein größeres `client_max_body_size` ist
nicht nötig. Der App-Server selbst lehnt Bodies über 2 MB ab.

---

## 3. Funktion prüfen

Aus dem LXC heraus, im Docker-Netz:

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(console.log)"
```

Erwartet: `{ status: 'ok' }`

Von außen:

```bash
curl -I https://tasks.deinedomain.de/healthz
```

Erwartet: `200` sowie `strict-transport-security` und
`content-security-policy` in den Headern.

Dass wirklich kein Port offen ist, prüfst du so — die Ausgabe soll **leer**
sein:

```bash
docker ps --filter name=tasks --format '{{.Ports}}'
```

---

## 4. Häufige Fehler

**`502 Bad Gateway`**
NPM erreicht den Container nicht. Fast immer das falsche Netz — Schritt 1
wiederholen. Der Forward-Hostname muss der Container-Name sein (`tasks`),
nicht `localhost` und nicht die LXC-IP.

**Anmeldeseite lädt, aber der Passkey-Dialog erscheint nicht**
Die Seite läuft nicht über HTTPS oder die Adresse weicht von `APP_ORIGIN` ab.
Kontrolle in den Container-Logs beim Start:

```
"origin":"https://tasks.deinedomain.de","rpID":"tasks.deinedomain.de"
```

**„Anfrage blockiert. Öffne die App über ihre konfigurierte Adresse."**
Der `Origin`-Header passt nicht zu `APP_ORIGIN`. Tritt auf, wenn du die App
über eine zweite Domain oder direkt über die IP aufrufst. Es gibt genau eine
gültige Adresse — so ist es gewollt.

**Nach dem Anmelden sofort wieder abgemeldet**
Das Cookie kommt nicht an. Ursache ist praktisch immer fehlendes HTTPS oder
ein nicht gesetztes *Force SSL*.

**Rate-Limit greift zu früh**
Wenn alle Anfragen mit derselben Quell-IP ankommen, teilen sich alle Geräte
ein Budget. Sicherstellen, dass NPM `X-Forwarded-For` setzt (siehe Advanced)
und dass `TRUST_PROXY` die privaten Bereiche enthält — das ist der Standard.
Setze `TRUST_PROXY=true` **nicht**: damit könnte jeder seine Adresse fälschen
und das Limit umgehen.
