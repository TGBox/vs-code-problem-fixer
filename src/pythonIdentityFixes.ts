/**
 * Automatische Behebung von "fehlerhaft konfigurierten" Identitätsvergleichen in Python, z.B.:
 *
 *   Identity comparison `True is True` is always True
 *   Identity comparison `False is True` is always False
 *
 * Solche Meldungen entstehen, wenn ein Analyzer für einen Ausdruck bereits den Literaltyp
 * `Literal[True]` / `Literal[False]` kennt und dieser dann mit `is True` / `is False` verglichen wird.
 * Nach PEP 8 werden boolesche Werte direkt über ihren Wahrheitswert geprüft:
 *
 *   x is True       ->  x
 *   x is False      ->  not x
 *   x is not True   ->  not x
 *   x is not False  ->  x
 *   (dasselbe für `True is x` usw.)
 *
 * Optional werden betroffene `assert a and b`-Zeilen in einzelne `assert`-Zeilen aufgeteilt,
 * damit pytest bei einem Fehlschlag den konkreten Teilausdruck anzeigt.
 *
 * Dieses Modul ist bewusst unabhängig von der VS-Code-API (reine Textverarbeitung),
 * damit es isoliert getestet werden kann.
 */

/** Eine von einem Analyzer gemeldete Stelle (0-basiert, einzeilig). */
export interface IdentityComparisonTarget {
    line: number;
    startChar: number;
    endChar: number;
}

export interface IdentityFixOptions {
    /** Zusammengesetzte `assert a and b`-Zeilen in einzelne Asserts aufteilen. */
    splitAssertions: boolean;
}

/**
 * Erkennt Diagnose-Meldungen der Form "Identity comparison `X is Y` is always True/False".
 * Bewusst über den Meldungstext statt über die Quelle (Pylance, SonarLint, ...), damit es
 * unabhängig vom meldenden Werkzeug funktioniert.
 */
export function isIdentityComparisonDiagnostic(message: string, code?: string): boolean {
    const lowerCode = (code ?? '').toLowerCase();
    if (lowerCode === 'unnecessary-comparison' || lowerCode === 'unnecessary_comparison') {
        return true;
    }
    return (/identity comparison/i.test(message) || /comparison/i.test(message)) &&
        /\bis always (true|false)\b/i.test(message);
}

const IDENT_CHAR = /[A-Za-z0-9_]/;
const OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const CLOSING: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Schlüsselwörter, die nie Teil eines (primären) Operanden sind. */
const KEYWORDS = new Set([
    'and', 'or', 'not', 'is', 'in', 'if', 'else', 'elif', 'while', 'for', 'return', 'assert',
    'yield', 'lambda', 'await', 'async', 'del', 'pass', 'raise', 'import', 'from', 'as', 'with',
    'True', 'False', 'None'
]);

/** Was links vom ersetzten Ausdruck stehen darf, ohne dass sich die Bedeutung ändert. */
const ALLOWED_PRECEDING_WORDS = new Set(['assert', 'if', 'elif', 'while', 'return', 'and', 'or', 'not', 'yield', 'else']);
/** Was rechts vom ersetzten Ausdruck stehen darf. */
const ALLOWED_FOLLOWING_WORDS = new Set(['and', 'or', 'if', 'else', 'for']);

/**
 * Wendet die Korrekturen auf den gesamten Text an. Es werden nur Vergleiche angefasst,
 * die innerhalb einer gemeldeten Stelle liegen – nicht pauschal jedes `is True` in der Datei,
 * denn bei Nicht-bool-Werten (z.B. `1`, `[]`) ist `x is True` nicht gleichbedeutend mit `x`.
 */
export function fixIdentityComparisonsInText(
    text: string,
    targets: IdentityComparisonTarget[],
    options: IdentityFixOptions
): { text: string; fixedCount: number } {
    const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);

    // Ziele pro Zeile gruppieren
    const targetsByLine = new Map<number, IdentityComparisonTarget[]>();
    for (const t of targets) {
        if (t.line < 0 || t.line >= lines.length) {
            continue;
        }
        const list = targetsByLine.get(t.line) ?? [];
        list.push(t);
        targetsByLine.set(t.line, list);
    }

    let fixedCount = 0;
    const touchedLines: number[] = [];

    for (const [lineIndex, lineTargets] of targetsByLine) {
        const result = fixLine(lines[lineIndex], lineTargets);
        if (result.fixedCount > 0) {
            lines[lineIndex] = result.line;
            fixedCount += result.fixedCount;
            touchedLines.push(lineIndex);
        }
    }

    // Asserts aufteilen – von unten nach oben, damit die Zeilenindizes gültig bleiben
    if (options.splitAssertions) {
        touchedLines.sort((a, b) => b - a);
        for (const lineIndex of touchedLines) {
            const split = splitAssertLine(lines[lineIndex]);
            if (split) {
                lines.splice(lineIndex, 1, ...split);
            }
        }
    }

    return { text: lines.join(lineBreak), fixedCount };
}

