import * as vscode from 'vscode';
import {
    fixIdentityComparisonsInText,
    IdentityComparisonTarget,
    isIdentityComparisonDiagnostic
} from './pythonIdentityFixes';
import { applyCustomFormatFixes } from './aiFormatFixers';
import {
    fixPythonTypecastsInText,
    isPythonTypecastDiagnostic,
    PythonTypecastTarget
} from './pythonTypecastFixes';

/**
 * Interface zur Speicherung eines Dateizustands vor der Änderung (für das Undo-System)
 */
interface FileSnapshot {
    uri: vscode.Uri;
    originalContent: string;
}

/**
 * Globaler Stack für Rückgängig-Operationen (speichert Snapshots pro Durchlauf)
 */
const undoStack: FileSnapshot[][] = [];

/**
 * Statusleisten-Elemente
 */
let fixStatusBarItem: vscode.StatusBarItem;
let undoStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "auto-fix-all-open" ist nun aktiv!');

    // Initialisiere den Context-Key für die Sichtbarkeit des Undo-Buttons
    vscode.commands.executeCommand('setContext', 'autoFixAll.canUndo', false);

    // 1. Statusleisten-Button zum Beheben (extrem hohe Priorität 10000 = ganz links neben dem Probleme-Zähler)
    fixStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    fixStatusBarItem.command = 'auto-fix-all.fixAllOpen';
    fixStatusBarItem.text = '$(sparkle) Auto-Fix All';
    fixStatusBarItem.tooltip = 'Behebt alle automatisch lösbaren Probleme, KI-Formatfehler (Markdown, Python, JSON, YAML, Shell, TOML, SVG, SQL) & unnötige Typecasts in offenen Dateien.';
    fixStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    fixStatusBarItem.show();

    // 2. Statusleisten-Button für Undo (wird nur angezeigt, wenn ein Backup existiert)
    undoStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
    undoStatusBarItem.command = 'auto-fix-all.undoLastFix';
    undoStatusBarItem.text = '$(discard) Undo Auto-Fix';
    undoStatusBarItem.tooltip = 'Macht den letzten Auto-Fix Durchlauf über alle Dateien hinweg rückgängig.';
    undoStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // 3. Befehl: Alle Probleme beheben
    const fixAllDisposable = vscode.commands.registerCommand('auto-fix-all.fixAllOpen', async () => {
        await runAutoFixOnAllOpenFiles();
    });

    // 4. Befehl: Unnötige Typecasts entfernen
    const removeTypecastsDisposable = vscode.commands.registerCommand('auto-fix-all.removeUnnecessaryTypecasts', async () => {
        await runRemoveUnnecessaryTypecastsOnAllOpenFiles();
    });

    // 5. Befehl: Letzten Vorgang rückgängig machen
    const undoDisposable = vscode.commands.registerCommand('auto-fix-all.undoLastFix', async () => {
        await undoLastAutoFix();
    });

    context.subscriptions.push(
        fixStatusBarItem,
        undoStatusBarItem,
        fixAllDisposable,
        removeTypecastsDisposable,
        undoDisposable
    );
}

/**
 * Hauptfunktion: Durchläuft alle geöffneten Tabs, sichert den Zustand,
 * führt Markdown-Korrekturen sowie VS Code Auto-Fixes aus und speichert.
 */
