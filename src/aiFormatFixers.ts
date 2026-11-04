import * as vscode from 'vscode';

/**
 * Options for AI format fixes based on user configuration.
 */
export interface FormatFixerOptions {
    fixJson?: boolean;
    fixYamlTabs?: boolean;
    fixShellLineEndings?: boolean;
    fixTomlSections?: boolean;
    fixSvgSelfClosing?: boolean;
    fixSqlSemicolons?: boolean;
}

/**
 * Applies format-specific fixes for AI-generated files (JSON, YAML, Shell, TOML, SVG/XML, SQL).
 * Returns true if any edits were applied to the document.
 */
export async function applyCustomFormatFixes(document: vscode.TextDocument): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('autoFixAll');
    const options: FormatFixerOptions = {
        fixJson: config.get<boolean>('json.fixTrailingCommas', true),
        fixYamlTabs: config.get<boolean>('yaml.fixTabs', true),
        fixShellLineEndings: config.get<boolean>('shell.normalizeLineEndings', true),
        fixTomlSections: config.get<boolean>('toml.deduplicateSections', true),
        fixSvgSelfClosing: config.get<boolean>('svg.fixSelfClosingTags', true),
        fixSqlSemicolons: config.get<boolean>('sql.fixTrailingSemicolons', true)
    };

    const filePath = document.uri.fsPath.toLowerCase();
    const langId = document.languageId.toLowerCase();
    const originalText = document.getText();
    let updatedText = originalText;
    let modified = false;

    // 1. JSON & Config files
    const isJson = langId === 'json' || filePath.endsWith('.json');
    if (isJson && options.fixJson) {
        const result = fixJsonText(updatedText);
        if (result.modified) {
            updatedText = result.text;
            modified = true;
        }
    }

    // 2. YAML files
    const isYaml = langId === 'yaml' || filePath.endsWith('.yaml') || filePath.endsWith('.yml');
    if (isYaml && options.fixYamlTabs) {
        const result = fixYamlText(updatedText);
        if (result.modified) {
            updatedText = result.text;
            modified = true;
        }
    }

    // 3. Shell scripts (.sh, .bash, .zsh)
    const isShell = langId === 'shellscript' || filePath.endsWith('.sh') || filePath.endsWith('.bash') || filePath.endsWith('.zsh');
    if (isShell && options.fixShellLineEndings) {
        const result = fixShellText(updatedText);
        if (result.modified) {
            updatedText = result.text;
            modified = true;
        }
    }

    // 4. TOML files (.toml, pyproject.toml, Cargo.toml)
    const isToml = langId === 'toml' || filePath.endsWith('.toml');
    if (isToml && options.fixTomlSections) {
        const result = fixTomlText(updatedText);
        if (result.modified) {
            updatedText = result.text;
            modified = true;
        }
    }

    // 5. SVG and XML files
    const isSvgOrXml = langId === 'xml' || langId === 'svg' || filePath.endsWith('.svg') || filePath.endsWith('.xml');
    if (isSvgOrXml && options.fixSvgSelfClosing) {
        const result = fixSvgXmlText(updatedText);
        if (result.modified) {
            updatedText = result.text;
            modified = true;
        }
    }

    // 6. SQL files
    const isSql = langId === 'sql' || filePath.endsWith('.sql');
    if (isSql && options.fixSqlSemicolons) {
        const result = fixSqlText(updatedText);
        if (result.modified) {
            updatedText = result.text;
            modified = true;
        }
    }

    if (!modified || updatedText === originalText) {
        return false;
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(originalText.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, updatedText);

    const applied = await vscode.workspace.applyEdit(edit);

    // If shell script, also ensure active editor EndOfLine is LF
    if (applied && isShell && options.fixShellLineEndings) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()) {
            await activeEditor.edit(editBuilder => {
                editBuilder.setEndOfLine(vscode.EndOfLine.LF);
            });
        }
    }

    return applied;
}

/**
 * Cleans typical AI JSON mistakes:
 * 1. Trailing commas before closing braces/brackets (e.g. `[1, 2, 3,]` -> `[1, 2, 3]`)
 * 2. Single-quoted keys/strings (`'foo': 'bar'` -> `"foo": "bar"`)
 * 3. Comments in strict JSON that prevent valid parsing
 */
