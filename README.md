# Tasks — selbst gehostet

Der To-Do-Tracker, jetzt ohne Firebase: eigener Node-Server, SQLite-Datei,
Anmeldung ausschließlich per Passkey. Läuft als ein einziger Container hinter
deinem Reverse Proxy.

```
Browser ──► Cloudflare Tunnel ──► Nginx Proxy Manager ──► Docker-LXC:8080
                                       (eigener LXC)         └── tasks (Container)
                                                                  └── /data/tasks.db
```

Nginx Proxy Manager läuft in einem eigenen LXC, Docker mit Portainer in einem
zweiten. Da sich beide kein Docker-Netz teilen, veröffentlicht der Stack
seinen Port auf dem Docker-LXC und NPM leitet an dessen IP weiter. Wie der
Port dabei auf die Proxy-Adresse eingegrenzt wird, steht in
[docs/nginx-proxy-manager.md](docs/nginx-proxy-manager.md).

---

## Was drin steckt

| | |
|---|---|
| **Anmeldung** | Passkey (WebAuthn), Face ID / Fingerabdruck / Hardware-Key. Kein Passwort. |
| **Wiederherstellung** | 10 einmalige Recovery-Codes + Enrollment-Token über die Container-Shell |
| **Sitzung** | 30 Tage, rollierend, Token rotiert alle 24 h, jederzeit serverseitig widerrufbar |
| **Speicher** | SQLite, eine Datei in einem Docker-Volume |
| **Externe Aufrufe** | keine — Schriften und Confetti liegen im Image |
| **Datenexport** | JSON-Export/Import direkt in der App |

Alle 48 Einstellungen, Drag & Drop, Wiederholungen, Matrix-Regen und Konfetti
sind unverändert erhalten.

---

## Voraussetzungen

1. **Eine Domain mit HTTPS.** Passkeys sind kryptografisch an den Hostnamen
   gebunden und funktionieren nur in einem *secure context*. Über
   `http://192.168.x.x` lässt sich prinzipiell keine Anmeldung durchführen.
2. **Ein Reverse Proxy**, der TLS terminiert — hier Nginx Proxy Manager.
3. **Docker** mit Compose-Unterstützung.

> **Wichtig:** `APP_ORIGIN` legt fest, für welche Adresse Passkeys gelten.
> Änderst du die Domain später, werden alle registrierten Passkeys ungültig
> und du musst dich per Recovery-Code neu einrichten. Überleg dir den Namen
> also einmal richtig.

---

## Einrichtung mit Portainer

### 1. IP-Adressen notieren

Zwei Adressen werden gleich gebraucht. Jeweils im betreffenden LXC:

```bash
hostname -I
```

- die des **Docker-LXC** — sie kommt in NPM als *Forward Hostname*,
- die des **NPM-LXC** — sie kommt in den Stack als `TRUST_PROXY`.

### 2. Stack anlegen

In Portainer: **Stacks → Add stack → Repository**

| Feld | Wert |
|---|---|
| Repository URL | die URL dieses Repos |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |

Unter **Environment variables** eintragen:

```
APP_ORIGIN=https://tasks.deinedomain.de
TRUST_PROXY=10.0.0.10
TZ=Europe/Berlin
```

`TRUST_PROXY` ist die IP des NPM-LXC. Ohne sie läuft alles weiter, aber die
App sieht jede Anfrage als vom Proxy kommend: Das Rate-Limit gilt dann für
alle Geräte gemeinsam und im Sicherheitsprotokoll steht überall die
Proxy-Adresse. Alle weiteren Variablen sind optional, siehe
[`.env.example`](.env.example).

Dann **Deploy the stack**. Portainer klont das Repo und baut das Image; der
erste Build dauert ein paar Minuten, weil die Schriften geladen werden.

### 3. Proxy-Host in Nginx Proxy Manager

Siehe [docs/nginx-proxy-manager.md](docs/nginx-proxy-manager.md) — dort steht
Feld für Feld, was einzutragen ist.

### 4. Ersten Passkey registrieren

Beim ersten Start schreibt der Container einen einmaligen Enrollment-Token ins
Log:

```
========================================================================
  SETUP REQUIRED - no passkey is registered yet.
  Open https://tasks.deinedomain.de and enter this one-time enrollment token:

      kcjczR3PEgcpP9ju44T-iekdzJ7FhnHp3739Jksv_TE

  Valid until 2026-09-09T10:15:00.000Z.
========================================================================
```

In Portainer unter **Containers → tasks → Logs** ablesen. Falls er abgelaufen
ist, einen neuen erzeugen:

```bash
docker compose exec app node src/cli.js enroll
```

Dann die Domain im Browser öffnen, den Token einfügen, Gerätenamen vergeben
und den Passkey anlegen.