interface Replacement {
    start: number;
    end: number;
    text: string;
}

/** Behebt alle gemeldeten Vergleiche innerhalb einer Zeile. */
function fixLine(line: string, targets: IdentityComparisonTarget[]): { line: string; fixedCount: number } {
    const stringMask = buildStringMask(line);
    const candidates = new Map<number, Replacement>();

    for (const target of targets) {
        // Leerer/ungültiger Bereich -> ganze Zeile durchsuchen
        let from = Math.max(0, Math.min(target.startChar, line.length));
        let to = Math.max(0, Math.min(target.endChar, line.length));
        if (to <= from) {
            from = 0;
            to = line.length;
        }

        for (const replacement of findComparisonsInSpan(line, from, to, stringMask)) {
            candidates.set(replacement.start, replacement);
        }
    }

    // Überlappungen verwerfen und von rechts nach links ersetzen
    const sorted = [...candidates.values()].sort((a, b) => b.start - a.start);
    let result = line;
    let lastStart = Number.POSITIVE_INFINITY;
    let fixedCount = 0;
    for (const r of sorted) {
        if (r.end > lastStart) {
            continue;
        }
        result = result.slice(0, r.start) + r.text + result.slice(r.end);
        lastStart = r.start;
        fixedCount++;
    }

    return { line: result, fixedCount };
}

/**
 * Sucht in [from, to) nach `<operand> is [not] True|False` bzw. `True|False is [not] <operand>`
 * und liefert die nötigen Ersetzungen.
 */
function findComparisonsInSpan(line: string, from: number, to: number, stringMask: boolean[]): Replacement[] {
    const results: Replacement[] = [];
    const isRegex = /\bis(\s+not)?\b/g;
    let match: RegExpExecArray | null;

    while ((match = isRegex.exec(line)) !== null) {
        const isStart = match.index;
        const isEnd = isStart + match[0].length;
        if (stringMask[isStart]) {
            continue;
        }
        const negated = match[1] !== undefined;

        // Variante 1: <operand> is [not] True|False
        const rightLiteral = line.slice(isEnd).match(/^\s+(True|False)\b/);
        const lhsEnd = trimEndIndex(line, isStart);
        const lhsStart = scanOperandBackward(line, lhsEnd);

        // Variante 2: True|False is [not] <operand>
        const leftLiteral = line.slice(0, isStart).match(/\b(True|False)\s+$/);

        let exprStart: number;
        let exprEnd: number;
        let operand: string;
        let literal: string;

        if (rightLiteral && lhsStart !== undefined && lhsStart < lhsEnd) {
            operand = line.slice(lhsStart, lhsEnd);
            literal = rightLiteral[1];
            exprStart = lhsStart;
            exprEnd = isEnd + rightLiteral[0].length;
        } else if (leftLiteral) {
            const rhsStart = isEnd + (line.slice(isEnd).length - line.slice(isEnd).trimStart().length);
            const rhsEnd = scanOperandForward(line, rhsStart);
            if (rhsEnd === undefined || rhsEnd <= rhsStart) {
                continue;
            }
            operand = line.slice(rhsStart, rhsEnd);
            literal = leftLiteral[1];
            exprStart = isStart - leftLiteral[0].length;
            exprEnd = rhsEnd;
        } else {
            continue;
        }

        // Der gefundene Vergleich [exprStart, exprEnd] muss den gemeldeten Bereich [from, to] abdecken oder überlappen
        const overlaps = Math.max(from, exprStart) <= Math.min(to, exprEnd);
        const near = Math.abs(from - exprStart) <= 5 || Math.abs(to - exprEnd) <= 5;
        if (!overlaps && !near) {
            continue;
        }
        // das ist kein Muster, das sich sinnvoll automatisch umschreiben lässt.
        if (operand === 'True' || operand === 'False' || KEYWORDS.has(operand)) {
            continue;
        }

        if (!isSafeContext(line, exprStart, exprEnd)) {
            continue;
        }

        // `is True` / `is not False` -> Wahrheitswert direkt; sonst negieren
        const keepsTruthiness = (literal === 'True') !== negated;
        let replacement = keepsTruthiness ? operand : `not ${operand}`;
        let start = exprStart;

        // `not x is False` würde zu `not not x` -> beide `not` kürzen sich weg
        const precedingNot = line.slice(0, exprStart).match(/\bnot\s+$/);
        if (precedingNot && !keepsTruthiness) {
            replacement = operand;
            start = exprStart - precedingNot[0].length;
        }

        results.push({ start, end: exprEnd, text: replacement });
    }

    return results;
}

