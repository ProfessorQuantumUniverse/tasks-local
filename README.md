# Tasks — selbst gehostet

Der To-Do-Tracker ohne Firebase: eigener Node-Server, SQLite-Datei, Anmeldung
ausschließlich per Passkey. Ein Container, kein Build-Schritt im Frontend.

```
Browser ──► dein Reverse Proxy (TLS) ──► tasks:8080 ──► /data/tasks.db
```

Der Container spricht nur HTTP und veröffentlicht Port 8080 auf dem Host. Was
davor steht, ist deine Sache — die drei Punkte, die dabei wirklich zählen,
stehen in [docs/reverse-proxy.md](docs/reverse-proxy.md).

---

## Was drin steckt

| | |
|---|---|
| **Anmeldung** | Passkey (WebAuthn): Face ID, Fingerabdruck, Hardware-Key. Kein Passwort. |
| **Wiederherstellung** | 10 einmalige Recovery-Codes, dazu Enrollment-Token über die Container-Shell |
| **Sitzung** | 30 Tage, Token rotiert alle 24 h, jederzeit serverseitig widerrufbar |
| **Speicher** | SQLite, eine Datei in einem Docker-Volume |
| **Aufgaben** | Fälligkeiten, Wiederholungen, Fortschritt, Drag & Drop, eigene Sortierung |
| **Aussehen** | 48 Einstellungen, 10 Schriften, alles lokal ausgeliefert |
| **Installierbar** | PWA — auf Android und iOS als App auf den Startbildschirm |

---

## Einrichtung

Vorausgesetzt: eine Domain, die per HTTPS auf den Container zeigt. Passkeys
sind kryptografisch an genau diese Adresse gebunden, also **vorher festlegen**
— ein späterer Wechsel entwertet jeden registrierten Passkey.

### Variante A — Docker Compose

```bash
git clone <repo-url> tasks && cd tasks
```

```bash
cp .env.example .env && ${EDITOR:-nano} .env
```

Mindestens `APP_ORIGIN` setzen, idealerweise auch `TRUST_PROXY`. Dann:

```bash
docker compose up -d --build
```

Der erste Build dauert ein paar Minuten, weil die Schriften geprüft werden.

### Variante B — Portainer

**Stacks → Add stack → Repository**

| Feld | Wert |
|---|---|
| Repository URL | die URL dieses Repos |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |

Unter **Environment variables**:

```
APP_ORIGIN=https://tasks.deinedomain.de
TRUST_PROXY=10.0.0.10
TZ=Europe/Berlin
```

`TRUST_PROXY` ist die IP deines Reverse Proxy. Alles Weitere ist optional und
in [`.env.example`](.env.example) erklärt. Dann **Deploy the stack**.

### Ersten Passkey registrieren

Beim ersten Start steht ein einmaliger Enrollment-Token im Container-Log (in
Portainer unter **Containers → tasks → Logs**, gekennzeichnet mit `SETUP
REQUIRED`). Domain öffnen, Token einfügen, Passkey anlegen. Ist er abgelaufen:

```bash
docker compose exec app node src/cli.js enroll
```

> **Danach werden dir einmalig 10 Recovery-Codes angezeigt. Speichere sie
> sofort offline.** Sie erscheinen nie wieder und sind ohne Shell-Zugriff dein
> einziger Weg zurück, wenn du alle Geräte verlierst.

Registriere direkt ein zweites Gerät: **Einstellungen → Konto → Token
erzeugen**, auf dem anderen Gerät *Neues Gerät anmelden*. Das ist der
bequemste Schutz gegen ein Aussperren.

### Als App installieren

Die Seite ist eine PWA: In Chrome auf Android erscheint *App installieren* im
Menü, auf iOS *Teilen → Zum Home-Bildschirm*. Sie startet dann ohne
Browserleiste, der Passkey-Dialog funktioniert genauso.

Bewusst **ohne Service Worker** — die App ist vollständig serverabhängig, ein
Offline-Cache würde nur veraltete Module gegen frisches HTML ausspielen. Die
CSP verbietet Worker deshalb ganz.

---

## Betrieb

```bash
docker compose exec app node src/cli.js <befehl>
```

| Befehl | Wirkung |
|---|---|
| `status` | Konfiguration, Anzahl Passkeys, Sitzungen, Aufgaben |
| `enroll [minuten]` | Einmal-Token für ein neues Gerät ausgeben |
| `credentials` | Registrierte Passkeys auflisten |
| `delete-credential <id>` | Einen Passkey entfernen |
| `recovery-codes` | Neue Recovery-Codes erzeugen (alte werden ungültig) |
| `revoke-sessions` | Alle Geräte sofort abmelden |
| `revoke-enrollments` | Offene Enrollment-Token entwerten |
| `prune` | Abgelaufene Sitzungen und Challenges löschen |

**Aktualisieren:** `docker compose up -d --build`, in Portainer *Pull and
redeploy*. Datenbank und Passkeys liegen im Volume und bleiben erhalten.

**Sichern:** Am einfachsten der ganze Host per Backup. Nur die Datenbank:

```bash
docker compose exec app node -e "new (require('better-sqlite3'))('/data/tasks.db').backup('/data/backup.db').then(()=>console.log('ok'))"
```

```bash
docker compose cp app:/data/backup.db ./tasks-backup.db
```

**Ausgesperrt?** [docs/recovery.md](docs/recovery.md) — drei Wege zurück, vom
zweiten Gerät bis zur Container-Shell.

---

## Entwicklung

```bash
npm --prefix server install
```

```bash
cd server && APP_ORIGIN=http://localhost:8080 DATA_DIR=../data node src/server.js
```

`http://localhost:8080` gilt als secure context, Passkeys funktionieren dort
also ohne TLS. Für jede andere http-Adresse verweigert der Server den Start
mit einer Erklärung, statt eine Anmeldeseite auszuliefern, die nie
funktionieren kann.

```bash
npm --prefix server test
```

67 Prüfungen gegen einen Server auf einem freien Port mit Wegwerf-Datenbank:
Registrierung, Anmeldung, Wiederholungslogik, Export/Import, Origin-Prüfung,
verbrauchte Recovery-Codes, wiederverwendete Assertions, Klon-Erkennung. Die
WebAuthn-Seite übernimmt ein Software-Authenticator in `server/test/e2e.mjs`,
es wird also wirklich signiert und verifiziert.

### Aufbau

```
server/src/    server.js · config.js · db.js · security.js · static.js
               settings.js · cli.js · auth/ · routes/
web/           index.html · css/ · js/ (ES-Module) · vendor/ · icons/
shared/        settings-defaults.json — einzige Quelle für die Einstellungen
scripts/       fetch-assets.mjs (Schriften) · make-icons.mjs (PWA-Icons)
```

Schriften und Confetti liegen im Repo und werden bei jedem Build gegen
`scripts/vendor-lock.json` geprüft — weicht ein Byte ab oder liegt eine nicht
gelistete Datei in `web/vendor/`, bricht der Build ab. Neue Versionen holen:

```bash
node scripts/fetch-assets.mjs --update
```

---

## Sicherheit

Threat Model, umgesetzte Maßnahmen und bewusste Grenzen: [SECURITY.md](SECURITY.md).

## Lizenz

MIT. Die Schriften unterliegen ihren eigenen Lizenzen: die Google-Fonts-Familien
der SIL Open Font License, Nasalization der Lizenz von Typodermic Fonts.
