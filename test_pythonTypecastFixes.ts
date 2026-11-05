import * as assert from 'assert';
import {
    isPythonTypecastDiagnostic,
    extractCandidateFunctionNames,
    fixPythonTypecastsInText,
    isSimplePrimaryExpression,
    hasTopLevelOperators,
    PythonTypecastTarget
} from './src/pythonTypecastFixes';

console.log('Testing pythonTypecastFixes...');

// Test 1: Diagnostic recognition
assert.strictEqual(
    isPythonTypecastDiagnostic({
        message: "Unnecessary `bool()` call; argument is already of type `bool`",
        code: "unnecessary-type-conversion"
    }),
    true,
    'Should recognize Pyrefly bool() diagnostic'
);

assert.strictEqual(
    isPythonTypecastDiagnostic({
        message: "Unnecessary 'str()' call; argument is already of type 'str'",
        code: "unnecessary-type-conversion"
    }),
    true,
    'Should recognize Pyrefly str() diagnostic'
);

assert.strictEqual(
    isPythonTypecastDiagnostic({
        message: "Unnecessary `int()` call; argument is already of type `int`",
        code: "unnecessary-type-conversion"
    }),
    true,
    'Should recognize Pyrefly int() diagnostic'
);

assert.strictEqual(
    isPythonTypecastDiagnostic({
        message: "Redundant cast: expression is already of type 'int'",
        code: "redundant-cast"
    }),
    true,
    'Should recognize redundant-cast diagnostic'
);

// Test 2: Function name extraction
assert.deepStrictEqual(
    extractCandidateFunctionNames("Unnecessary `bool()` call; argument is already of type `bool`")[0],
    'bool'
);
assert.deepStrictEqual(
    extractCandidateFunctionNames("Unnecessary 'str()' call; argument is already of type 'str'")[0],
    'str'
);
assert.deepStrictEqual(
    extractCandidateFunctionNames("Unnecessary `int()` call; argument is already of type `int`")[0],
    'int'
);

// Test 3: isSimplePrimaryExpression & hasTopLevelOperators
assert.strictEqual(isSimplePrimaryExpression('user.is_admin'), true);
assert.strictEqual(isSimplePrimaryExpression('x'), true);
assert.strictEqual(isSimplePrimaryExpression('self.get_count()'), true);
assert.strictEqual(isSimplePrimaryExpression('data["key"]'), true);
assert.strictEqual(isSimplePrimaryExpression('"hello world"'), true);
assert.strictEqual(isSimplePrimaryExpression('(a and b)'), true);
assert.strictEqual(isSimplePrimaryExpression('a and b'), false);
assert.strictEqual(isSimplePrimaryExpression('a == b'), false);
assert.strictEqual(hasTopLevelOperators('a and b'), true);
assert.strictEqual(hasTopLevelOperators('user.is_admin'), false);
assert.strictEqual(hasTopLevelOperators('format_val(a + b)'), false); // + is inside parens

// Test 4: Line 124 & 125 bool() removal
const code1 = [
    'def check_user(user):',
    '    is_admin = bool(user.is_admin)',
    '    is_active = bool(user.is_active)',
    '    return is_admin and is_active'
].join('\n');

const targets1: PythonTypecastTarget[] = [
    { line: 1, startChar: 15, endChar: 34, message: "Unnecessary `bool()` call; argument is already of type `bool`" },
    { line: 2, startChar: 16, endChar: 35, message: "Unnecessary `bool()` call; argument is already of type `bool`" }
];

const res1 = fixPythonTypecastsInText(code1, targets1);
assert.strictEqual(res1.fixedCount, 2);
assert.strictEqual(
    res1.text,
    [
        'def check_user(user):',
        '    is_admin = user.is_admin',
        '    is_active = user.is_active',
        '    return is_admin and is_active'
    ].join('\n')
);

// Test 5: Multiple calls on same line (Line 506: int(x), int(y))
const code2 = '            return (int(a), int(b))\n';
const targets2: PythonTypecastTarget[] = [
    { line: 0, startChar: 20, endChar: 26, message: "Unnecessary `int()` call; argument is already of type `int`" },
    { line: 0, startChar: 28, endChar: 34, message: "Unnecessary `int()` call; argument is already of type `int`" }
];

const res2 = fixPythonTypecastsInText(code2, targets2);
assert.strictEqual(res2.fixedCount, 2);
assert.strictEqual(res2.text, '            return (a, b)\n');

// Test 6: str() on line 460
const code3 = '    name = str(data["user_name"])\n';
const targets3: PythonTypecastTarget[] = [
    { line: 0, startChar: 11, endChar: 34, message: "Unnecessary 'str()' call; argument is already of type 'str'" }
];

const res3 = fixPythonTypecastsInText(code3, targets3);
assert.strictEqual(res3.fixedCount, 1);
assert.strictEqual(res3.text, '    name = data["user_name"]\n');

// Test 7: cast and typing.cast
const code4 = [
    'from typing import cast',
    'x = cast(int, some_num)',
    'y = typing.cast(str, some_str)'
].join('\n');
const targets4: PythonTypecastTarget[] = [
    { line: 1, startChar: 4, endChar: 23, message: "Redundant cast" },
    { line: 2, startChar: 4, endChar: 30, message: "Redundant cast" }
];
const res4 = fixPythonTypecastsInText(code4, targets4);
assert.strictEqual(res4.fixedCount, 2);
assert.strictEqual(
    res4.text,
    [
        'from typing import cast',
        'x = some_num',
        'y = some_str'
    ].join('\n')
);

// Test 8: Complex expressions keeping parentheses
const code5 = 'flag = bool(a and b)\n';
const targets5: PythonTypecastTarget[] = [
    { line: 0, startChar: 7, endChar: 20, message: "Unnecessary `bool()` call" }
];
const res5 = fixPythonTypecastsInText(code5, targets5);
assert.strictEqual(res5.fixedCount, 1);
assert.strictEqual(res5.text, 'flag = (a and b)\n');

console.log('All tests passed successfully!');

