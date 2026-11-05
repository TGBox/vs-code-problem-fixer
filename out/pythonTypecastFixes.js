"use strict";
/**
 * Automatische Behebung von unnötigen Typecasts und Typkonvertierungen in Python, z.B.:
 *
 *   Unnecessary `bool()` call; argument is already of type `bool` (Pyrefly)
 *   Unnecessary `str()` call; argument is already of type `str` (Pyrefly)
 *   Unnecessary `int()` call; argument is already of type `int` (Pyrefly)
 *   Redundant cast: expression is already of type ... (Pyrefly / Pylance / Mypy)
 *
 * Wenn ein Ausdruck bereits den passenden Typ besitzt, ist die explizite Konvertierung
 * bzw. der Cast redundant:
 *
 *   bool(user.is_admin)    ->  user.is_admin
 *   str(name)              ->  name
 *   int(count)             ->  count
 *   (int(x), int(y))       ->  (x, y)
 *   cast(int, user_id)     ->  user_id
 *   typing.cast(str, val)  ->  val
 *   bool(a and b)          ->  (a and b)   (Klammern bleiben erhalten, um Rangfolgen zu schützen)
 *
 * Dieses Modul ist bewusst unabhängig von der VS-Code-API (reine Textverarbeitung),
 * damit es isoliert getestet werden kann.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPythonTypecastDiagnostic = isPythonTypecastDiagnostic;
exports.extractCandidateFunctionNames = extractCandidateFunctionNames;
exports.findMatchingParen = findMatchingParen;
exports.hasTopLevelOperators = hasTopLevelOperators;
exports.isSimplePrimaryExpression = isSimplePrimaryExpression;
exports.extractCastSecondArgument = extractCastSecondArgument;
exports.getUnwrappedPythonExpression = getUnwrappedPythonExpression;
exports.findCallAtOrNear = findCallAtOrNear;
exports.fixPythonTypecastsInText = fixPythonTypecastsInText;
exports.cleanSyntacticPythonTypecasts = cleanSyntacticPythonTypecasts;
/**
 * Erkennt Diagnose-Meldungen, die unnötige Typecasts oder Typkonvertierungen in Python beschreiben.
 */
