import * as vscode from 'vscode';

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

    // 1. Statusleisten-Button zum Beheben (direkt links neben der Fehler/Warnungs-Anzeige)
    // Die offizielle Problem-Anzeige von VS Code hat eine hohe Priorität auf der linken Seite.
    fixStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    fixStatusBarItem.command = 'auto-fix-all.fixAllOpen';
    fixStatusBarItem.text = '$(sparkle) Auto-Fix All';
    fixStatusBarItem.tooltip = 'Behebt alle automatisch lösbaren Probleme & Markdown-Codeblöcke in offenen Dateien und speichert diese.';
    fixStatusBarItem.show();

    // 2. Statusleisten-Button für Undo (wird nur angezeigt, wenn ein Backup existiert)
    undoStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    undoStatusBarItem.command = 'auto-fix-all.undoLastFix';
    undoStatusBarItem.text = '$(discard) Undo Auto-Fix';
    undoStatusBarItem.tooltip = 'Macht den letzten Auto-Fix Durchlauf über alle Dateien hinweg rückgängig.';
    undoStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // 3. Befehl: Alle Probleme beheben
    const fixAllDisposable = vscode.commands.registerCommand('auto-fix-all.fixAllOpen', async () => {
        await runAutoFixOnAllOpenFiles();
    });

    // 4. Befehl: Letzten Vorgang rückgängig machen
    const undoDisposable = vscode.commands.registerCommand('auto-fix-all.undoLastFix', async () => {
        await undoLastAutoFix();
    });

    context.subscriptions.push(
        fixStatusBarItem,
        undoStatusBarItem,
        fixAllDisposable,
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

                    // Schritt A: Spezielle Regel für Markdown-Dateien (Codeblöcke ohne Sprache -> MD040)
                    if (document.languageId === 'markdown' || uri.fsPath.toLowerCase().endsWith('.md')) {
                        await fixUnlabeledMarkdownCodeBlocks(document);
                    }

                    // Schritt B: Dokument kurz im Editor fokussieren, damit 'editor.action.fixAll'
                    // und 'markdownlint.fixAll' zuverlässig auf diesem Dokument arbeiten können.
                    await vscode.window.showTextDocument(document, {
                        preview: false,
                        preserveFocus: false
                    });

                    // Kleine Pause, damit Language Server & Linter (wie markdownlint) den Fokuswechsel registrieren
                    await delay(60);

                    // 1. Standard VS Code Auto-Fix für alle unterstützten Linter (ESLint, TypeScript, etc.)
                    await vscode.commands.executeCommand('editor.action.fixAll');

                    // 2. Spezieller Aufruf für die beliebte "markdownlint" Extension (falls installiert)
                    if (document.languageId === 'markdown' || uri.fsPath.toLowerCase().endsWith('.md')) {
                        try {
                            const allCommands = await vscode.commands.getCommands(true);
                            if (allCommands.includes('markdownlint.fixAll')) {
                                await vscode.commands.executeCommand('markdownlint.fixAll');
                            }
                        } catch {
                            // Ignorieren, falls markdownlint nicht installiert ist
                        }
                    }

                    // Schritt C: Prüfen, ob sich der Dateiinhalt verändert hat
                    const newContent = document.getText();
                    if (newContent !== originalContent) {
                        currentBatchSnapshots.push({
                            uri: document.uri,
                            originalContent: originalContent
                        });
                        modifiedFilesCount++;
                    }

                    // Schritt D: Datei direkt abspeichern (falls sie Änderungen hat oder "dirty" war)
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
 * Analysiert ein Markdown-Dokument auf Codeblöcke ohne Sprachkennzeichnung (MD040)
 * und ergänzt automatisch die passende Sprache (`text` bei Baumstrukturen, `bash` bei Konsolenbefehlen).
 */
async function fixUnlabeledMarkdownCodeBlocks(document: vscode.TextDocument): Promise<boolean> {
    const originalText = document.getText();
    const updatedText = processMarkdownCodeBlocks(originalText);

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
 * Parst Zeilen eines Markdown-Texts und versieht unmarkierte Fenced Code Blocks (``` oder ~~~)
 * anhand ihres Inhalts mit der passenden Sprach-ID.
 */
function processMarkdownCodeBlocks(markdownText: string): string {
    const lines = markdownText.split(/\r?\n/);
    const lineBreak = markdownText.includes('\r\n') ? '\r\n' : '\n';

    let inCodeBlock = false;
    let currentFenceChar = '';
    let currentFenceLength = 0;
    let openingLineIndex = -1;
    let isUnlabeledBlock = false;
    let blockLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inCodeBlock) {
            // Prüfe auf öffnenden Codeblock: optionales Einrücken, gefolgt von mindestens 3 ` oder ~
            const openMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
            if (openMatch) {
                inCodeBlock = true;
                currentFenceChar = openMatch[2][0];
                currentFenceLength = openMatch[2].length;
                const infoString = openMatch[3].trim();

                openingLineIndex = i;
                isUnlabeledBlock = infoString.length === 0;
                blockLines = [];
            }
        } else {
            // Prüfe auf schließenden Codeblock (gleiches Zeichen, mindestens gleiche Länge)
            const closeRegex = new RegExp(`^\\s*${currentFenceChar}{${currentFenceLength},}\\s*$`);
            if (closeRegex.test(line)) {
                if (isUnlabeledBlock && openingLineIndex !== -1) {
                    const inferredLang = inferCodeBlockLanguage(blockLines);
                    // Öffnende Zeile mit der erkannten Sprache aktualisieren (z. B. ``` -> ```bash)
                    lines[openingLineIndex] = lines[openingLineIndex].replace(
                        /^(\s*)(`{3,}|~{3,})\s*$/,
                        `$1$2${inferredLang}`
                    );
                }

                // Reset für den nächsten Block
                inCodeBlock = false;
                openingLineIndex = -1;
                isUnlabeledBlock = false;
                blockLines = [];
            } else {
                if (isUnlabeledBlock) {
                    blockLines.push(line);
                }
            }
        }
    }

    return lines.join(lineBreak);
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

export function deactivate() {
    if (fixStatusBarItem) {
        fixStatusBarItem.dispose();
    }
    if (undoStatusBarItem) {
        undoStatusBarItem.dispose();
    }
}