async function runAutoFixOnAllOpenFiles(): Promise<void> {
    const targetUris = getAllOpenTextDocumentUris();

    if (targetUris.length === 0) {
        vscode.window.showInformationMessage('Keine geöffneten Textdateien zum Reparieren gefunden.');
        return;
    }

    const currentBatchSnapshots: FileSnapshot[] = [];
    const originallyActiveEditor = vscode.window.activeTextEditor;
    let modifiedFilesCount = 0;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Behebe Probleme in geöffneten Dateien...',
            cancellable: false
        },
        async (progress) => {
            const total = targetUris.length;

            for (let i = 0; i < total; i++) {
                const uri = targetUris[i];
                const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
                progress.report({
                    message: `Bearbeite ${fileName} (${i + 1}/${total})`,
                    increment: (100 / total)
                });

                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    if (document.isClosed) {
                        continue;
                    }

                    const originalContent = document.getText();
                    const isMarkdown = document.languageId === 'markdown' || uri.fsPath.toLowerCase().endsWith('.md');
                    const isPython = document.languageId === 'python' || uri.fsPath.toLowerCase().endsWith('.py');

                    // Schritt A: Dokument im Editor fokussieren, damit 'editor.action.fixAll'
                    // und 'markdownlint.fixAll' zuverlässig auf diesem Dokument arbeiten können.
                    await vscode.window.showTextDocument(document, {
                        preview: false,
                        preserveFocus: false
                    });

                    // Pause, damit Language Server & Linter (wie markdownlint) das Dokument analysieren können
                    await delay(150);

                    // Schritt B: Spezielle eigene Regeln für Markdown-Dateien anwenden:
                    // - MD040: Codeblöcke ohne Sprache (Baumstruktur -> text, Befehle -> bash)
                    // - MD036: Emphasis used as heading (**Titel** -> ## **Titel**)
                    // - MD025: Doppelte Top-Level-Überschriften (# Titel -> ## Titel ab der 2. H1)
                    // - Fehlende H1: Dateiname (ohne Endung, erster Buchstabe groß) als '# Titel' einfügen
                    if (isMarkdown) {
                        await applyCustomMarkdownFixes(document);
                        await delay(80);
                    }

                    // Schritt B2: Python – Identitätsvergleiche, die laut Analyzer immer True/False sind
                    // ("Identity comparison `False is True` is always False"): `x is True` -> `x`,
                    // `x is False` -> `not x`. Läuft bewusst nur einmal und VOR allen anderen Edits,
                    // da die Positionen der Diagnosen danach nicht mehr zum Text passen würden.
                    if (isPython) {
                        await applyPythonIdentityComparisonFixes(document);
                        await applyPythonTypecastFixes(document);
                        await delay(80);
                    }

                    // Schritt B3: Format-spezifische KI-Regeln anwenden (JSON, YAML, Shell, TOML, SVG/XML, SQL)
                    await applyCustomFormatFixes(document);
                    await delay(80);

                    // Schritt C: Mehrstufiger Auto-Fix-Durchlauf (bis zu 3 Runden),
                    // da manche Linter-Regeln erst nach dem ersten Fix neue Folge-Fixes freischalten.
                    const allCommands = await vscode.commands.getCommands(true);
                    const hasMarkdownlintFix = allCommands.includes('markdownlint.fixAll');
                    const hasEslintAutofix = allCommands.includes('eslint.executeAutofix');

                    for (let pass = 0; pass < 3; pass++) {
                        const textBeforePass = document.getText();

                        // 1. Standard VS Code Auto-Fix (ESLint, TypeScript, markdownlint via CodeAction, etc.)
                        await vscode.commands.executeCommand('editor.action.fixAll');

                        // 2. Spezieller Aufruf für die "markdownlint" Extension
                        if (isMarkdown && hasMarkdownlintFix) {
                            try {
                                await vscode.commands.executeCommand('markdownlint.fixAll');
                            } catch {
                                // Ignorieren, falls Aufruf fehlschlägt
                            }
                        }

                        // 3. Spezieller Aufruf für ESLint Autofix
                        if (hasEslintAutofix) {
                            try {
                                await vscode.commands.executeCommand('eslint.executeAutofix');
                            } catch {
                                // Ignorieren, falls Aufruf fehlschlägt
                            }
                        }

                        // 4. Unnötige Typecasts entfernen
                        await removeUnnecessaryTypecastsFromDocument(document);

                        // 5. Format-spezifische KI-Fixes erneut anwenden
                        await applyCustomFormatFixes(document);

                        // Kurz warten, damit Edits angewendet und neue Diagnostics berechnet werden
                        await delay(120);

                        if (isMarkdown) {
                            await applyCustomMarkdownFixes(document);
                        }

                        // Wenn sich in diesem Durchlauf nichts mehr geändert hat, sind wir fertig
                        if (document.getText() === textBeforePass) {
                            break;
                        }
                    }

                    // Schritt D: Prüfen, ob sich der Dateiinhalt insgesamt verändert hat
                    const newContent = document.getText();
                    if (newContent !== originalContent) {
                        currentBatchSnapshots.push({
                            uri: document.uri,
                            originalContent: originalContent
                        });
                        modifiedFilesCount++;
                    }

                    // Schritt E: Datei direkt abspeichern (falls sie Änderungen hat oder "dirty" war)
                    if (document.isDirty) {
                        await document.save();
                    }

                } catch (err) {
                    console.error(`Fehler beim Bearbeiten von ${uri.fsPath}:`, err);
                }
            }

            // Ursprünglich aktiven Editor wiederherstellen
            if (originallyActiveEditor && !originallyActiveEditor.document.isClosed) {
                try {
                    await vscode.window.showTextDocument(originallyActiveEditor.document, {
                        viewColumn: originallyActiveEditor.viewColumn,
                        preserveFocus: false
                    });
                } catch {
                    // Ignorieren, falls der Editor zwischenzeitlich geschlossen wurde
                }
            }
        }
    );

    // Wenn Dateien geändert wurden, Snapshot auf den Undo-Stack legen und Nutzer informieren
    if (currentBatchSnapshots.length > 0) {
        undoStack.push(currentBatchSnapshots);
        updateUndoUIState();

        const selection = await vscode.window.showInformationMessage(
            `Auto-Fix abgeschlossen: ${modifiedFilesCount} Datei(en) wurden korrigiert und gespeichert.`,
            'Rückgängig machen (Undo)'
        );

        if (selection === 'Rückgängig machen (Undo)') {
            await undoLastAutoFix();
        }
    } else {
        vscode.window.showInformationMessage(
            'Auto-Fix abgeschlossen: Es wurden keine automatisch behebbaren Probleme gefunden.'
        );
    }
}

/**
 * Stellt den exakten Dateizustand vor dem letzten Auto-Fix-Durchlauf wieder her
 * und speichert die Dateien erneut ab.
 */
async function undoLastAutoFix(): Promise<void> {
    const lastBatch = undoStack.pop();
    updateUndoUIState();

    if (!lastBatch || lastBatch.length === 0) {
        vscode.window.showInformationMessage('Es gibt keinen Auto-Fix Vorgang zum Rückgängigmachen.');
        return;
    }

    let restoredCount = 0;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Mache letzten Auto-Fix rückgängig...',
            cancellable: false
        },
        async () => {
            for (const snapshot of lastBatch) {
                try {
                    const document = await vscode.workspace.openTextDocument(snapshot.uri);
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );

                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(snapshot.uri, fullRange, snapshot.originalContent);

                    const applied = await vscode.workspace.applyEdit(edit);
                    if (applied) {
                        await document.save();
                        restoredCount++;
                    }
                } catch (err) {
                    console.error(`Fehler beim Wiederherstellen von ${snapshot.uri.fsPath}:`, err);
                }
            }
        }
    );

    vscode.window.showInformationMessage(
        `Rückgängig gemacht: ${restoredCount} Datei(en) wurden auf ihren vorherigen Zustand zurückgesetzt und gespeichert.`
    );
}

/**
 * Aktualisiert die Sichtbarkeit des Undo-Buttons in der Statusleiste und im Editor-Menü.
 */
function updateUndoUIState(): void {
    const canUndo = undoStack.length > 0;
    vscode.commands.executeCommand('setContext', 'autoFixAll.canUndo', canUndo);

    if (canUndo) {
        undoStatusBarItem.show();
    } else {
        undoStatusBarItem.hide();
    }
}