function isPythonTypecastDiagnostic(diag) {
    const codeStr = typeof diag.code === 'object' && diag.code !== null
        ? String(diag.code.value)
        : String(diag.code ?? '');
    const lowerCode = codeStr.toLowerCase();
    const message = diag.message.toLowerCase();
    // 1. Bekannte Linter- und Analyzer-Codes (z. B. Pyrefly, Ruff, Sonar)
    const knownCodes = [
        'unnecessary-type-conversion',
        'unnecessary_type_conversion',
        'redundant-cast',
        'redundant_cast',
        'unnecessary-cast',
        'unnecessary_cast',
        'redundant-type-conversion',
        'redundant_type_conversion'
    ];
    if (knownCodes.some(c => lowerCode.includes(c))) {
        return true;
    }
    // 2. Pyrefly & andere Analyzer-Meldungsmuster:
    // z. B. "Unnecessary `bool()` call; argument is already of type `bool`"
    if (/unnecessary\s+[`'"]?\w+\(\)[`'"]?\s+call/i.test(diag.message)) {
        return true;
    }
    if (/redundant\s+[`'"]?\w+\(\)[`'"]?\s+call/i.test(diag.message)) {
        return true;
    }
    if (/call\s+to\s+[`'"]?\w+\(\)?[`'"]?\s+is\s+unnecessary/i.test(diag.message)) {
        return true;
    }
    if (/redundant\s+cast\b/i.test(diag.message)) {
        return true;
    }
    if (message.includes('argument is already of type') || message.includes('expression is already of type')) {
        return true;
    }
    if (message.includes('is already of type') && (message.includes('call') || message.includes('conversion') || message.includes('cast'))) {
        return true;
    }
    return false;
}
/**
 * Extrahiert die Ziel-Funktionsnamen (z. B. "bool", "str", "int", "cast") aus der Meldung.
 */
function extractCandidateFunctionNames(message, code) {
    const results = [];
    // "Unnecessary 'bool()' call; argument is already of type 'bool'"
    // "Unnecessary `str()` call; argument is already of type `str`"
    const callMatch = message.match(/[`'"]?(\w+)\(\)[`'"]?\s+call/i);
    if (callMatch) {
        results.push(callMatch[1]);
    }
    // "call to 'bool()' is unnecessary"
    const callToMatch = message.match(/call\s+to\s+[`'"]?(\w+)\(\)?[`'"]?\s+is\s+unnecessary/i);
    if (callToMatch) {
        results.push(callToMatch[1]);
    }
    // Redundant cast
    if (/redundant\s+cast/i.test(message) || (code && /redundant[-_]cast/i.test(code))) {
        results.push('cast', 'typing.cast');
    }
    // "argument is already of type 'bool'"
    const typeMatch = message.match(/already\s+of\s+type\s+[`'"]?(\w+)[`'"]?/i);
    if (typeMatch && !results.includes(typeMatch[1])) {
        results.push(typeMatch[1]);
    }
    // Fallback: Gängige Builtin-Konvertierungen und Casts in Python
    const defaults = ['bool', 'str', 'int', 'float', 'bytes', 'list', 'dict', 'set', 'tuple', 'cast', 'typing.cast'];
    for (const d of defaults) {
        if (!results.includes(d)) {
            results.push(d);
        }
    }
    return results;
}
/**
 * Findet die passende schließende Klammer unter Berücksichtigung von Python-Strings,
 * Kommentaren und verschachtelten Klammern.
 */
function findMatchingParen(text, openIndex) {
    let depth = 1;
    let i = openIndex + 1;
    const len = text.length;
    while (i < len && depth > 0) {
        const ch = text[i];
        // Python String-Literale überspringen
        if (ch === '"' || ch === "'") {
            const isTriple = (i + 2 < len && text[i + 1] === ch && text[i + 2] === ch);
            const quoteStr = isTriple ? ch + ch + ch : ch;
            i += quoteStr.length;
            while (i < len) {
                if (text[i] === '\\') {
                    i += 2; // Entwertetes Zeichen überspringen
                    continue;
                }
                if (text.startsWith(quoteStr, i)) {
                    i += quoteStr.length;
                    break;
                }
                i++;
            }
            continue;
        }
        // Kommentare bis zum Zeilenende überspringen
        if (ch === '#') {
            while (i < len && text[i] !== '\n' && text[i] !== '\r') {
                i++;
            }
            continue;
        }
        // Klammern zählen
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        }
        else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
        i++;
    }
    return -1;
}
/**
 * Prüft, ob ein Ausdruck auf oberster Ebene (depth === 0) Operatoren enthält.
 */
function hasTopLevelOperators(text) {
    let depth = 0;
    let i = 0;
    const len = text.length;
    while (i < len) {
        const ch = text[i];
        // Strings überspringen
        if (ch === '"' || ch === "'") {
            const isTriple = (i + 2 < len && text[i + 1] === ch && text[i + 2] === ch);
            const quoteStr = isTriple ? ch + ch + ch : ch;
            i += quoteStr.length;
            while (i < len) {
                if (text[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (text.startsWith(quoteStr, i)) {
                    i += quoteStr.length;
                    break;
                }
                i++;
            }
            continue;
        }
        // Kommentare überspringen
        if (ch === '#') {
            while (i < len && text[i] !== '\n' && text[i] !== '\r') {
                i++;
            }
            continue;
        }
        // Verschachtelungen zählen
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            i++;
            continue;
        }
        // Nur Operatoren auf Top-Level (depth === 0) prüfen
        if (depth === 0) {
            const rest = text.slice(i);
            // Schlüsselwort-Operatoren: and, or, not, is, in, if, else, lambda
            if (i === 0 || /[\s)\]}]/.test(text[i - 1])) {
                const keywordMatch = rest.match(/^(and|or|not|is|in|if|else|lambda)\b/);
                if (keywordMatch) {
                    return true;
                }
            }
            // Führendes Vorzeichen bei Zahlen überspringen (z. B. -5)
            if (i === 0 && (ch === '-' || ch === '+')) {
                if (/^[+-]\d/.test(rest)) {
                    i++;
                    continue;
                }
            }
            // Symbolische Operatoren: ==, !=, <=, >=, <<, >>, **, //, +, -, *, /, %, @, &, |, ^, ~, <, >
            if (/^(==|!=|<=|>=|<<|>>|\*\*|\/\/|[+\-*\/%@&|^~<>])/.test(rest)) {
                return true;
            }
        }
        i++;
    }
    return false;
}
/**
 * Prüft, ob ein Ausdruck ein primärer Ausdruck ist (Atom, Bezeichner, Attributkette,
 * Methodenaufruf, Indexierung oder bereits vollständig eingeklammert).
 */
function isSimplePrimaryExpression(expr) {
    const trimmed = expr.trim();
    if (!trimmed) {
        return false;
    }
    // 1. Bereits vollständig in passenden Klammern (...), [...], {...}
    const firstChar = trimmed[0];
    const lastChar = trimmed[trimmed.length - 1];
    if ((firstChar === '(' && lastChar === ')') ||
        (firstChar === '[' && lastChar === ']') ||
        (firstChar === '{' && lastChar === '}')) {
        if (findMatchingParen(trimmed, 0) === trimmed.length - 1) {
            return true;
        }
    }
    // 2. Literale: Zahlen, True, False, None, Strings
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        return true;
    }
    if (/^(True|False|None)$/.test(trimmed)) {
        return true;
    }
    if (/^[rfbRFB]*('''[\s\S]*'''|"""[\s\S]*"""|'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*")$/.test(trimmed)) {
        return true;
    }
    // 3. Wenn keine Top-Level-Operatoren vorliegen (nur Bezeichner, Attributzugriffe foo.bar, Aufrufe foo(), Indexe foo[x])
    return !hasTopLevelOperators(trimmed);
}
/**
 * Extrahiert bei `cast(Type, val)` das 2. Argument `val`.
 */
function extractCastSecondArgument(innerText) {
    let depth = 0;
    let i = 0;
    const len = innerText.length;
    while (i < len) {
        const ch = innerText[i];
        if (ch === '"' || ch === "'") {
            const isTriple = (i + 2 < len && innerText[i + 1] === ch && innerText[i + 2] === ch);
            const quoteStr = isTriple ? ch + ch + ch : ch;
            i += quoteStr.length;
            while (i < len) {
                if (innerText[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (innerText.startsWith(quoteStr, i)) {
                    i += quoteStr.length;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        }
        else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
        }
        else if (ch === ',' && depth === 0) {
            return innerText.slice(i + 1).trim();
        }
        i++;
    }
    return null;
}
/**
 * Berechnet den entpackten Ersatz-Ausdruck für `funcName(...)`.
 */
function getUnwrappedPythonExpression(funcName, innerText) {
    let rawArg = innerText.trim();
    const fnLower = funcName.toLowerCase();
    if (fnLower === 'cast' || fnLower === 'typing.cast') {
        const secondArg = extractCastSecondArgument(innerText);
        if (secondArg !== null) {
            rawArg = secondArg;
        }
    }
    if (!rawArg) {
        return rawArg;
    }
    if (isSimplePrimaryExpression(rawArg)) {
        return rawArg;
    }
    // Bei zusammengesetzten Operatoren sicher in Klammern halten
    if (rawArg.startsWith('(') && rawArg.endsWith(')') && findMatchingParen(rawArg, 0) === rawArg.length - 1) {
        return rawArg;
    }
    return `(${rawArg})`;
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Sucht an oder in der Nähe von `targetOffset` nach einem Aufruf einer der `candidateFuncs`.
 */
function findCallAtOrNear(text, targetOffset, candidateFuncs) {
    // 1. Exakte Prüfung direkt ab targetOffset
    for (const fn of candidateFuncs) {
        const regex = new RegExp(`^${escapeRegex(fn)}\\s*\\(`, 'i');
        const slice = text.slice(targetOffset);
        if (regex.test(slice)) {
            // Sicherstellen, dass kein Methodenaufruf vorliegt (z. B. obj.bool(x)),
            // außer wenn fn typing.cast ist
            if (targetOffset > 0 && text[targetOffset - 1] === '.' && fn !== 'typing.cast') {
                continue;
            }
            const openParen = targetOffset + slice.indexOf('(');
            const closeParen = findMatchingParen(text, openParen);
            if (closeParen !== -1) {
                return { callStart: targetOffset, openParen, closeParen, funcName: fn };
            }
        }
    }
    // 2. Umkreissuche auf derselben Zeile (z. B. wenn Col auf die öffnende Klammer oder den Parameter zeigt)
    const lineStart = Math.max(0, text.lastIndexOf('\n', targetOffset) + 1);
    const lineEnd = text.indexOf('\n', targetOffset);
    const effectiveLineEnd = lineEnd === -1 ? text.length : lineEnd;
    const searchStart = Math.max(lineStart, targetOffset - 60);
    const searchEnd = Math.min(effectiveLineEnd, targetOffset + 60);
    const searchWindow = text.slice(searchStart, searchEnd);
    let bestMatch = null;
    let minDistance = Number.POSITIVE_INFINITY;
    for (const fn of candidateFuncs) {
        const pattern = new RegExp(`\\b${escapeRegex(fn)}\\s*\\(`, 'gi');
        let match;
        while ((match = pattern.exec(searchWindow)) !== null) {
            const callStart = searchStart + match.index;
            if (callStart > 0 && text[callStart - 1] === '.' && fn !== 'typing.cast') {
                continue;
            }
            const openParen = searchStart + match.index + match[0].lastIndexOf('(');
            const closeParen = findMatchingParen(text, openParen);
            if (closeParen !== -1) {
                let dist = 0;
                if (targetOffset < callStart) {
                    dist = callStart - targetOffset;
                }
                else if (targetOffset > closeParen) {
                    dist = targetOffset - closeParen;
                }
                else {
                    dist = 0; // targetOffset liegt direkt im Aufruf
                }
                if (dist < minDistance) {
                    minDistance = dist;
                    bestMatch = { callStart, openParen, closeParen, funcName: fn };
                }
            }
        }
    }
    if (bestMatch && minDistance <= 15) {
        return bestMatch;
    }
    return null;
}
/**
 * Berechnet die Start-Offsets aller Zeilen im Text.
 */
function getLineOffsets(text) {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            offsets.push(i + 1);
        }
    }
    return offsets;
}
/**
 * Wendet die Typecast-Entfernungen auf den Python-Code an.
 */
function fixPythonTypecastsInText(text, targets) {
    const lineOffsets = getLineOffsets(text);
    const replacements = [];
    for (const t of targets) {
        if (t.line < 0 || t.line >= lineOffsets.length) {
            continue;
        }
        const targetOffset = lineOffsets[t.line] + Math.max(0, t.startChar);
        const candidateFuncs = extractCandidateFunctionNames(t.message || '', t.code);
        const callLoc = findCallAtOrNear(text, targetOffset, candidateFuncs);
        if (!callLoc) {
            continue;
        }
        const innerText = text.slice(callLoc.openParen + 1, callLoc.closeParen);
        const unwrapped = getUnwrappedPythonExpression(callLoc.funcName, innerText);
        replacements.push({
            start: callLoc.callStart,
            end: callLoc.closeParen + 1,
            text: unwrapped
        });
    }
    // Von rechts nach links (absteigend nach Offset) ersetzen, um Indexverschiebungen zu verhindern
    replacements.sort((a, b) => {
        if (b.start !== a.start) {
            return b.start - a.start;
        }
        return b.end - a.end;
    });
    let result = text;
    let lastStart = Number.POSITIVE_INFINITY;
    let fixedCount = 0;
    for (const r of replacements) {
        // Überlappende Ersetzungen ignorieren
        if (r.end > lastStart) {
            continue;
        }
        result = result.slice(0, r.start) + r.text + result.slice(r.end);
        lastStart = r.start;
        fixedCount++;
    }
    // Zusätzlich syntaktische redundante Literal-Konvertierungen bereinigen
    const cleanedResult = cleanSyntacticPythonTypecasts(result);
    if (cleanedResult !== result) {
        result = cleanedResult;
        fixedCount++;
    }
    return { text: result, fixedCount };
}
/**
 * Bereinigt rein syntaktisch offensichtliche redundante Builtin-Literal-Casts.
 */
function cleanSyntacticPythonTypecasts(code) {
    let result = code;
    // 1. bool(True) -> True, bool(False) -> False
    result = result.replace(/\bbool\s*\(\s*(True|False)\s*\)/g, '$1');
    // 2. int(123) -> 123
    result = result.replace(/\bint\s*\(\s*(-?\d+)\s*\)/g, '$1');
    // 3. float(1.23) -> 1.23
    result = result.replace(/\bfloat\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g, '$1');
    // 4. str("string") -> "string"
    result = result.replace(/\bstr\s*\(\s*(['"][^'"\r\n]*['"])\s*\)/g, '$1');
    return result;
}
//# sourceMappingURL=pythonTypecastFixes.js.map