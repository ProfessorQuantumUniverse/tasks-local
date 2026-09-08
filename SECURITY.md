# Sicherheit

Was diese Installation schützt, wie, und wo bewusst Grenzen gezogen wurden.

---

## Threat Model

Die App ist über das Internet erreichbar und enthält private Aufgabenlisten.
Verteidigt wird gegen:

| Angreifer | Ziel |
|---|---|
| Internet-Hintergrundrauschen | Scanner, Credential Stuffing, bekannte Exploit-Pfade |
| Gezielter Angreifer mit der URL | Anmeldung erraten, Sitzung stehlen, an Daten kommen |
| Bösartige Website, die du besuchst | Per CSRF Aufgaben ändern oder auslesen |
| Phishing-Seite, die die App nachbaut | Zugangsdaten abgreifen |
| Kompromittierter CDN / Lieferkette | Schadcode in die Seite einschleusen |
| Jemand mit Zugriff auf die Datenbankdatei | Sitzungen oder Recovery-Codes wiederverwenden |

**Nicht** verteidigt wird gegen: root auf dem Docker-Host, physischen Zugriff
auf den entsperrten Proxmox-Server, oder ein kompromittiertes Endgerät, an dem
du dich bereits angemeldet hast. Wer den Host kontrolliert, kontrolliert die
App.

---

## Authentifizierung

**Nur Passkeys.** Es gibt kein Passwort — also nichts zum Erraten,
Wiederverwenden oder Abgreifen.

- `userVerification: 'required'` — der Authenticator muss Biometrie oder PIN
  prüfen. Ein gestohlenes, entsperrtes Handy ist damit noch keine Anmeldung.
- `residentKey: 'required'` — Discoverable Credentials. Deshalb gibt es kein
  Benutzernamenfeld, und der Server verrät nicht, was registriert ist.
- **Phishing-resistent durch Konstruktion.** Ein Passkey ist an
  `APP_ORIGIN` gebunden. Eine nachgebaute Seite unter einer anderen Domain
  bekommt vom Browser schlicht keine Signatur — kein Aufmerksamkeitstest, der
  schiefgehen kann.
- **Klon-Erkennung.** Der Signaturzähler wird vor der Verifikation geprüft.
  Steigt er nicht an, wird die Anmeldung abgelehnt **und alle bestehenden
  Sitzungen werden beendet**, weil das der klassische Hinweis auf einen
  duplizierten Authenticator ist.
- **Challenges** liegen serverseitig, werden über eine zufällige ID in einem
  kurzlebigen Cookie referenziert und beim ersten Zugriff gelöscht. Eine
  Assertion lässt sich nicht wiederverwenden.

### Registrierung neuer Passkeys

Das Anlegen eines Passkeys ist die einzige Operation, die aus dem Nichts
Zugriff erzeugen kann. Sie verlangt immer einen von drei Nachweisen:

1. einen unbenutzten Enrollment-Token (beim ersten Start im Log, sonst über
   die Container-Shell),
2. eine bestehende Sitzung (zweites Gerät hinzufügen),
3. einen gültigen Recovery-Code.

Enrollment-Token sind einmalig, laufen ab und werden nur gehasht gespeichert.
Verbraucht werden sie erst, **wenn** ein Passkey erfolgreich entstanden ist —
ein abgebrochener Versuch sperrt dich also nicht aus.

### Recovery-Codes

10 Codes mit je ~50 Bit Entropie, einzeln mit scrypt gehasht. Beim Prüfen
werden immer alle Kandidaten durchlaufen, damit der Aufwand nicht verrät, ob
und wo ein Treffer lag. Ein eingelöster Code beendet **alle** Sitzungen und
entwertet alle offenen Enrollment-Token, bevor ein neuer ausgegeben wird — wer
Recovery braucht, hat Geräte verloren.

Der Endpunkt ist auf 5 Versuche pro 15 Minuten begrenzt.

---

## Sitzungen

- Das Cookie enthält ein 256-Bit-Zufallstoken. Gespeichert wird nur dessen
  SHA-256, ein Datenbankleck gibt also keine benutzbaren Sitzungen her.
- `HttpOnly`, `Secure`, `SameSite=Lax`, kein `Domain`-Attribut.
- **`__Host-` Präfix** (sobald HTTPS aktiv ist): der Browser nimmt das Cookie
  nur an, wenn es `Secure` ist, `Path=/` hat und keine Domain trägt. Eine
  kompromittierte Nachbardomain kann damit kein Sitzungscookie unterschieben.