/**
 * Sammelt alle eindeutigen URIs von aktuell geöffneten Text-Tabs über alle Tab-Gruppen hinweg.
 */
function getAllOpenTextDocumentUris(): vscode.Uri[] {
    const uriMap = new Map<string, vscode.Uri>();

    // 1. Alle Tabs aus den TabGroups auslesen
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;
                if (uri.scheme === 'file' || uri.scheme === 'untitled') {
                    uriMap.set(uri.toString(), uri);
                }
            }
        }
    }

    // 2. Fallback: Aktuell geladene TextDocuments prüfen, falls nicht in TabGroups erfasst
    for (const doc of vscode.workspace.textDocuments) {
        if (!doc.isClosed && (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled')) {
            // Nur hinzufügen, wenn es kein internes git/output-Dokument ist
            if (!doc.fileName.startsWith('git:') && !doc.fileName.includes('extension-output')) {
                uriMap.set(doc.uri.toString(), doc.uri);
            }
        }
    }

    return Array.from(uriMap.values());
}

/**
 * Analysiert ein Markdown-Dokument und behebt spezielle KI/Agenten-Markdown-Fehler:
 * 1. MD040: Codeblöcke ohne Sprachkennzeichnung (`text` bei Bäumen, `bash` bei Konsolenbefehlen)
 * 2. MD036: Emphasis used instead of a heading (`## ` vor alleinstehende fett/kursiv Zeilen setzen)
 * 3. MD025: Multiple top-level headings in the same document (ab der 2. `# ` Überschrift ein `#` ergänzen -> `## `)
 * 4. Fehlende Top-Level-Überschrift: Dateiname (ohne Endung, 1. Buchstabe groß) als `# Titel` einfügen
 * 5. Text direkt unter einer Tabelle (ohne Leerzeile): Leerzeile einfügen (MD055/MD056/MD058)
 */
async function applyCustomMarkdownFixes(document: vscode.TextDocument): Promise<boolean> {
    const originalText = document.getText();
    const updatedText = processCustomMarkdownRules(originalText, getHeadingTitleFromUri(document.uri));

    if (updatedText === originalText) {
        return false;
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(originalText.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, updatedText);
    return await vscode.workspace.applyEdit(edit);
}

/**
 * Liest die aktuellen Diagnosen eines Python-Dokuments und behebt alle gemeldeten
 * "Identity comparison ... is always True/False"-Stellen. Es werden ausschließlich gemeldete
 * Stellen angefasst, da `x is True` bei Nicht-bool-Werten nicht gleichbedeutend mit `x` ist.
 */
async function applyPythonIdentityComparisonFixes(document: vscode.TextDocument): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('autoFixAll.python');
    if (!config.get<boolean>('fixIdentityComparisons', true)) {
        return false;
    }

    const targets: IdentityComparisonTarget[] = vscode.languages.getDiagnostics(document.uri)
        .filter(d => isIdentityComparisonDiagnostic(
            d.message,
            typeof d.code === 'object' && d.code !== null ? String(d.code.value) : String(d.code ?? '')
        ))
        .map(d => ({
            line: d.range.start.line,
            startChar: d.range.start.character,
            // Mehrzeilige Bereiche: bis zum Ende der Startzeile suchen
            endChar: d.range.end.line === d.range.start.line
                ? d.range.end.character
                : document.lineAt(d.range.start.line).text.length
        }));

    if (targets.length === 0) {
        return false;
    }

    const originalText = document.getText();
    const { text: updatedText } = fixIdentityComparisonsInText(originalText, targets, {
        splitAssertions: config.get<boolean>('splitAssertions', true)
    });

    if (updatedText === originalText) {
        return false;
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(originalText.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, updatedText);
    return await vscode.workspace.applyEdit(edit);
}

/**
 * Liest die aktuellen Diagnosen eines Python-Dokuments und entfernt unnötige Typecasts
 * und Typkonvertierungen (z.B. bool(), str(), int() oder typing.cast()), wenn der Analyzer meldet,
 * dass das Argument bereits den Zieltyp besitzt.
 */
async function applyPythonTypecastFixes(document: vscode.TextDocument): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('autoFixAll.python');
    if (!config.get<boolean>('removeUnnecessaryTypecasts', true)) {
        return false;
    }

    const targets: PythonTypecastTarget[] = vscode.languages.getDiagnostics(document.uri)
        .filter(isPythonTypecastDiagnostic)
        .map(d => ({
            line: d.range.start.line,
            startChar: d.range.start.character,
            endChar: d.range.end.line === d.range.start.line
                ? d.range.end.character
                : document.lineAt(d.range.start.line).text.length,
            message: d.message,
            code: typeof d.code === 'object' && d.code !== null ? String(d.code.value) : String(d.code ?? '')
        }));

    if (targets.length === 0) {
        return false;
    }

    const originalText = document.getText();
    const { text: updatedText, fixedCount } = fixPythonTypecastsInText(originalText, targets);

    if (fixedCount === 0 || updatedText === originalText) {
        return false;
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(originalText.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, updatedText);
    return await vscode.workspace.applyEdit(edit);
}

/**
 * Ermittelt aus dem Dateinamen einen Titel für eine fehlende Top-Level-Überschrift:
 * Dateiendung entfernen und den ersten Buchstaben großschreiben (z.B. "installation.md" -> "Installation").
 * Für ungespeicherte Dokumente (untitled) gibt es keinen sinnvollen Dateinamen -> undefined.
 */
function getHeadingTitleFromUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') {
        return undefined;
    }

    const baseName = uri.fsPath.split(/[\\/]/).pop() || '';
    const lastDot = baseName.lastIndexOf('.');
    const nameWithoutExtension = (lastDot > 0 ? baseName.substring(0, lastDot) : baseName).trim();

    if (nameWithoutExtension.length === 0) {
        return undefined;
    }

    return nameWithoutExtension.charAt(0).toLocaleUpperCase() + nameWithoutExtension.substring(1);
}

