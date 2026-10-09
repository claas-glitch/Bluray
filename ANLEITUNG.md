# Blu-ray Sammlung – Anleitung

## 1. Auf GitHub Pages hochladen (einmalig, ca. 10 Min.)

1. Auf https://github.com ein kostenloses Konto anlegen (falls noch keins da ist).
2. Oben rechts **+ → New repository**. Name z. B. `bluray`, Sichtbarkeit **Public**, dann **Create repository**.
3. Auf der neuen Seite **uploading an existing file** anklicken und **alle Dateien und den Ordner `icons`**
   aus diesem Ordner hineinziehen (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`).
   Dann unten **Commit changes**.
4. Im Repository **Settings → Pages**: unter „Branch“ `main` und `/ (root)` wählen, **Save**.
5. Nach 1–2 Minuten ist die App erreichbar unter `https://DEINNAME.github.io/bluray/`.

> Deine Filmdaten landen **nicht** bei GitHub. Dort liegt nur der Programmcode, die Sammlung bleibt auf dem iPhone.

## 2. Auf dem iPhone installieren

1. Die Adresse in **Safari** öffnen.
2. **Teilen**-Symbol → **Zum Home-Bildschirm** → Hinzufügen.
3. Die App über das neue Icon starten und beim ersten Scannen den **Kamerazugriff erlauben**.

## 3. TMDB-Key eintragen (für Cover & Filminfos)

1. Konto anlegen auf https://www.themoviedb.org/signup
2. Profil → **Einstellungen → API** → API-Schlüssel anfordern (Typ „Developer“, Zweck z. B. „private Filmsammlung“).
3. Den **API-Schlüssel** (oder den langen „Lesezugriffstoken“) kopieren.
4. In der App unter **Einstellungen** einfügen → **Speichern & testen**.

## 4. So funktioniert das Erfassen

- **Scannen** → Barcode auf der Rückseite in den Rahmen halten → EAN wird erkannt (Piepton).
- Ist die EAN schon in der Sammlung oder auf der Wunschliste, warnt die App (praktisch im Laden).
- Titel eintippen → Film aus der TMDB-Liste wählen → Cover, Genre, Regie, FSK usw. werden ausgefüllt.
- Format (Blu-ray / 4K UHD / 3D / DVD), Steelbook, Edition, Preis und Notizen anpassen → **Speichern**.
- **„Speichern & nächsten scannen“** eignet sich, wenn du das ganze Regal am Stück erfasst.
- Ohne Barcode: **„Nach Titel suchen“**. Fehlt ein Film bei TMDB: **„manuell anlegen“** und ein eigenes Foto machen.

## 5. Wunschliste

- Beim Anlegen oben **„Wunschliste“** wählen.
- **Amazon** sucht per EAN (falls vorhanden), sonst per Titel. **rebuy** sucht per Titel in der Kategorie Filme.
- Hast du einen genauen Produktlink, trag ihn beim Bearbeiten ein. Der Button öffnet dann direkt diese Seite.
- Tipp: Auf rebuy kannst du bei nicht lieferbaren Filmen einen **„Kaufalarm“** setzen.
- **„✓ Gekauft“** verschiebt den Film in die Sammlung.

## 6. Sicherung

Die Daten liegen nur auf dem iPhone. Unter **Einstellungen → Exportieren** regelmäßig eine Sicherung
(z. B. in iCloud Drive „Dateien“) speichern. **Importieren** stellt sie wieder her, auch auf einem anderen Gerät.
**CSV** öffnet sich in Excel/Numbers.

## 7. Optional: Titel automatisch aus dem Barcode

Freie EAN-Datenbanken erlauben keinen direkten Zugriff aus einer Web-App. Mit einem kostenlosen
Cloudflare-Worker geht es trotzdem:

1. Konto auf https://dash.cloudflare.com anlegen.
2. **Workers & Pages → Create → Create Worker**, Name z. B. `bluray-ean`, **Deploy**.
3. **Edit code**, den Inhalt durch den Inhalt von `worker.js` ersetzen, **Deploy**.
4. Die Worker-Adresse (`https://bluray-ean.DEINNAME.workers.dev`) in der App unter Einstellungen eintragen.

Die Datenbank (UPCitemdb) erlaubt ca. 100 Abfragen pro Tag und kennt nicht jede deutsche Blu-ray.
Klappt es nicht, tippst du den Titel einfach wie gewohnt ein.

## Updates

Wenn du Dateien änderst und neu hochlädst, erhöhe in `sw.js` die Zeile `const VERSION = 'v1'` (→ `'v2'`),
damit das iPhone die neue Version lädt. Danach die App einmal schließen und wieder öffnen.
