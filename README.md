# Auto-Fix All Open Files & Markdown Rules

Diese VS Code Extension behebt mit nur einem Klick alle automatisch lösbaren Linter- und Formatierungsprobleme in **allen aktuell geöffneten Dateien**, speichert diese direkt ab und bietet eine **Rückgängig-Funktion (Undo)** über alle geänderten Dateien hinweg.

Speziell optimiert für durch KI-Agenten erstellte `.md` (Markdown)-Dateien!

## Features

* **Ein-Klick Multi-File Auto-Fix:** Führt `editor.action.fixAll`, ESLint-Autofix (`eslint.executeAutofix`) und `markdownlint.fixAll` (mehrstufig) auf allen offenen Dateien aus und speichert sie.
* **Entfernung unnötiger Typecasts:** Entfernt überflüssige Typ-Assertions, Typecasts und Typkonvertierungen (z. B. via `@typescript-eslint/no-unnecessary-type-assertion`, Biome, Roslyn `IDE0004`, Sonar `S1905`, Dart `unnecessary_cast`, Pyrefly `unnecessary-type-conversion` / `redundant-cast`, Ruff) sowie syntaktisch redundante Casts (wie verkettete `expr as T as T`, `<T><T>expr`, `x!!`, Python `bool(x)`, `str(x)`, `int(x)`, `float(x)`, `typing.cast(T, x)` oder redundante Literal-Casts bei bereits typisierten Variablen) automatisch bei jedem Durchlauf oder über einen eigenen Befehl.
* **Intelligente Markdown-Regelkorrektur:**
  * **MD040 (Unlabeled Code Blocks):** Erkennt automatisch unmarkierte Codeblöcke und ergänzt `text` (bei Ordner-/Baumstrukturen wie `├──`, `└──`) oder `bash` (bei Konsolenbefehlen wie `npm`, `git`, `docker`, `cd`).
  * **MD031 (Blanks around fences):** Stellt sicher, dass Codeblöcke vor und nach den Fences (` ``` `) von Leerzeilen umgeben sind.
  * **MD001 (Heading Increments):** Korrigiert zu große Sprünge in der Überschriften-Hierarchie (z. B. H1 gefolgt von H4 $\rightarrow$ H2), sodass Überschriften maximal um 1 steigen.
  * **MD024 (Duplicate Headings):** Entfernt leere Überschriftenzeilen (`####`) und nummeriert doppelte Überschriftentitel automatisch (`Titel (2)`, `Titel (3)`).
  * **MD033 (Inline HTML):** Erkennt nicht-standardmäßige HTML-Pseudo-Tags im Fließtext (z. B. `<undefined>`, `<T>`) und wandelt sie in Inline-Code-Spans (`` `<undefined>` ``) um.
  * **MD025 (Multiple Top-Level Headings):** Wandelt ab der zweiten `#`-Überschrift im Dokument diese automatisch in `##` um.
  * **MD036 (Emphasis used as Heading):** Wandelt alleinstehende hervorgehobene Zeilen (`**Überschrift**`) automatisch in echte Überschriften (`## **Überschrift**`) um.
  * **Fehlende Top-Level-Überschrift:** Besitzt eine Datei keine `#`-Überschrift, wird der Dateiname (ohne Endung, erster Buchstabe groß) als `# Titel` an den Anfang gesetzt – gefolgt von einer Leerzeile.
* **Python: Identitätsvergleiche, die immer True/False ergeben:** Meldet ein Analyzer z.B. ``Identity comparison `False is True` is always False``, wird die betroffene Stelle PEP-8-konform umgeschrieben: `x is True` → `x`, `x is False` → `not x` (ebenso `is not True/False` und `True is x`). Es werden ausschließlich gemeldete Stellen angepasst – nicht pauschal jedes `is True` in der Datei.
  * Betroffene `assert a and b`-Zeilen werden zusätzlich in einzelne `assert`-Zeilen aufgeteilt, damit pytest bei Fehlschlägen den konkreten Teilausdruck anzeigt.
  * Abschaltbar über die Einstellungen `autoFixAll.python.fixIdentityComparisons` und `autoFixAll.python.splitAssertions`.
* **Python: Unnötige Typecasts & Typkonvertierungen:** Meldet ein Analyzer wie Pyrefly `Unnecessary 'bool()'/'str()'/'int()' call; argument is already of type ...` oder `redundant-cast`, werden die redundanten Aufrufe automatisch entfernt (z. B. `bool(user.is_admin)` $\rightarrow$ `user.is_admin`, `(int(x), int(y))` $\rightarrow$ `(x, y)`). Abschaltbar über `autoFixAll.python.removeUnnecessaryTypecasts`.
* **Spezielle KI-Format-Fixer für Coding-Agents:**
  * **JSON:** Entfernt automatisch ungültige Trailing-Commas (`[1, 2, 3,]` $\rightarrow$ `[1, 2, 3]`), repariert einfache Anführungszeichen in Keys/Strings (`'name'` $\rightarrow$ `"name"`) und bereinigt ungültige Inline-Kommentare.
  * **YAML:** Ersetzt unzulässige Tabs in der Einrückung durch 2 Leerzeichen und schneidet überflüssigen Trailing-Whitespace ab.
  * **Shell-Skripte (`.sh`, `.bash`):** Konvertiert Windows-CRLF-Zeilenumbrüche automatisch zu Linux-LF (verhindert den berüchtigten `\r: command not found`-Fehler in Containern/Linux) und rückt Shebang-Zeilen (`#!`) an Zeile 1.
  * **TOML (`pyproject.toml`, `Cargo.toml`):** Führt versehentlich von KIs doppelt angehängte Tabellen-Sektionen (wie doppelte `[project]` oder `[tool.ruff]`) sauber zusammen.
  * **SVG & XML:** Formatiert nicht geschlossene Void-Elemente (`<path ...>`, `<circle ...>` etc.) automatisch als selbstschließend (`<... />`).
  * **SQL:** Ergänzt fehlende abschließende Semikolons (`;`) an Statement-Enden.
* **Sicheres Undo-System:** Macht bei Bedarf den gesamten letzten Auto-Fix-Durchlauf über alle betroffenen Dateien hinweg mit einem Klick rückgängig.

### Package

Visual Studio Marketplace - [Auto Fix All Open](https://marketplace.visualstudio.com/items?itemName=DanielRoesch.auto-fix-all-open).