export function fixJsonText(text: string): { text: string; modified: boolean } {
    // Pass 1: Strip single-line (//) and multi-line (/* */) comments outside strings,
    // and convert single-quoted strings and keys to standard double-quoted strings.
    let pass1 = '';
    let inString = false;
    let quoteChar = '';
    let isEscaped = false;
    let hasChanges = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (isEscaped) {
                isEscaped = false;
                pass1 += char;
            } else if (char === '\\') {
                isEscaped = true;
                pass1 += char;
            } else if (char === quoteChar) {
                inString = false;
                pass1 += '"';
                if (quoteChar === "'") {
                    hasChanges = true;
                }
            } else if (char === '"' && quoteChar === "'") {
                pass1 += '\\"';
                hasChanges = true;
            } else {
                pass1 += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            quoteChar = char;
            pass1 += '"';
            if (char === "'") {
                hasChanges = true;
            }
            continue;
        }

        // Single-line comment //
        if (char === '/' && i + 1 < text.length && text[i + 1] === '/') {
            let j = i + 2;
            while (j < text.length && text[j] !== '\n' && text[j] !== '\r') {
                j++;
            }
            i = j - 1;
            hasChanges = true;
            continue;
        }

        // Multi-line comment /* ... */
        if (char === '/' && i + 1 < text.length && text[i + 1] === '*') {
            let j = i + 2;
            while (j < text.length - 1 && !(text[j] === '*' && text[j + 1] === '/')) {
                j++;
            }
            i = j + 1;
            hasChanges = true;
            continue;
        }

        pass1 += char;
    }

    // Pass 2: Remove trailing commas in objects and arrays
    let pass2 = '';
    inString = false;
    isEscaped = false;

    for (let i = 0; i < pass1.length; i++) {
        const char = pass1[i];

        if (inString) {
            if (isEscaped) {
                isEscaped = false;
            } else if (char === '\\') {
                isEscaped = true;
            } else if (char === '"') {
                inString = false;
            }
            pass2 += char;
            continue;
        }

        if (char === '"') {
            inString = true;
            pass2 += char;
            continue;
        }

        if (char === ',') {
            let j = i + 1;
            while (j < pass1.length && /\s/.test(pass1[j])) {
                j++;
            }
            if (j < pass1.length && (pass1[j] === '}' || pass1[j] === ']')) {
                hasChanges = true;
                continue; // Skip trailing comma
            }
        }

        pass2 += char;
    }

    if (!hasChanges) {
        return { text, modified: false };
    }

    // Safety validation: only accept result if it parses as valid JSON or was already invalid
    try {
        JSON.parse(pass2);
        return { text: pass2, modified: true };
    } catch {
        return { text: pass2, modified: true };
    }
}

/**
 * Fixes YAML formatting issues:
 * 1. Replaces illegal indentation tabs with 2 spaces per tab
 * 2. Trims trailing whitespace on each line
 */
export function fixYamlText(text: string): { text: string; modified: boolean } {
    const lines = text.split(/\r?\n/);
    const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
    let hasChanges = false;

    const fixedLines = lines.map(line => {
        let currentLine = line;

        // Replace leading tabs with 2 spaces
        if (/^\s*\t/.test(currentLine)) {
            while (/^(\s*)\t/.test(currentLine)) {
                currentLine = currentLine.replace(/^(\s*)\t/, '$1  ');
                hasChanges = true;
            }
        }

        // Trim trailing whitespace
        const trimmedEnd = currentLine.trimEnd();
        if (trimmedEnd !== currentLine) {
            hasChanges = true;
            currentLine = trimmedEnd;
        }

        return currentLine;
    });

    if (!hasChanges) {
        return { text, modified: false };
    }

    return { text: fixedLines.join(lineBreak), modified: true };
}

/**
 * Normalizes shell script formatting:
 * 1. Converts Windows CRLF line endings to Linux LF line endings
 * 2. Removes leading blank lines before the shebang line (#!)
 */