**Danach werden dir einmalig 10 Recovery-Codes angezeigt. Speichere sie sofort
offline** — sie erscheinen nie wieder und sind ohne Shell-Zugriff dein einziger
Weg zurück, wenn du alle Geräte verlierst.

### 5. Zweites Gerät

In der App: **Einstellungen → Konto → Token erzeugen**. Auf dem neuen Gerät die
Domain öffnen, *Neues Gerät anmelden* wählen und den Token einfügen.

Registriere von Anfang an mindestens zwei Geräte. Das ist der bequemste
Schutz gegen ein Aussperren.

---

## Betrieb

### Verwaltung über die Container-Shell

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

### Aktualisieren

In Portainer beim Stack **Pull and redeploy** — Portainer holt den neuen Stand
und baut das Image neu. Datenbank und Passkeys liegen im Volume und bleiben
erhalten.

### Sichern

Die gesamte Datenbank liegt in einer Datei im Volume `tasks-data`. Ein
konsistenter Snapshot:

```bash
docker compose exec app node -e "const D=require('better-sqlite3');new D('/data/tasks.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp app:/data/backup.db ./tasks-backup.db
```

Für die reinen Aufgaben reicht **Einstellungen → Konto → Export**. Dieser
Export enthält bewusst **keine** Passkeys und keine Recovery-Codes — er ist
zum Weitergeben und Archivieren gedacht, nicht als vollständiges Backup.

Am einfachsten sicherst du ohnehin den ganzen LXC über dein Proxmox-Backup.

---

## Wenn du ausgesperrt bist

1. **Ein anderes Gerät funktioniert noch** → dort anmelden, unter
   *Einstellungen → Konto* einen neuen Enrollment-Token erzeugen.
2. **Kein Gerät mehr, aber Recovery-Codes vorhanden** → auf der Anmeldeseite
   *Passkey verloren?* wählen und einen Code einlösen. Damit werden alle
   Sitzungen beendet und du kannst sofort einen neuen Passkey registrieren.
3. **Weder Gerät noch Code** → Shell-Zugriff auf den LXC:
   `docker compose exec app node src/cli.js enroll`

Mehr dazu in [docs/recovery.md](docs/recovery.md).

---

## Lokale Entwicklung

```bash
npm --prefix server install
node scripts/fetch-assets.mjs        # Schriften nach web/vendor/ laden
cd server && APP_ORIGIN=http://localhost:8080 DATA_DIR=../data node src/server.js
```

`http://localhost:8080` gilt als secure context, Passkeys funktionieren dort
also auch ohne TLS. Für jede andere Adresse verweigert der Server den Start
mit einer Erklärung, statt eine Anmeldeseite auszuliefern, die nie
funktionieren kann.

### Tests

```bash
npm --prefix server test
```

Startet einen Server auf einem freien Port mit Wegwerf-Datenbank und fährt
54 Prüfungen durch: Registrierung, Anmeldung, Wiederholungslogik,
Export/Import, Origin-Prüfung, verbrauchte Recovery-Codes, wiederverwendete
Assertions und Klon-Erkennung. Die WebAuthn-Seite übernimmt dabei ein in
`server/test/e2e.mjs` implementierter Software-Authenticator, es wird also
wirklich signiert und verifiziert.

### Aufbau

```
server/src/
  server.js        Bootstrap, Sicherheits-Header, Routen-Registrierung
  config.js        Konfiguration aus ENV, validiert beim Start
  db.js            SQLite-Schema
  security.js      CSP, Same-Origin-Prüfung
  static.js        Statischer Handler mit fester Allowlist
  settings.js      Einstellungen, gegen die Defaults gefiltert
  cli.js           Konsolenwerkzeug
  auth/            Sitzungen, WebAuthn, Enrollment, Krypto-Helfer
  routes/          auth, tasks, settings, data
web/
  index.html       Markup
  css/             app.css (übernommen), auth.css (neu)
  js/              ES-Module, kein Build-Schritt
  vendor/          Schriften und Confetti (nicht im Repo, siehe unten)
shared/
  settings-defaults.json   einzige Quelle für die 48 Einstellungen
```

`web/vendor/` ist absichtlich nicht eingecheckt. `scripts/fetch-assets.mjs`
lädt die Dateien und prüft jede gegen `scripts/vendor-lock.json`; weicht ein
Hash ab, bricht der Build ab. Beim Docker-Build passiert das automatisch.

Neue Versionen holen und den Lock erneuern:

```bash
node scripts/fetch-assets.mjs --update
```

---

## Sicherheit

Threat Model, umgesetzte Maßnahmen und bewusste Grenzen stehen in
[SECURITY.md](SECURITY.md).

## Lizenz

MIT. Die geladenen Schriften unterliegen ihren eigenen Lizenzen: die
Google-Fonts-Familien der SIL Open Font License, Nasalization der Lizenz von
Typodermic Fonts.
