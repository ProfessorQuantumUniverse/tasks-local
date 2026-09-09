# Nginx Proxy Manager einrichten

NPM läuft in einem eigenen LXC, Docker mit Portainer in einem zweiten. Beide
teilen sich also **kein** Docker-Netz — NPM kann den Container weder über
seinen Namen ansprechen noch über ein internes Bridge-Netz erreichen.

Deshalb veröffentlicht der Stack den Port auf dem Docker-LXC, und NPM leitet
an dessen IP-Adresse weiter:

```
Browser ──► NPM-LXC (TLS) ──► Docker-LXC:8080 ──► tasks (Container)
```

Der Preis dafür: Der Port liegt jetzt im LAN und nicht mehr nur in einem
Docker-Netz. Was das bedeutet und was dagegen hilft, steht in Schritt 4.

---

## 1. IP-Adressen feststellen

Im **Docker-LXC** (dort, wo Portainer läuft):

```bash
hostname -I
```

Die erste Adresse ist in aller Regel die richtige — das ist der Wert, den NPM
gleich als *Forward Hostname* bekommt. Nennen wir sie hier `10.0.0.20`.

Im **NPM-LXC**:

```bash
hostname -I
```

Diese Adresse brauchst du für `TRUST_PROXY`. Nennen wir sie `10.0.0.10`.

Gegenprobe vom NPM-LXC aus, nachdem der Stack läuft:

```bash
curl -s http://10.0.0.20:8080/healthz
```

Erwartet: `{"status":"ok"}`. Kommt hier nichts zurück, ist alles Weitere
sinnlos — dann klemmt es an Netz oder Firewall, nicht an NPM.

---

## 2. Stack-Variablen setzen

In Portainer beim Stack unter **Environment variables**:

```
APP_ORIGIN=https://tasks.deinedomain.de
TRUST_PROXY=10.0.0.10
TZ=Europe/Berlin
```

`TRUST_PROXY` ist die IP des **NPM-LXC**, nicht die des Docker-LXC. Nur von
dieser Adresse glaubt die App den Headern `X-Forwarded-For` und
`X-Forwarded-Proto`. Lässt du sie weg, funktioniert alles weiter — aber jede
Anfrage sieht für die App aus, als käme sie vom Proxy: Das Rate-Limit gilt
dann für alle deine Geräte gemeinsam, und im Sicherheitsprotokoll steht
überall die Proxy-Adresse statt der echten.

Setze hier **nicht** `loopback,linklocal,uniquelocal` ein. Das war richtig,
solange der Port nur im Docker-Netz existierte. Jetzt liegt er im LAN, und
jeder Host im LAN hat eine Adresse aus einem privaten Bereich — er könnte den
Header also selbst setzen und am Rate-Limit vorbei. `true` erst recht nicht.

Falls du unsicher bist, welche Adresse bei der App tatsächlich ankommt: Ruf
die Seite einmal über die Domain auf und sieh in die Container-Logs.

```bash
docker logs tasks --tail 20
```

In `"remoteAddress"` steht die Adresse, die die App sieht — genau dieser Wert
gehört in `TRUST_PROXY`. In aller Regel ist das die IP des NPM-LXC; wenn
Docker die Quelladresse umschreiben sollte, siehst du es hier sofort.

Optional, wenn das Docker-LXC mehrere Interfaces hat:

```
BIND_ADDR=10.0.0.20      # Port nur auf diesem Interface veröffentlichen
HOST_PORT=8080           # falls 8080 auf dem LXC schon belegt ist
```

---

## 3. Proxy Host anlegen

In der NPM-Oberfläche: **Hosts → Proxy Hosts → Add Proxy Host**

### Reiter „Details"

| Feld | Wert | Warum |
|---|---|---|
| Domain Names | `tasks.deinedomain.de` | Muss **exakt** dem `APP_ORIGIN` entsprechen |
| Scheme | `http` | TLS endet bei NPM, dahinter liegt das LAN |
| Forward Hostname / IP | `10.0.0.20` | Die IP des **Docker-LXC** — ein Container-Name wäre von hier aus nicht auflösbar |
| Forward Port | `8080` | `HOST_PORT` aus dem Stack |
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
bereits selbst, und die App vertraut diesen Headern nur, wenn sie von der in
`TRUST_PROXY` eingetragenen Adresse kommen.