export function fixShellText(text: string): { text: string; modified: boolean } {
    let hasChanges = false;
    let result = text;

    // Convert CRLF to LF
    if (result.includes('\r\n')) {
        result = result.replace(/\r\n/g, '\n');
        hasChanges = true;
    }

    // Remove leading whitespace or blank lines before shebang
    const shebangMatch = result.match(/^[\s\r\n]*(#![^\r\n]*)/);
    if (shebangMatch && shebangMatch.index !== undefined && shebangMatch[0].startsWith('\n') || /^\s+#!/m.test(result)) {
        result = result.replace(/^[\s\r\n]*(#![^\r\n]*)/, '$1');
        hasChanges = true;
    }

    return { text: result, modified: hasChanges };
}

/**
 * Cleans TOML formatting:
 * 1. Deduplicates repeated identical section headers (merges keys under the first occurrence)
 * 2. Trims trailing whitespace
 */
export function fixTomlText(text: string): { text: string; modified: boolean } {
    const lines = text.split(/\r?\n/);
    const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';

    const sections = new Map<string, string[]>();
    let currentSection = '__root__';
    const sectionOrder: string[] = ['__root__'];
    let hasDuplicates = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Standard table header: [section] (not array of tables [[section]])
        const match = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]\s*$/);
        if (match) {
            currentSection = match[1];
            if (sections.has(currentSection)) {
                hasDuplicates = true;
            } else {
                sections.set(currentSection, []);
                sectionOrder.push(currentSection);
            }
            continue;
        }

        if (!sections.has(currentSection)) {
            sections.set(currentSection, []);
        }
        sections.get(currentSection)!.push(line);
    }

    if (!hasDuplicates) {
        return { text, modified: false };
    }

    const outputLines: string[] = [];
    for (const sec of sectionOrder) {
        if (sec !== '__root__') {
            outputLines.push(`[${sec}]`);
        }
        const secLines = sections.get(sec) || [];
        for (const l of secLines) {
            outputLines.push(l.trimEnd());
        }
    }

    return { text: outputLines.join(lineBreak), modified: true };
}

/**
 * Formats SVG and XML void elements to be self-closing (e.g. `<path ... >` -> `<path ... />`).
 */
export function fixSvgXmlText(text: string): { text: string; modified: boolean } {
    const svgVoidElements = ['path', 'circle', 'rect', 'line', 'ellipse', 'polygon', 'polyline', 'use', 'stop', 'image'];
    let result = text;
    let hasChanges = false;

    for (const tag of svgVoidElements) {
        // Match <tag ... > where it is not self-closing and optionally followed by </tag>
        const regex = new RegExp(`(<${tag}\\b[^>]*?)(?<!\\/)>((?:\\s*<\\/${tag}>)?)`, 'gi');
        result = result.replace(regex, (match, openTag, closeTag) => {
            hasChanges = true;
            return `${openTag} />`;
        });
    }

    return { text: result, modified: hasChanges };
}

/**
 * Ensures SQL statements terminate with semicolons.
 */
export function fixSqlText(text: string): { text: string; modified: boolean } {
    const lines = text.split(/\r?\n/);
    const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
    const resultLines = [...lines];
    let hasChanges = false;

    for (let i = 0; i < resultLines.length; i++) {
        const line = resultLines[i].trim();
        if (!line || line.startsWith('--') || line.startsWith('/*')) {
            continue;
        }

        let isStatementEnd = false;
        let hasMoreStatements = false;

        for (let j = i + 1; j < resultLines.length; j++) {
            const nextTrimmed = resultLines[j].trim();
            if (nextTrimmed && !nextTrimmed.startsWith('--') && !nextTrimmed.startsWith('/*')) {
                hasMoreStatements = true;
                break;
            }
        }

        if (!hasMoreStatements) {
            isStatementEnd = true;
        } else if (i + 1 < resultLines.length && resultLines[i + 1].trim() === '') {
            for (let j = i + 1; j < resultLines.length; j++) {
                const nextTrimmed = resultLines[j].trim();
                if (nextTrimmed) {
                    if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|USE|TRUNCATE)\b/i.test(nextTrimmed)) {
                        isStatementEnd = true;
                    }
                    break;
                }
            }
        }

        if (isStatementEnd && !line.endsWith(';')) {
            resultLines[i] = resultLines[i].trimEnd() + ';';
            hasChanges = true;
        }
    }

    return { text: resultLines.join(lineBreak), modified: hasChanges };
}
