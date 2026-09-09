# Zugriff wiederherstellen

Es gibt kein Passwort zum Zurücksetzen und keine E-Mail, an die etwas
geschickt werden könnte. Stattdessen drei unabhängige Wege zurück.

---

## Vorher: sich gar nicht erst aussperren

1. **Mindestens zwei Passkeys registrieren** — Handy und Laptop. Das ist mit
   Abstand der bequemste Schutz.
2. **Die 10 Recovery-Codes aufbewahren.** Sie werden genau einmal angezeigt,
   direkt nach der ersten Einrichtung. Passwortmanager oder Ausdruck.
3. **Wissen, wie du an die Container-Shell kommst.** Portainer oder SSH in den
   LXC.

Wie viele Codes noch unbenutzt sind, siehst du unter
*Einstellungen → Konto → Recovery-Codes*.

---

## Weg 1 — ein anderes Gerät funktioniert noch

Der Normalfall, wenn ein Telefon verloren geht.

1. Auf dem funktionierenden Gerät anmelden.
2. *Einstellungen → Konto → Weiteres Gerät anmelden → Token erzeugen*
3. Auf dem neuen Gerät die Domain öffnen, *Neues Gerät anmelden*, Token
   einfügen, Passkey anlegen.
4. Den verlorenen Passkey unter *Einstellungen → Konto* entfernen.
5. Danach *Andere abmelden*, damit eine Sitzung auf dem verlorenen Gerät
   endet.

Der Token gilt 15 Minuten und funktioniert genau einmal.

---

## Weg 2 — kein Gerät mehr, aber Recovery-Codes

1. Die Domain öffnen, *Passkey verloren?* wählen.
2. Einen Recovery-Code eingeben.
3. Die App wechselt direkt zur Registrierung, der Token ist schon eingetragen
   und 10 Minuten gültig.
4. Neuen Passkey anlegen.

Beim Einlösen passiert außerdem:

- **alle** Sitzungen werden beendet,
- **alle** offenen Enrollment-Token werden entwertet,
- der benutzte Code ist verbraucht.

Danach solltest du unter *Einstellungen → Konto* die alten, nicht mehr
erreichbaren Passkeys entfernen und mit *Neu erzeugen* einen frischen Satz
Recovery-Codes anlegen.

Der Endpunkt erlaubt 5 Versuche pro 15 Minuten.

---

## Weg 3 — weder Gerät noch Code

Über die Container-Shell. Wer sie erreicht, kontrolliert ohnehin den Server —
deshalb genügt hier der Zugriff selbst als Nachweis.

In Portainer: **Containers → tasks → Console → `/bin/sh` → Connect**, oder per
SSH im LXC:

```bash
docker compose exec app node src/cli.js enroll
```

Der ausgegebene Token wird auf der Anmeldeseite unter *Neues Gerät anmelden*
eingegeben.

Aufräumen danach:

```bash
docker compose exec app node src/cli.js credentials          # was ist registriert
docker compose exec app node src/cli.js delete-credential <id-anfang>
docker compose exec app node src/cli.js recovery-codes       # neuer Satz Codes
docker compose exec app node src/cli.js revoke-sessions      # alles abmelden
```

---

## Nach einem verlorenen oder gestohlenen Gerät

In dieser Reihenfolge:

```bash
docker compose exec app node src/cli.js revoke-sessions
docker compose exec app node src/cli.js revoke-enrollments
docker compose exec app node src/cli.js credentials
docker compose exec app node src/cli.js delete-credential <id-des-geraets>
docker compose exec app node src/cli.js recovery-codes
```

Der Passkey selbst ist auf dem Gerät durch dessen Biometrie oder PIN
geschützt und ohne diese nicht benutzbar. Trotzdem ist das Entfernen richtig:
Es beendet den Zugriff endgültig, statt sich auf die Gerätesperre zu
verlassen.

---

## Wenn die Domain sich ändert

Passkeys sind kryptografisch an `APP_ORIGIN` gebunden. Nach einem Wechsel
funktioniert kein registrierter Passkey mehr — er wird für die neue Domain
nicht einmal angeboten.

1. `APP_ORIGIN` im Stack auf die neue Adresse setzen, den Reverse Proxy
   anpassen, neu deployen.
2. Enrollment-Token erzeugen (Weg 3) und einen Passkey für die neue Domain
   registrieren.
3. Die alten Einträge entfernen:

```bash
docker compose exec app node src/cli.js credentials
docker compose exec app node src/cli.js delete-credential <alte-id>
```

Aufgaben und Einstellungen bleiben dabei unberührt — sie hängen nicht am
Passkey.

---

## Wenn gar nichts mehr geht

Die Daten liegen unverschlüsselt in einer SQLite-Datei. Selbst wenn die
Anmeldung endgültig verloren ist, sind die Aufgaben nicht weg:

```bash
docker compose cp app:/data/tasks.db ./tasks.db
sqlite3 tasks.db "SELECT title, due_date, progress FROM tasks;"
```

Ganz von vorn anfangen — **löscht alle Aufgaben und alle Passkeys**:

```bash
docker compose down
docker volume rm tasks-data
docker compose up -d
```

Beim nächsten Start steht wieder ein Setup-Token im Log.