Falls du die Weitergabe der echten Client-IP explizit erzwingen willst:

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

Uploads sind winzig (JSON-Import), ein größeres `client_max_body_size` ist
nicht nötig. Der App-Server selbst lehnt Bodies über 2 MB ab.

---

## 4. Den offenen Port eingrenzen

Der Port muss aus dem NPM-LXC erreichbar sein — aus dem Rest des LAN nicht.
Ohne zusätzliche Regel kann jedes Gerät im Netz `http://10.0.0.20:8080`
aufrufen.

Was dabei **nicht** passieren kann, auch ganz ohne Firewall:

- Anmelden geht nicht. Passkeys sind an `APP_ORIGIN` gebunden und brauchen
  einen sicheren Kontext; über `http://IP:8080` gibt der Browser gar keine
  Signatur heraus.
- Die Sitzungs-Cookies tragen `__Host-` und werden über http nie gesendet.
- Schreibende Anfragen scheitern an der Origin-Prüfung.

Was ein Gerät im LAN sieht, ist also die Anmeldeseite und `/healthz`. Trotzdem
gehört der Port zugemacht. Auf dem **Docker-LXC**:

```bash
iptables -I DOCKER-USER -p tcp --dport 8080 -s 10.0.0.10 -j ACCEPT
iptables -A DOCKER-USER -p tcp --dport 8080 -j DROP
```

Die Kette `DOCKER-USER` ist wichtig: Docker schreibt seine eigenen Regeln
vor die von `ufw` oder `firewalld`, veröffentlichte Ports gehen an einer
gewöhnlichen `ufw deny`-Regel also vorbei.

Dauerhaft machen, damit es einen Neustart übersteht:

```bash
apt install iptables-persistent && netfilter-persistent save
```

Kontrolle von einem beliebigen anderen Rechner im LAN — soll in einen Timeout
laufen:

```bash
curl -m 5 http://10.0.0.20:8080/healthz
```

---

## 5. Funktion prüfen

Im Container selbst:

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(console.log)"
```

Erwartet: `{ status: 'ok' }`

Vom NPM-LXC aus — das ist der Schritt, der die neue Topologie testet:

```bash
curl -s http://10.0.0.20:8080/healthz
```

Erwartet: `{"status":"ok"}`

Von außen:

```bash
curl -I https://tasks.deinedomain.de/healthz
```

Erwartet: `200` sowie `strict-transport-security` und
`content-security-policy` in den Headern.

Dass der Port nur dort veröffentlicht ist, wo er soll:

```bash
docker ps --filter name=tasks --format '{{.Ports}}'
```

Erwartet: `0.0.0.0:8080->8080/tcp` — oder `10.0.0.20:8080->8080/tcp`, wenn du
`BIND_ADDR` gesetzt hast.

---

## 6. Häufige Fehler

**`502 Bad Gateway`**
NPM erreicht den Docker-LXC nicht. Zuerst Schritt 1 wiederholen: Antwortet
`curl http://10.0.0.20:8080/healthz` **aus dem NPM-LXC**? Wenn nein, liegt es
am Netz oder an der Firewall-Regel aus Schritt 4 — nicht an NPM. Der
Forward-Hostname muss die IP des Docker-LXC sein; ein Container-Name wie
`tasks` ist von einem anderen LXC aus nicht auflösbar.

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
ein Budget. Genau das passiert, solange `TRUST_PROXY` nicht auf die IP des
NPM-LXC zeigt. Prüfen lässt es sich im Sicherheitsprotokoll der App
(**Einstellungen → Konto**): Steht dort bei jedem Eintrag die Proxy-Adresse,
greift `TRUST_PROXY` nicht. Sicherstellen, dass NPM `X-Forwarded-For` setzt
(siehe Advanced), und dass die Adresse exakt stimmt. `TRUST_PROXY=true`
**nicht** setzen: damit könnte jeder seine Adresse fälschen und das Limit
umgehen.