- Rotation alle 24 h. Der alte Wert bleibt 120 Sekunden gültig, damit parallel
  laufende Anfragen nicht abbrechen.
- Serverseitig jederzeit widerrufbar, einzeln oder komplett.

---

## CSRF

Zwei unabhängige Schichten:

1. `SameSite=Lax` — eine fremde Seite bekommt das Cookie gar nicht erst
   mitgeschickt.
2. Eine Origin-Prüfung für jede schreibende Anfrage. Fehlt der `Origin`-Header
   oder passt er nicht exakt zu `APP_ORIGIN`, wird abgelehnt. Moderne Browser
   senden ihn bei nicht-GET immer, ein fehlender Header gilt daher als
   verdächtig, nicht als harmlos.

---

## Content-Security-Policy

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'; object-src 'none'; worker-src 'none'
```

Kein `unsafe-inline`, kein `unsafe-eval`, keine externe Origin. Dafür wurden
sämtliche `style=`-Attribute aus dem Markup in Klassen überführt und alle
Schriften sowie die Confetti-Bibliothek lokal eingebettet. Eine erfolgreiche
HTML-Injektion könnte damit weder ein fremdes Skript nachladen noch Daten an
einen Drittanbieter senden.

Die Oberfläche wird durchgehend über `textContent` und `createElement`
aufgebaut. `innerHTML` kommt an genau einer Stelle vor — dem leeren
Zustand — und dort ohne jede eingesetzte Variable.

> **Hinweis für Cloudflare:** Rocket Loader, Email Obfuscation und ähnliche
> Funktionen injizieren Inline-Skripte in die Seite. Die CSP blockiert sie,
> und die App bleibt schwarz. Diese Funktionen für die Domain deaktiviert
> lassen.

---

## Lieferkette

- **Sechs Laufzeit-Abhängigkeiten**, `npm audit` meldet null Schwachstellen.
- `@fastify/static` wurde bewusst **entfernt**: es hatte offene Path-Traversal-
  Advisories. Statische Dateien liefert ein eigener Handler aus, der beim
  Start eine feste Allowlist aus URL-Pfad → Datei aufbaut. Was nicht exakt als
  Schlüssel in dieser Map steht, ist ein 404. Es gibt keinen Pfad zu
  normalisieren, also auch keinen Traversal-Angriff.
- **Kein natives Passwort-Hashing-Paket.** Gehasht werden nur hochentropische,
  selbst erzeugte Werte, daher reicht scrypt aus `node:crypto`.
- **WebAuthn-Kodierung selbst geschrieben** (~40 Zeilen), statt ein weiteres
  Paket in einen sicherheitskritischen Pfad zu ziehen.
- **Schriften und Confetti liegen im Repository** und werden beim Build gegen
  `scripts/vendor-lock.json` geprüft. Weicht ein Byte ab, bricht der Build ab.
  Der Build braucht dafür kein Netz — und schlägt auch nicht fehl, nur weil
  ein CDN inzwischen eine neuere Version ausliefert.

---

## Eingabevalidierung

Jede Route hat ein JSON-Schema. Die Ajv-Voreinstellungen von Fastify sind
abgeschaltet:

```js
removeAdditional: false, coerceTypes: false, useDefaults: false
```

Ein Body mit unbekannten Feldern oder falschen Typen wird also **abgelehnt**
statt stillschweigend zurechtgebogen. Einstellungen werden zusätzlich gegen
`shared/settings-defaults.json` gefiltert: unbekannte Schlüssel fallen weg,
falsch typisierte Werte fallen auf den Standard zurück.

Alle SQL-Zugriffe laufen über vorbereitete Statements mit gebundenen
Parametern.

---

## Rate Limiting

| Bereich | Budget |
|---|---|
| Global | 300 Anfragen / Minute je IP |
| Anmeldung | 30 / 5 Minuten |
| Registrierung, Token, Recovery-Codes | 10 / 5 Minuten |
| Recovery-Code einlösen | 5 / 15 Minuten |

Die Quell-IP stammt aus `X-Forwarded-For`, aber nur von Absendern innerhalb
privater Netze (`TRUST_PROXY`). Auf `true` gesetzt könnte jeder seine Adresse
fälschen und das Limit umgehen — deshalb ist das nicht der Standard.

---

## Container

| Maßnahme | Wirkung |
|---|---|
| `USER node` (uid 1000) | kein root im Container |
| `read_only: true` | Wurzeldateisystem nicht beschreibbar |
| Anwendungscode gehört root, `chmod a-w` | der Prozess kann seinen eigenen Code nicht ändern |
| `cap_drop: ALL` | keine Linux-Capabilities |
| `no-new-privileges` | kein setuid-Aufstieg |
| `tmpfs /tmp` mit `noexec,nosuid,nodev` | kein Ausführen aus dem einzigen Schreibpfad |
| `pids_limit: 256`, 512 MB RAM | begrenzt, was ein Fehler anrichten kann |
| kein veröffentlichter Port | erreichbar nur über den Reverse Proxy |

Nachprüfbar:

```bash
docker exec tasks id                       # uid=1000(node)
docker exec tasks touch /newfile           # Read-only file system
docker ps --filter name=tasks --format '{{.Ports}}'   # leer
```

> Im unprivilegierten Proxmox-LXC greifen AppArmor- und seccomp-Profile je
> nach Konfiguration nur eingeschränkt. Alle oben genannten Maßnahmen
> funktionieren dort trotzdem, weil sie auf Dateirechten, Capabilities und
> Namespaces beruhen.

---

## Daten im Ruhezustand

Die SQLite-Datei liegt mit `0600` in einem Docker-Volume, das Verzeichnis hat
`0700`, beides gehört dem App-Benutzer. Eine Verschlüsselung der Datei wurde
bewusst **nicht** eingebaut: Der Schlüssel müsste auf demselben Host liegen,
womit er gegen genau den Angreifer nichts ausrichtet, der ihn erreichen kann.
Wirksam ist an dieser Stelle Verschlüsselung auf Datenträgerebene.

Der JSON-Export enthält **keine** Passkeys, Sitzungen oder Recovery-Codes.
Er darf kopiert und verschickt werden, ohne Zugriff zu verschenken.

---

## Protokollierung

Sitzungscookies und Authorization-Header werden aus den Logs entfernt.
Sicherheitsrelevante Ereignisse — Anmeldungen, Fehlversuche, Registrierungen,
Recovery, Sitzungswiderrufe — landen in einer Tabelle, sichtbar unter
*Einstellungen → Konto → Anmelde-Protokoll*, begrenzt auf die letzten 5000
Einträge.

Fehlermeldungen nach außen sind absichtlich unspezifisch: ein
fehlgeschlagener Login sagt „authentication_failed", der genaue Grund steht
nur im Log.

---

## Bekannte Grenzen

- **Ein Konto.** Es gibt keine Rollen und keine Mandantentrennung. Wer sich
  anmelden kann, sieht alles.
- **Kein automatisches Backup.** Bewusst so gewählt; gesichert wird über
  Proxmox oder den JSON-Export.
- **`APP_ORIGIN` ist endgültig.** Ein Domainwechsel entwertet alle Passkeys.
  Der Weg zurück führt dann über einen Recovery-Code oder die Container-Shell.
- **Kein CSP-Reporting.** Verstöße blockiert der Browser still; es gibt keinen
  Endpunkt, der sie meldet.
- **Rate Limits leben im Prozessspeicher.** Ein Neustart setzt sie zurück.
  Bei einer einzelnen Instanz ist das unkritisch.

---

## Nachprüfen

```bash
npm --prefix server test
```

Die Suite implementiert einen Software-Authenticator und belegt unter anderem,
dass eine wiederverwendete Assertion abgelehnt wird, ein nicht steigender
Zähler alle Sitzungen beendet, ein Recovery-Code nur einmal funktioniert, ein
Enrollment-Token verbraucht wird, schreibende Anfragen ohne passenden Origin
scheitern und der Export keine Zugangsdaten enthält.

---

## Wenn du eine Schwachstelle findest

Es ist deine eigene Installation. Aktualisieren:

```bash
npm --prefix server audit
npm --prefix server update
```

und den Stack in Portainer neu deployen. Nach einem Vorfall:

```bash
docker compose exec app node src/cli.js revoke-sessions
docker compose exec app node src/cli.js revoke-enrollments
docker compose exec app node src/cli.js recovery-codes
```
