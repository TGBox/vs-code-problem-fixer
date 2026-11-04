# Auto-Fix All Open Files & Markdown Rules

Diese VS Code Extension behebt mit nur einem Klick alle automatisch lösbaren Linter- und Formatierungsprobleme in **allen aktuell geöffneten Dateien**, speichert diese direkt ab und bietet eine **Rückgängig-Funktion (Undo)** über alle geänderten Dateien hinweg.

Speziell optimiert für durch KI-Agenten erstellte `.md` (Markdown)-Dateien!

## Features

* **Ein-Klick Multi-File Auto-Fix:** Führt `editor.action.fixAll` und `markdownlint.fixAll` (mehrstufig) auf allen offenen Dateien aus und speichert sie.
* **Intelligente Markdown-Regelkorrektur:**
  * **MD040 (Unlabeled Code Blocks):** Erkennt automatisch unmarkierte Codeblöcke und ergänzt `text` (bei Ordner-/Baumstrukturen wie `├──`, `└──`) oder `bash` (bei Konsolenbefehlen wie `npm`, `git`, `docker`, `cd`).
  * **MD025 (Multiple Top-Level Headings):** Wandelt ab der zweiten `#`-Überschrift im Dokument diese automatisch in `##` um.
  * **MD036 (Emphasis used as Heading):** Wandelt alleinstehende hervorgehobene Zeilen (`**Überschrift**`) automatisch in echte Überschriften (`## **Überschrift**`) um.
  * **Fehlende Top-Level-Überschrift:** Besitzt eine Datei keine `#`-Überschrift, wird der Dateiname (ohne Endung, erster Buchstabe groß) als `# Titel` an den Anfang gesetzt – gefolgt von einer Leerzeile.
* **Python: Identitätsvergleiche, die immer True/False ergeben:** Meldet ein Analyzer z.B. ``Identity comparison `False is True` is always False``, wird die betroffene Stelle PEP-8-konform umgeschrieben: `x is True` → `x`, `x is False` → `not x` (ebenso `is not True/False` und `True is x`). Es werden ausschließlich gemeldete Stellen angepasst – nicht pauschal jedes `is True` in der Datei.
  * Betroffene `assert a and b`-Zeilen werden zusätzlich in einzelne `assert`-Zeilen aufgeteilt, damit pytest bei Fehlschlägen den konkreten Teilausdruck anzeigt.
  * Abschaltbar über die Einstellungen `autoFixAll.python.fixIdentityComparisons` und `autoFixAll.python.splitAssertions`.
* **Sicheres Undo-System:** Macht bei Bedarf den gesamten letzten Auto-Fix-Durchlauf über alle betroffenen Dateien hinweg mit einem Klick rückgängig.

### Package

Visual Studio Marketplace - [Auto Fix All Open](https://marketplace.visualstudio.com/items?itemName=DanielRoesch.auto-fix-all-open).
