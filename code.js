(function CONSOLELOG_WRAPPER() {
    const originalLog = console.log;
    const VERBOSE = Symbol('VERBOSE');

    window.VERBOSE = VERBOSE;

    const sourceCache = new Map();

    function getSource(url) {
        if (sourceCache.has(url)) {
            return sourceCache.get(url);
        }

        try {
            const xhr = new XMLHttpRequest();

            xhr.open('GET', url, false);
            xhr.send(null);

            if (xhr.status >= 200 && xhr.status < 400) {
                sourceCache.set(url, xhr.responseText);
                return xhr.responseText;
            }
        } catch {
            // Fall through to normal console.log behavior.
        }

        return null;
    }

    function getStackLocation(stack) {
        if (!stack) return null;

        const lines = stack.split('\n');

        for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();

            let match = line.match(
                /^at\s+(.*?)\s+\((.*):(\d+):(\d+)\)$/
            );

            if (match) {
                return {
                    functionName: match[1],
                    url: match[2],
                    line: Number(match[3]),
                    column: Number(match[4])
                };
            }

            match = line.match(
                /^at\s+(.*):(\d+):(\d+)$/
            );

            if (match) {
                return {
                    functionName: null,
                    url: match[1],
                    line: Number(match[2]),
                    column: Number(match[3])
                };
            }
        }

        return null;
    }

    function getFileName(url) {
        try {
            const pathname = new URL(url, location.href).pathname;

            let name = pathname.substring(
                pathname.lastIndexOf('/') + 1
            );

            return name.replace(/\.[^.]+$/, '') || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function stripStringsAndComments(source) {
        let result = '';
        let state = 'normal';

        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            const n = source[i + 1];

            if (state === 'normal') {
                if (c === '/' && n === '/') {
                    result += '  ';
                    i++;
                    state = 'lineComment';
                    continue;
                }

                if (c === '/' && n === '*') {
                    result += '  ';
                    i++;
                    state = 'blockComment';
                    continue;
                }

                if (c === '"') {
                    result += ' ';
                    state = 'doubleQuote';
                    continue;
                }

                if (c === "'") {
                    result += ' ';
                    state = 'singleQuote';
                    continue;
                }

                if (c === '`') {
                    result += ' ';
                    state = 'template';
                    continue;
                }

                result += c;
                continue;
            }

            if (state === 'lineComment') {
                if (c === '\n') {
                    result += '\n';
                    state = 'normal';
                } else {
                    result += ' ';
                }

                continue;
            }

            if (state === 'blockComment') {
                if (c === '*' && n === '/') {
                    result += '  ';
                    i++;
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }

                continue;
            }

            if (state === 'doubleQuote') {
                if (c === '\\') {
                    result += '  ';
                    i++;
                    continue;
                }

                if (c === '"') {
                    result += ' ';
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }

                continue;
            }

            if (state === 'singleQuote') {
                if (c === '\\') {
                    result += '  ';
                    i++;
                    continue;
                }

                if (c === "'") {
                    result += ' ';
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }

                continue;
            }

            if (state === 'template') {
                if (c === '\\') {
                    result += '  ';
                    i++;
                    continue;
                }

                if (c === '`') {
                    result += ' ';
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }
            }
        }

        return result;
    }

    function findEnclosingNames(source, position) {
        const clean = stripStringsAndComments(source);
        const stack = [];

        for (let i = 0; i < position; i++) {
            if (clean[i] === '{') {
                stack.push(i);
            } else if (clean[i] === '}') {
                stack.pop();
            }
        }

        const names = [];

        for (const bracePosition of stack) {
            const before = clean.slice(
                Math.max(0, bracePosition - 300),
                bracePosition
            );

            let name = null;
            let match;

            // const Foo = {
            // let Foo = {
            // var Foo = {
            match = before.match(
                /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/
            );

            if (match) {
                name = match[1];
            }

            // function foo() {
            // async function foo() {
            if (!name) {
                match = before.match(
                    /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // class Foo {
            if (!name) {
                match = before.match(
                    /class\s+([A-Za-z_$][\w$]*)\s*(?:extends[^{}]+)?$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // init() {
            // async init() {
            if (!name) {
                match = before.match(
                    /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // init: () => {
            if (!name) {
                match = before.match(
                    /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>?\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // Menu: {
            if (!name) {
                match = before.match(
                    /([A-Za-z_$][\w$]*)\s*:\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            if (name) {
                names.push(name);
            }
        }

        return names;
    }

    function resolveContext(location) {
        const source = getSource(location.url);

        if (!source) {
            return null;
        }

        const lines = source.split('\n');

        if (!lines[location.line - 1]) {
            return null;
        }

        let position = 0;

        for (let i = 0; i < location.line - 1; i++) {
            position += lines[i].length + 1;
        }

        position += Math.max(0, location.column - 1);

        const names = findEnclosingNames(source, position);

        if (!names.length) {
            return null;
        }

        return names.join('.');
    }

    console.log = function (...args) {
        if (args[0] !== VERBOSE) {
            return originalLog.apply(console, args);
        }

        args.shift();

        const stack = new Error().stack;
        const location = getStackLocation(stack);

        if (!location) {
            return originalLog.apply(console, args);
        }

        const fileName = getFileName(location.url);

        let context = null;

        try {
            context = resolveContext(location);
        } catch {
            context = null;
        }

        if (context) {
            originalLog(
                `[${fileName}|${context}]`,
                ...args
            );
        } else {
            let functionName =
                location.functionName || 'anonymous';

            if (functionName.startsWith('Object.')) {
                functionName = functionName.slice(7);
            }

            originalLog(
                `[${fileName}|${functionName}]`,
                ...args
            );
        }
    };
})();

(function init() {
})();