/**
 * Prüft, ob der Vergleich in einem Kontext steht, in dem `x` bzw. `not x` ohne zusätzliche
 * Klammern eingesetzt werden kann (keine Vergleichsketten, keine arithmetischen Operatoren ...).
 */
function isSafeContext(line: string, start: number, end: number): boolean {
    const before = line.slice(0, start).trimEnd();
    const after = line.slice(end).trimStart();

    let beforeOk = before.length === 0 || /[([{,:]$/.test(before) || /(^|[^=!<>])=$/.test(before);
    if (!beforeOk) {
        const word = before.match(/([A-Za-z_]+)$/);
        beforeOk = !!word && ALLOWED_PRECEDING_WORDS.has(word[1]);
    }

    let afterOk = after.length === 0 || /^[)\]},:#;]/.test(after);
    if (!afterOk) {
        const word = after.match(/^([A-Za-z_]+)\b/);
        afterOk = !!word && ALLOWED_FOLLOWING_WORDS.has(word[1]);
    }

    return beforeOk && afterOk;
}

/**
 * Liest von `end` (exklusiv) rückwärts einen "primären" Ausdruck ein:
 * Namen, Attributzugriffe, Aufrufe, Subskripte, Klammerausdrücke und String-/Zahlliterale,
 * z.B. `profile.checkout_settings.is_docked` oder `app._state["visible"]`.
 */
function scanOperandBackward(line: string, end: number): number | undefined {
    let pos = end;
    let consumedSomething = false;

    while (pos > 0) {
        const c = line[pos - 1];

        if (c in OPENING) {
            const open = findMatchingBackward(line, pos - 1);
            if (open === undefined) {
                return undefined;
            }
            pos = open;
            consumedSomething = true;
            // Davor ein Name oder `.` -> Aufruf/Subskript, weiter einlesen; sonst Klammerausdruck fertig
            if (pos > 0 && (IDENT_CHAR.test(line[pos - 1]) || line[pos - 1] === ')' || line[pos - 1] === ']')) {
                continue;
            }
            break;
        }

        if (c === '"' || c === "'") {
            const open = line.lastIndexOf(c, pos - 2);
            if (open < 0) {
                return undefined;
            }
            pos = open;
            while (pos > 0 && /[rRbBfFuU]/.test(line[pos - 1])) {
                pos--;
            }
            consumedSomething = true;
            break;
        }

        if (IDENT_CHAR.test(c)) {
            let wordStart = pos;
            while (wordStart > 0 && IDENT_CHAR.test(line[wordStart - 1])) {
                wordStart--;
            }
            const word = line.slice(wordStart, pos);
            // Ein Schlüsselwort (assert, and, not, ...) gehört nicht zum Operanden
            if (KEYWORDS.has(word)) {
                if (!consumedSomething) {
                    return undefined;
                }
                break;
            }
            pos = wordStart;
            consumedSomething = true;
            if (pos > 0 && line[pos - 1] === '.') {
                pos--;
                continue;
            }
            break;
        }

        break;
    }

    return consumedSomething ? pos : undefined;
}

/** Gegenstück zu scanOperandBackward für `True is <operand>`. */
function scanOperandForward(line: string, start: number): number | undefined {
    let pos = start;
    let consumedSomething = false;

    while (pos < line.length) {
        const c = line[pos];

        if (c in CLOSING) {
            if (consumedSomething && c === '{') {
                break;
            }
            const close = findMatchingForward(line, pos);
            if (close === undefined) {
                return undefined;
            }
            pos = close + 1;
            consumedSomething = true;
            continue;
        }

        if (!consumedSomething && (c === '"' || c === "'")) {
            const close = line.indexOf(c, pos + 1);
            if (close < 0) {
                return undefined;
            }
            return close + 1;
        }

        if (c === '.' && consumedSomething && pos + 1 < line.length && IDENT_CHAR.test(line[pos + 1])) {
            pos++;
            continue;
        }

        if (IDENT_CHAR.test(c) && (!consumedSomething || line[pos - 1] === '.')) {
            let wordEnd = pos;
            while (wordEnd < line.length && IDENT_CHAR.test(line[wordEnd])) {
                wordEnd++;
            }
            const word = line.slice(pos, wordEnd);
            if (!consumedSomething && KEYWORDS.has(word)) {
                return undefined;
            }
            pos = wordEnd;
            consumedSomething = true;
            continue;
        }

        break;
    }

    return consumedSomething ? pos : undefined;
}

function findMatchingBackward(line: string, closeIndex: number): number | undefined {
    let depth = 0;
    for (let i = closeIndex; i >= 0; i--) {
        const c = line[i];
        if (c === ')' || c === ']' || c === '}') {
            depth++;
        } else if (c === '(' || c === '[' || c === '{') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return undefined;
}

function findMatchingForward(line: string, openIndex: number): number | undefined {
    let depth = 0;
    for (let i = openIndex; i < line.length; i++) {
        const c = line[i];
        if (c === '(' || c === '[' || c === '{') {
            depth++;
        } else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return undefined;
}

function trimEndIndex(line: string, end: number): number {
    let i = end;
    while (i > 0 && /\s/.test(line[i - 1])) {
        i--;
    }
    return i;
}

/** Markiert alle Zeichen, die innerhalb eines String-Literals liegen (vereinfacht, einzeilig). */
function buildStringMask(line: string): boolean[] {
    const mask = new Array<boolean>(line.length).fill(false);
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            mask[i] = true;
            if (c === '\\') {
                mask[i + 1] = true;
                i++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (c === '"' || c === "'") {
            quote = c;
            mask[i] = true;
        } else if (c === '#') {
            // Rest der Zeile ist ein Kommentar
            for (let j = i; j < line.length; j++) {
                mask[j] = true;
            }
            break;
        }
    }
    return mask;
}

/**
 * Teilt `assert a and b and c` in einzelne Assert-Zeilen auf. Nur für einfache, einzeilige Fälle:
 * keine Assert-Meldung (`, "msg"`), kein `or`, kein bedingter Ausdruck, kein Lambda,
 * keine Fortsetzung in die nächste Zeile. Ein Zeilenkommentar bleibt an der letzten Zeile.
 */
export function splitAssertLine(line: string): string[] | undefined {
    const match = line.match(/^(\s*)assert\s+(.*)$/);
    if (!match) {
        return undefined;
    }
    const indent = match[1];
    let body = match[2];

    // Kommentar abtrennen
    let comment = '';
    const hashIndex = findCommentStart(body);
    if (hashIndex >= 0) {
        comment = body.slice(hashIndex);
        body = body.slice(0, hashIndex);
    }
    body = body.trimEnd();

    if (body.endsWith('\\') || body.includes(';')) {
        return undefined;
    }

    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let partStart = 0;

    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            continue;
        }
        if (c in CLOSING) {
            depth++;
            continue;
        }
        if (c in OPENING) {
            depth--;
            if (depth < 0) {
                return undefined;
            }
            continue;
        }
        if (depth !== 0) {
            continue;
        }
        if (c === ',' || (c === ':' && body[i + 1] === '=')) {
            return undefined;
        }
        if (IDENT_CHAR.test(c) && (i === 0 || !IDENT_CHAR.test(body[i - 1]))) {
            const word = body.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? '';
            if (word === 'or' || word === 'if' || word === 'else' || word === 'lambda') {
                return undefined;
            }
            if (word === 'and') {
                parts.push(body.slice(partStart, i).trim());
                partStart = i + word.length;
            }
            i += Math.max(word.length - 1, 0);
        }
    }

    if (quote || depth !== 0) {
        return undefined; // Mehrzeiliger Ausdruck -> nicht anfassen
    }

    parts.push(body.slice(partStart).trim());
    if (parts.length < 2 || parts.some(p => p.length === 0)) {
        return undefined;
    }

    return parts.map((p, idx) =>
        `${indent}assert ${p}` + (idx === parts.length - 1 && comment ? `  ${comment}` : '')
    );
}

/** Index eines `#`, das außerhalb von String-Literalen steht (Kommentarbeginn), sonst -1. */
function findCommentStart(text: string): number {
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === '#') {
            return i;
        }
    }
    return -1;
}