/**
 * Parst Zeilen eines Markdown-Texts und behebt MD040 (Codeblöcke), MD025 (Doppelte H1),
 * MD036 (Emphasis als Überschrift) sowie eine komplett fehlende Top-Level-Überschrift.
 *
 * @param headingTitle Titel, der als `# Titel` eingefügt wird, falls das Dokument keine H1 besitzt.
 *                     Ist er nicht gesetzt, wird keine Überschrift ergänzt.
 */
function processCustomMarkdownRules(markdownText: string, headingTitle?: string): string {
    const lines = markdownText.split(/\r?\n/);
    const lineBreak = markdownText.includes('\r\n') ? '\r\n' : '\n';

    let inCodeBlock = false;
    let currentFenceChar = '';
    let currentFenceLength = 0;
    let openingLineIndex = -1;
    let isUnlabeledBlock = false;
    let blockLines: string[] = [];

    let inYamlFrontMatter = false;
    let frontMatterEndIndex = -1;
    let seenTopLevelHeading = false;

    let inTable = false;
    // Zeilenindizes, vor denen nach dem Durchlauf eine Leerzeile eingefügt wird
    const insertBlankLineBefore: number[] = [];

    // Falls im YAML Front-Matter bereits ein "title:" definiert ist, zählt markdownlint (MD025)
    // diesen oft schon als erste H1-Überschrift.
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 0. YAML Front-Matter am Dateianfang überspringen (und auf title: prüfen)
        if (i === 0 && line.trim() === '---') {
            inYamlFrontMatter = true;
            continue;
        }
        if (inYamlFrontMatter) {
            if (/^title\s*:/i.test(line.trim())) {
                seenTopLevelHeading = true;
            }
            if (line.trim() === '---' || line.trim() === '...') {
                inYamlFrontMatter = false;
                frontMatterEndIndex = i;
            }
            continue;
        }

        // 5. Tabellen-Ende: Eine nicht-leere Zeile ohne '|' direkt unter einer Tabelle wird von
        // markdownlint als weitere Tabellenzeile mit nur einer Zelle gewertet (MD055 fehlende Pipes,
        // MD056 zu wenige Spalten). Eine Leerzeile davor beendet die Tabelle korrekt.
        if (!inCodeBlock) {
            if (inTable) {
                if (line.trim() === '') {
                    inTable = false;
                } else if (!containsTablePipe(line)) {
                    insertBlankLineBefore.push(i);
                    inTable = false;
                }
            } else if (containsTablePipe(line) && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1])) {
                inTable = true;
            }
        }

        // 1. Codeblock-Verarbeitung (MD040)
        if (!inCodeBlock) {
            const openMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
            if (openMatch) {
                inCodeBlock = true;
                currentFenceChar = openMatch[2][0];
                currentFenceLength = openMatch[2].length;
                const infoString = openMatch[3].trim();

                openingLineIndex = i;
                isUnlabeledBlock = infoString.length === 0;
                blockLines = [];
                continue;
            }
        } else {
            const closeRegex = new RegExp(`^\\s*${currentFenceChar}{${currentFenceLength},}\\s*$`);
            if (closeRegex.test(line)) {
                if (isUnlabeledBlock && openingLineIndex !== -1) {
                    const inferredLang = inferCodeBlockLanguage(blockLines);
                    lines[openingLineIndex] = lines[openingLineIndex].replace(
                        /^(\s*)(`{3,}|~{3,})\s*$/,
                        `$1$2${inferredLang}`
                    );
                }

                inCodeBlock = false;
                openingLineIndex = -1;
                isUnlabeledBlock = false;
                blockLines = [];
            } else if (isUnlabeledBlock) {
                blockLines.push(line);
            }
            continue;
        }

        // =====================================================================
        // Außerhalb von Codeblöcken: MD025 & MD036 prüfen
        // =====================================================================

        // 2. MD025: Doppelte Top-Level-Heading (# Überschrift)
        // Prüft auf Zeilen, die mit genau einem '#' gefolgt von Leerzeichen beginnen
        const h1Match = line.match(/^(\s*)#(\s+.*)$/);
        if (h1Match) {
            if (!seenTopLevelHeading) {
                seenTopLevelHeading = true;
            } else {
                // Zweite (oder weitere) Top-Level-Überschrift gefunden -> '#' direkt dahinter einfügen (wird zu '##')
                lines[i] = `${h1Match[1]}##${h1Match[2]}`;
            }
            continue;
        }

        // Setext-H1 (Textzeile, darunter "====") zählt ebenfalls als Top-Level-Überschrift
        if (/^\s*=+\s*$/.test(line) && i > 0 && lines[i - 1].trim() !== '' && i - 1 > frontMatterEndIndex) {
            seenTopLevelHeading = true;
            continue;
        }

        // 3. MD036: Emphasis used instead of a heading
        // markdownlint meldet MD036, wenn ein einzeiliger Absatz (umgeben von Leerzeilen bzw. Dokumentanfang/-ende)
        // komplett aus **Text**, __Text__, *Text* oder _Text_ besteht und NICHT auf Satzzeichen (., !, ?, :, ;) endet.
        const prevLineEmpty = (i === 0) || (lines[i - 1].trim() === '');
        const nextLineEmpty = (i === lines.length - 1) || (lines[i + 1].trim() === '');

        if (prevLineEmpty && nextLineEmpty) {
            const emphasisHeadingMatch = line.match(/^(\s*)(\*\*|__|\*|_)(?!\s)(.+?)(?<!\s)\2\s*$/);
            if (emphasisHeadingMatch) {
                const innerText = emphasisHeadingMatch[3].trim();
                const endsWithPunctuation = /[.,!?:;]$/.test(innerText);
                // Sicherstellen, dass im Inneren nicht das gleiche Emphasis-Zeichen geschlossen und neu geöffnet wurde
                const marker = emphasisHeadingMatch[2];
                const isSingleEmphasisSpan = !innerText.includes(marker);

                if (!endsWithPunctuation && isSingleEmphasisSpan) {
                    // Wie gewünscht einfach "## " vor die hervorgehobene Stelle packen
                    lines[i] = `${emphasisHeadingMatch[1]}## ${line.trim()}`;
                }
            }
        }
    }

    // 5. Gesammelte Leerzeilen von hinten nach vorne einfügen, damit die Indizes gültig bleiben
    for (let k = insertBlankLineBefore.length - 1; k >= 0; k--) {
        lines.splice(insertBlankLineBefore[k], 0, '');
    }

    // 4. Fehlende Top-Level-Überschrift: Dateiname als '# Titel' an den Anfang setzen
    // (bei vorhandenem YAML Front-Matter direkt dahinter), darunter genau eine Leerzeile.
    if (!seenTopLevelHeading && !inYamlFrontMatter && headingTitle) {
        const head = lines.slice(0, frontMatterEndIndex + 1);
        const rest = lines.slice(frontMatterEndIndex + 1);

        // Führende Leerzeilen entfernen, damit zwischen Überschrift und Inhalt genau eine Leerzeile steht
        while (rest.length > 0 && rest[0].trim() === '') {
            rest.shift();
        }

        // '# Titel', eine Leerzeile, dann der restliche Inhalt (bei leerer Datei: Titel + Zeilenumbruch)
        return [...head, `# ${headingTitle}`, '', ...rest].join(lineBreak);
    }

    return lines.join(lineBreak);
}

/**
 * Prüft, ob eine Zeile ein (nicht mit Backslash maskiertes) '|' enthält und damit als Tabellenzeile gilt.
 */
function containsTablePipe(line: string): boolean {
    return /(^|[^\\])\|/.test(line);
}

/**
 * Prüft, ob eine Zeile eine Tabellen-Trennzeile ist, z.B. "| --- | :---: |" oder "---|---".
 */
function isTableDelimiterRow(line: string): boolean {
    return containsTablePipe(line)
        && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

/**
 * Heuristik zur Erkennung des Codeblock-Typs für unmarkierte Markdown-Blöcke:
 * 1. Projektstruktur / Verzeichnisbaum -> 'text'
 * 2. Konsolenbefehle / Terminal-Anleitungen -> 'bash'
 * 3. Fallback für sonstige unmarkierte Blöcke (damit MD040 zuverlässig behoben wird) -> 'text'
 */
function inferCodeBlockLanguage(lines: string[]): string {
    const nonEmptyLines = lines.map(l => l.trim()).filter(l => l.length > 0);

    if (nonEmptyLines.length === 0) {
        return 'text';
    }

    const joinedContent = nonEmptyLines.join('\n');

    // =========================================================================
    // FALL 1: Projektstruktur / Baumdarstellung erkennen
    // =========================================================================
    // Typische Unicode-Baumzeichen: ├, └, │, ─
    const unicodeTreeRegex = /[├└│─╭╰]/;
    // Typische ASCII-Baumstrukturen am Zeilenanfang: |--, +-- Letztere oft verschachtelt mit |
    const asciiTreeRegex = /^(\s*[|+]?\s*(`--|\|--|\+--|---)\s+\S+)/m;

    if (unicodeTreeRegex.test(joinedContent) || asciiTreeRegex.test(joinedContent)) {
        return 'text';
    }

    // Eingebettete Ordner-Hierarchien erkennen (z.B. mehrere Zeilen enden auf "/" wie "src/", "components/")
    const folderLinesCount = nonEmptyLines.filter(l => /^[a-zA-Z0-9_.\-/\\]+\/$/.test(l)).length;
    if (folderLinesCount >= 2 || (nonEmptyLines.length > 1 && folderLinesCount / nonEmptyLines.length >= 0.4)) {
        return 'text';
    }

    // =========================================================================
    // FALL 2: Konsolenbefehle / Shell-Skripte erkennen
    // =========================================================================
    const shellCommandRegex = new RegExp(
        '^(' +
        // Typische Shell-Prompts ($, >, # bei Befehlen, PS C:\>)
        '(\\$|>|PS\\s+[A-Z]:.*>)\\s+\\S+|' +
        // Paketmanager & Build-Tools
        '(npm|npx|yarn|pnpm|bun|pip|pip3|poetry|conda|cargo|go|composer|mvn|gradle|dotnet)\\s+\\S+|' +
        // Git & Versionskontrolle
        '(git|gh)\\s+(clone|init|add|commit|push|pull|checkout|switch|branch|merge|rebase|status|log|diff|stash|tag|fetch|remote)\\b|' +
        // System- & Datei-Befehle (Unix / Windows / Cross-Platform)
        '(cd|ls|dir|mkdir|rm|rmdir|cp|mv|cat|echo|touch|chmod|chown|sudo|apt|apt-get|brew|winget|choco|pacman|yum|dnf)\\s+\\S+|' +
        // Netzwerk, Container & Ausführung
        '(curl|wget|ssh|scp|rsync|docker|docker-compose|kubectl|helm|terraform|ansible|make|cmake)\\s+\\S+|' +
        // Skript-Aufrufe & Umgebungsvariablen
        '(python|python3|node|ts-node|tsx|bash|sh|zsh|pwsh|powershell|export|set|source)\\s+\\S+|' +
        '(\\.\\/[a-zA-Z0-9_.-]+)' +
        ')'
    );

    let shellScore = 0;
    for (const line of nonEmptyLines) {
        // Ignoriere reine Kommentarzeilen in Shell-Skripten bei der negativen Wertung,
        // aber prüfe, ob echte Befehle vorliegen
        if (shellCommandRegex.test(line)) {
            shellScore++;
        }
    }

    // Wenn mindestens eine eindeutige Konsolenbefehlszeile gefunden wurde (und es kein normaler Fließtext ist)
    if (shellScore > 0) {
        return 'bash';
    }

    // =========================================================================
    // FALLBACK: Damit markdownlint (MD040) nicht mehr meckert, erhalten sonstige
    // unmarkierte Blöcke standardmäßig 'text'
    // =========================================================================
    return 'text';
}

/**
 * Hilfsfunktion für kurze asynchrone Pausen
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Standalone runner: Removes unnecessary typecasts across all open files,
 * records snapshots for undo, and saves modified documents.
 */
async function runRemoveUnnecessaryTypecastsOnAllOpenFiles(): Promise<void> {
    const targetUris = getAllOpenTextDocumentUris();

    if (targetUris.length === 0) {
        vscode.window.showInformationMessage('Keine geöffneten Textdateien zum Bereinigen gefunden.');
        return;
    }

    const currentBatchSnapshots: FileSnapshot[] = [];
    const originallyActiveEditor = vscode.window.activeTextEditor;
    let modifiedFilesCount = 0;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Entferne unnötige Typecasts in geöffneten Dateien...',
            cancellable: false
        },
        async (progress) => {
            const total = targetUris.length;

            for (let i = 0; i < total; i++) {
                const uri = targetUris[i];
                const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
                progress.report({
                    message: `Bearbeite ${fileName} (${i + 1}/${total})`,
                    increment: 100 / total
                });

                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    if (document.isClosed) {
                        continue;
                    }

                    const originalContent = document.getText();

                    await vscode.window.showTextDocument(document, {
                        preview: false,
                        preserveFocus: false
                    });

                    await delay(150);

                    await removeUnnecessaryTypecastsFromDocument(document);

                    const newContent = document.getText();
                    if (newContent !== originalContent) {
                        currentBatchSnapshots.push({
                            uri: document.uri,
                            originalContent
                        });
                        modifiedFilesCount++;
                    }

                    if (document.isDirty) {
                        await document.save();
                    }
                } catch (err) {
                    console.error(`Fehler beim Entfernen von Typecasts in ${uri.fsPath}:`, err);
                }
            }

            if (originallyActiveEditor && !originallyActiveEditor.document.isClosed) {
                try {
                    await vscode.window.showTextDocument(originallyActiveEditor.document, {
                        viewColumn: originallyActiveEditor.viewColumn,
                        preserveFocus: false
                    });
                } catch {
                    // Ignore if editor was closed in the meantime
                }
            }
        }
    );

    if (currentBatchSnapshots.length > 0) {
        undoStack.push(currentBatchSnapshots);
        updateUndoUIState();

        const selection = await vscode.window.showInformationMessage(
            `Typecast-Bereinigung abgeschlossen: ${modifiedFilesCount} Datei(en) wurden bereinigt und gespeichert.`,
            'Rückgängig machen (Undo)'
        );

        if (selection === 'Rückgängig machen (Undo)') {
            await undoLastAutoFix();
        }
    } else {
        vscode.window.showInformationMessage(
            'Typecast-Bereinigung abgeschlossen: Es wurden keine unnötigen Typecasts in den geöffneten Dateien gefunden.'
        );
    }
}

/**
 * Removes unnecessary typecasts from a document using:
 * 1. Diagnostics & CodeAction provider (multi-language: ESLint, TypeScript-ESLint, Biome, C# IDE0004, Java, Dart, etc.)
 * 2. Syntactic & AST rules for TypeScript and JavaScript files
 */
async function removeUnnecessaryTypecastsFromDocument(document: vscode.TextDocument): Promise<boolean> {
    let changed = false;

    // 1. Diagnostics & CodeAction-based removal
    const diagFixed = await fixTypecastDiagnostics(document);
    if (diagFixed) {
        changed = true;
        await delay(100);
    }

    // 2. Syntactic / AST cleanup for TypeScript and JavaScript files
    const isTsOrJs = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(document.languageId) ||
        /\.[cm]?[jt]sx?$/i.test(document.uri.fsPath);

    if (isTsOrJs) {
        const syntacticFixed = await applySyntacticTypecastFixes(document);
        if (syntacticFixed) {
            changed = true;
        }
    }

    // 3. Python unnecessary typecasts and type conversions (Pyrefly, Pylance, Ruff, etc.)
    const isPython = document.languageId === 'python' || /\.py$/i.test(document.uri.fsPath);
    if (isPython) {
        const idFixed = await applyPythonIdentityComparisonFixes(document);
        if (idFixed) {
            changed = true;
            await delay(80);
        }
        const pythonFixed = await applyPythonTypecastFixes(document);
        if (pythonFixed) {
            changed = true;
        }
    }

    return changed;
}

/**
 * Searches for diagnostics indicating unnecessary typecasts and applies corresponding CodeActions.
 */
async function fixTypecastDiagnostics(document: vscode.TextDocument): Promise<boolean> {
    let modified = false;

    for (let pass = 0; pass < 3; pass++) {
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        const typecastDiagnostics = diagnostics.filter(isUnnecessaryTypecastDiagnostic);

        if (typecastDiagnostics.length === 0) {
            break;
        }

        let passModified = false;

        // Try file-level "Fix all" CodeAction first
        const firstDiag = typecastDiagnostics[0];
        try {
            const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
                'vscode.executeCodeActionProvider',
                document.uri,
                firstDiag.range
            );

            if (actions && actions.length > 0) {
                const fixAllAction = actions.find(action => {
                    if (!action || !('title' in action)) {
                        return false;
                    }
                    const codeAction = action as vscode.CodeAction;
                    const isFixAllKind = codeAction.kind && (codeAction.kind.value === 'source.fixAll' || codeAction.kind.value.startsWith('source.fixAll.'));
                    return /fix\s+all.*(unnecessary|assertion|cast|conversion)/i.test(action.title) ||
                        Boolean(isFixAllKind) ||
                        (action.title.includes('Fix all') && action.title.includes('no-unnecessary-type-assertion'));
                });

                if (fixAllAction) {
                    if ('edit' in fixAllAction && fixAllAction.edit) {
                        const applied = await vscode.workspace.applyEdit(fixAllAction.edit);
                        if (applied) {
                            modified = true;
                            passModified = true;
                            await delay(100);
                            continue;
                        }
                    } else if ('command' in fixAllAction && fixAllAction.command) {
                        await executeActionCommand(fixAllAction.command);
                        modified = true;
                        passModified = true;
                        await delay(100);
                        continue;
                    }
                }
            }
        } catch {
            // Ignore failure, fall back to individual diagnostics
        }

        // Sort diagnostics descending (bottom to top) to prevent text shifts from affecting subsequent ranges
        const sortedDiagnostics = [...typecastDiagnostics].sort((a, b) => {
            if (b.range.start.line !== a.range.start.line) {
                return b.range.start.line - a.range.start.line;
            }
            return b.range.start.character - a.range.start.character;
        });

        for (const diag of sortedDiagnostics) {
            try {
                const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
                    'vscode.executeCodeActionProvider',
                    document.uri,
                    diag.range
                );

                if (!actions || actions.length === 0) {
                    continue;
                }

                const matchingAction = actions.find(action => {
                    if (!action || !('title' in action)) {
                        return false;
                    }
                    return isUnnecessaryTypecastCodeAction(action as vscode.CodeAction);
                });

                if (matchingAction) {
                    if ('edit' in matchingAction && matchingAction.edit) {
                        const applied = await vscode.workspace.applyEdit(matchingAction.edit);
                        if (applied) {
                            modified = true;
                            passModified = true;
                        }
                    } else if ('command' in matchingAction && matchingAction.command) {
                        await executeActionCommand(matchingAction.command);
                        modified = true;
                        passModified = true;
                    }
                }
            } catch (err) {
                console.error('Error applying diagnostic CodeAction:', err);
            }
        }

        if (!passModified) {
            break;
        }

        await delay(100);
    }

    return modified;
}

/**
 * Safely executes a command from a CodeAction, handling both string and vscode.Command object forms.
 */
async function executeActionCommand(command: string | vscode.Command): Promise<void> {
    if (typeof command === 'string') {
        await vscode.commands.executeCommand(command);
    } else if (command && typeof command.command === 'string') {
        await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
    }
}

/**
 * Determines whether a diagnostic represents an unnecessary typecast / type assertion.
 */
function isUnnecessaryTypecastDiagnostic(diag: vscode.Diagnostic): boolean {
    if (isPythonTypecastDiagnostic(diag)) {
        return true;
    }
    const codeStr = typeof diag.code === 'object' && diag.code !== null
        ? String(diag.code.value)
        : String(diag.code ?? '');

    const message = diag.message.toLowerCase();
    const lowerCode = codeStr.toLowerCase();

    // Check known rule names and codes across ecosystems
    const knownRules = [
        'no-unnecessary-type-assertion',
        'nounnecessarytypeassertion',
        'no-redundant-type-constituents',
        'unnecessary_cast',
        'unnecessary-cast',
        'ide0004', // Roslyn / C# redundant cast
        's1905',   // Sonar redundant cast
        's1940',
        '16777788' // Eclipse JDT redundant cast
    ];

    if (knownRules.some(rule => lowerCode.includes(rule))) {
        return true;
    }

    // Check diagnostic message keywords
    const hasUnnecessaryWord = message.includes('unnecessary') ||
        message.includes('redundant') ||
        message.includes('useless') ||
        message.includes('unnötig');

    const hasCastWord = message.includes('cast') ||
        message.includes('assertion') ||
        message.includes('typumwandlung');

    if (hasUnnecessaryWord && hasCastWord) {
        return true;
    }

    if (message.includes('cast is redundant') || message.includes('assertion is redundant')) {
        return true;
    }

    if (message.includes('is already of type') && message.includes('cast')) {
        return true;
    }

    return false;
}

/**
 * Determines whether a CodeAction represents removing an unnecessary typecast / assertion.
 */
function isUnnecessaryTypecastCodeAction(action: vscode.CodeAction): boolean {
    const title = action.title.toLowerCase();

    if (
        /remove\s+(this\s+)?(unnecessary|redundant|useless)?\s*(type\s*)?(assertion|cast)/i.test(title) ||
        /remove\s+type\s+assertion/i.test(title) ||
        /remove\s+cast\b/i.test(title) ||
        /remove\s+type\s+conversion/i.test(title) ||
        /remove\s+[`'"]?\w+\(\)[`'"]?(\s+call)?/i.test(title) ||
        /unwrap\s+/i.test(title) ||
        title.includes('unnecessary-type-conversion') ||
        title.includes('redundant-cast') ||
        /cast\s+is\s+redundant/i.test(title) ||
        title.includes('no-unnecessary-type-assertion') ||
        title.includes('nounnecessarytypeassertion') ||
        /unnötig.*(cast|typumwandlung|assertion)/i.test(title)
    ) {
        return true;
    }

    if (action.diagnostics && action.diagnostics.some(d => isUnnecessaryTypecastDiagnostic(d))) {
        if (/remove|fix|entfernen|löschen/i.test(title)) {
            return true;
        }
    }

    return false;
}

/**
 * Applies syntactic and AST-based typecast cleanups to a document.
 */
async function applySyntacticTypecastFixes(document: vscode.TextDocument): Promise<boolean> {
    const originalText = document.getText();
    const updatedText = cleanSyntacticTypecasts(originalText, document.uri);

    if (updatedText === originalText) {
        return false;
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(originalText.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, updatedText);
    return await vscode.workspace.applyEdit(edit);
}

/**
 * Cleans syntactic redundant typecasts via AST (if TypeScript is available) and regex fallback.
 */
function cleanSyntacticTypecasts(code: string, documentUri?: vscode.Uri): string {
    let result = code;
    const ts = getWorkspaceTypeScript(documentUri);

    if (ts) {
        try {
            result = cleanSyntacticTypecastsAst(ts, result);
        } catch (err) {
            console.error('Error during AST typecast cleanup:', err);
        }
    }

    // Always run regex cleaner to catch remaining duplicates or when AST is not available
    result = cleanSyntacticTypecastsRegex(result);
    return result;
}

/**
 * Dynamically resolves TypeScript compiler if available in workspace node_modules or environment.
 */
function getWorkspaceTypeScript(documentUri?: vscode.Uri): any | null {
    if (documentUri) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (workspaceFolder) {
            try {
                const tsPath = require.resolve('typescript', { paths: [workspaceFolder.uri.fsPath] });
                return require(tsPath);
            } catch {
                // Not found in workspace folder
            }
        }
    }
    try {
        return require('typescript');
    } catch {
        return null;
    }
}

/**
 * Cleans redundant typecasts using TypeScript's AST parser.
 */
function cleanSyntacticTypecastsAst(ts: any, code: string): string {
    const sf = ts.createSourceFile('temp.ts', code, ts.ScriptTarget.Latest, true);
    const edits: { start: number; end: number; replacement: string }[] = [];

    function visit(node: any) {
        // 1. Chained duplicate as-expression: (expr as T) as T or expr as T as T
        if (ts.isAsExpression(node)) {
            const outerType = node.type.getText(sf).trim();
            let inner = node.expression;
            while (ts.isParenthesizedExpression(inner)) {
                inner = inner.expression;
            }
            if (ts.isAsExpression(inner)) {
                const innerType = inner.type.getText(sf).trim();
                if (outerType === innerType) {
                    edits.push({ start: node.expression.end, end: node.end, replacement: '' });
                }
            }
        }

        // 2. Chained duplicate angle brackets: <T><T>expr
        if (ts.isTypeAssertionExpression(node)) {
            const outerType = node.type.getText(sf).trim();
            let inner = node.expression;
            while (ts.isParenthesizedExpression(inner)) {
                inner = inner.expression;
            }
            if (ts.isTypeAssertionExpression(inner)) {
                const innerType = inner.type.getText(sf).trim();
                if (outerType === innerType) {
                    edits.push({ start: node.getStart(sf), end: node.expression.getStart(sf), replacement: '' });
                }
            }
        }

        // 3. Duplicate non-null assertion: x!!
        if (ts.isNonNullExpression(node)) {
            if (ts.isNonNullExpression(node.expression)) {
                edits.push({ start: node.expression.end, end: node.end, replacement: '' });
            }
        }

        // 4. Explicitly typed variable with identical literal cast:
        // const x: string = "hello" as string; or const x: string = ("hello" as string);
        if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
            const declType = node.type.getText(sf).trim();
            let init = node.initializer;
            let hasParens = false;
            if (ts.isParenthesizedExpression(init)) {
                init = init.expression;
                hasParens = true;
            }
            if (ts.isAsExpression(init)) {
                const castType = init.type.getText(sf).trim();
                if (declType === castType) {
                    const expr = init.expression;
                    if (
                        ts.isStringLiteral(expr) ||
                        ts.isNumericLiteral(expr) ||
                        ts.isNoSubstitutionTemplateLiteral(expr) ||
                        expr.kind === ts.SyntaxKind.TrueKeyword ||
                        expr.kind === ts.SyntaxKind.FalseKeyword ||
                        expr.kind === ts.SyntaxKind.NullKeyword
                    ) {
                        if (hasParens) {
                            edits.push({
                                start: node.initializer.getStart(sf),
                                end: node.initializer.end,
                                replacement: expr.getText(sf)
                            });
                        } else {
                            edits.push({
                                start: expr.end,
                                end: init.end,
                                replacement: ''
                            });
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sf);

    if (edits.length === 0) {
        return code;
    }

    // Apply edits descending by offset
    edits.sort((a, b) => b.start - a.start);
    let result = code;
    for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }
    return result;
}

/**
 * Regex-based cleanup for duplicate or redundant typecasts.
 */
function cleanSyntacticTypecastsRegex(code: string): string {
    let result = code;

    // 1. Chained duplicate "as Type as Type"
    result = result.replace(/\bas\s+([A-Za-z0-9_$<>[\]|&.]+)\s+as\s+\1\b/g, 'as $1');

    // 2. Parenthesized duplicate "(x as Type) as Type"
    result = result.replace(/\(([^()]+)\s+as\s+([A-Za-z0-9_$<>[\]|&.]+)\)\s+as\s+\2\b/g, '($1 as $2)');

    // 3. Chained duplicate angle brackets "<Type><Type>expr"
    result = result.replace(/<([A-Za-z0-9_$]+)>\s*<\1>/g, '<$1>');

    // 4. Duplicate postfix non-null assertion: x!! -> x! (excluding prefix boolean negation !!x)
    result = result.replace(/([a-zA-Z0-9_$\])'"])\s*!!(?!=)/g, '$1!');

    // 5. Explicitly typed variable with identical primitive literal cast
    result = result.replace(/\b(const|let|var)\s+([a-zA-Z0-9_$]+)\s*:\s*string\s*=\s*(["'`][^"'`\r\n]*["'`])\s+as\s+string\b/g, '$1 $2: string = $3');
    result = result.replace(/\b(const|let|var)\s+([a-zA-Z0-9_$]+)\s*:\s*number\s*=\s*(-?\d+(?:\.\d+)?)\s+as\s+number\b/g, '$1 $2: number = $3');
    result = result.replace(/\b(const|let|var)\s+([a-zA-Z0-9_$]+)\s*:\s*boolean\s*=\s*(true|false)\s+as\s+boolean\b/g, '$1 $2: boolean = $3');

    return result;
}

export function deactivate() {
    if (fixStatusBarItem) {
        fixStatusBarItem.dispose();
    }
    if (undoStatusBarItem) {
        undoStatusBarItem.dispose();
    }
}