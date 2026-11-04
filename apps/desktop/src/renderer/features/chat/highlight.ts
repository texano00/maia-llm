/**
 * A dependency-free syntax highlighter for model output.
 *
 * Bundling a full highlighter (shiki, highlight.js) adds tens of megabytes to the
 * renderer for what chat needs: colour the handful of languages models answer
 * with most often. This scanner is deliberately small — near-miss highlighting is
 * fine, wrong output is not, so anything it does not recognise stays plain text.
 *
 * It never produces HTML: callers receive token lists and render spans.
 */

export type TokenType =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "builtin"
  | "type"
  | "function"
  | "operator"
  | "punctuation"
  | "property"
  | "variable"
  | "added"
  | "removed";

export interface HighlightToken {
  type: TokenType;
  text: string;
}

interface Grammar {
  lineComments: string[];
  blockComment?: [string, string];
  keywords: string[];
  types?: string[];
  builtins?: string[];
  caseInsensitive?: boolean;
  /** `"key": value` and `key: value` mark the key as a property. */
  keysAreProperties?: boolean;
  /** Triple-quoted strings (Python docstrings). */
  tripleQuotes?: boolean;
  /** `$VAR`, `${VAR}` and `$(…)` inside shell scripts. */
  shellVariables?: boolean;
  /** `#` only starts a comment when it begins a word. */
  hashNeedsBoundary?: boolean;
}

const COMMON_TYPES: string[] = [
  "string",
  "number",
  "boolean",
  "void",
  "any",
  "unknown",
  "never",
  "object",
  "int",
  "float",
  "double",
  "char",
  "bool",
  "byte",
  "u8",
  "u16",
  "u32",
  "u64",
  "i8",
  "i16",
  "i32",
  "i64",
  "usize",
  "isize",
  "str",
  "error"
];

const GRAMMARS: Record<string, Grammar> = {
  shell: {
    lineComments: ["#"],
    keywords: [
      "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
      "case", "esac", "function", "return", "local", "export", "source", "set",
      "unset", "shift", "trap", "exit", "in"
    ],
    builtins: [
      "echo", "cd", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "cat",
      "grep", "sed", "awk", "curl", "wget", "git", "npm", "npx", "node", "python",
      "python3", "pip", "uv", "docker", "make", "gcc", "clang", "sudo", "chmod",
      "chown", "find", "xargs", "which", "tail", "head", "watch"
    ],
    shellVariables: true
  },
  powershell: {
    lineComments: ["#"],
    keywords: [
      "if", "else", "elseif", "foreach", "for", "while", "switch", "function",
      "param", "return", "try", "catch", "finally", "throw", "in"
    ],
    builtins: ["Write-Host", "Get-ChildItem", "Set-Location", "New-Item", "Remove-Item"],
    shellVariables: true,
    caseInsensitive: true
  },
  python: {
    lineComments: ["#"],
    keywords: [
      "def", "class", "return", "if", "elif", "else", "for", "while", "break",
      "continue", "import", "from", "as", "with", "try", "except", "finally",
      "raise", "pass", "lambda", "yield", "global", "nonlocal", "assert", "del",
      "in", "is", "not", "and", "or", "async", "await", "match", "case"
    ],
    builtins: [
      "print", "len", "range", "enumerate", "zip", "open", "str", "int", "float",
      "list", "dict", "set", "tuple", "super", "self", "True", "False", "None"
    ],
    tripleQuotes: true
  },
  javascript: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    keywords: [
      "const", "let", "var", "function", "return", "if", "else", "for", "while",
      "do", "switch", "case", "break", "continue", "new", "class", "extends",
      "super", "import", "export", "default", "from", "async", "await", "try",
      "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "delete",
      "void", "yield", "static", "get", "set", "interface", "type", "enum",
      "implements", "public", "private", "protected", "readonly", "declare",
      "namespace", "satisfies", "as"
    ],
    builtins: [
      "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean",
      "Promise", "Map", "Set", "Date", "RegExp", "Error", "null", "undefined",
      "true", "false", "this", "globalThis", "window", "document", "fetch"
    ],
    keysAreProperties: true
  },
  json: {
    lineComments: [],
    keywords: ["true", "false", "null"],
    keysAreProperties: true
  },
  yaml: {
    lineComments: ["#"],
    keywords: ["true", "false", "null", "yes", "no", "on", "off"],
    keysAreProperties: true
  },
  toml: {
    lineComments: ["#"],
    keywords: ["true", "false"],
    keysAreProperties: true
  },
  css: {
    lineComments: [],
    blockComment: ["/*", "*/"],
    keywords: ["important", "media", "supports", "import", "keyframes", "font-face", "root"],
    keysAreProperties: true
  },
  sql: {
    lineComments: ["--"],
    blockComment: ["/*", "*/"],
    keywords: [
      "select", "from", "where", "insert", "into", "values", "update", "set",
      "delete", "create", "table", "alter", "drop", "join", "left", "right",
      "inner", "outer", "on", "group", "by", "order", "having", "limit",
      "offset", "as", "and", "or", "not", "null", "is", "in", "exists", "union",
      "distinct", "case", "when", "then", "else", "end", "primary", "key",
      "foreign", "references", "index", "with", "returning"
    ],
    caseInsensitive: true
  },
  go: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    keywords: [
      "package", "import", "func", "return", "if", "else", "for", "range",
      "switch", "case", "default", "break", "continue", "go", "defer", "select",
      "chan", "var", "const", "type", "struct", "interface", "map", "make", "new"
    ],
    types: [...COMMON_TYPES, "byte", "rune", "uint", "int64"],
    builtins: ["fmt", "len", "cap", "append", "copy", "delete", "panic", "recover", "nil", "true", "false"]
  },
  rust: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    keywords: [
      "fn", "let", "mut", "const", "static", "struct", "enum", "trait", "impl",
      "for", "while", "loop", "if", "else", "match", "return", "use", "mod",
      "pub", "crate", "self", "super", "as", "where", "move", "async", "await",
      "dyn", "ref", "unsafe", "extern", "type"
    ],
    types: [...COMMON_TYPES, "Option", "Result", "Vec", "String", "Box", "Arc", "Rc"],
    builtins: ["Some", "None", "Ok", "Err", "println", "print", "format", "vec", "panic"]
  },
  c: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    keywords: [
      "int", "char", "float", "double", "void", "long", "short", "unsigned",
      "signed", "struct", "union", "enum", "typedef", "static", "const", "extern",
      "register", "volatile", "return", "if", "else", "for", "while", "do",
      "switch", "case", "default", "break", "continue", "goto", "sizeof",
      "include", "define", "ifdef", "ifndef", "endif", "pragma"
    ],
    builtins: ["printf", "fprintf", "sprintf", "malloc", "calloc", "realloc", "free", "memcpy", "memset", "strlen", "NULL"]
  },
  csharp: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    keywords: [
      "using", "namespace", "class", "struct", "interface", "record", "public",
      "private", "protected", "internal", "static", "readonly", "const", "void",
      "var", "new", "return", "if", "else", "for", "foreach", "while", "switch",
      "case", "default", "break", "continue", "try", "catch", "finally", "throw",
      "async", "await", "in", "out", "ref", "params", "get", "set"
    ],
    types: [...COMMON_TYPES, "Task", "List", "Dictionary", "IEnumerable"],
    builtins: ["Console", "string", "int", "bool", "double", "null", "true", "false", "this", "base"]
  },
  java: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    keywords: [
      "package", "import", "public", "private", "protected", "static", "final",
      "class", "interface", "enum", "record", "extends", "implements", "new",
      "return", "if", "else", "for", "while", "do", "switch", "case", "default",
      "break", "continue", "try", "catch", "finally", "throw", "throws", "void",
      "abstract", "synchronized", "instanceof"
    ],
    types: [...COMMON_TYPES, "List", "Map", "Set", "Optional", "Stream"],
    builtins: ["System", "String", "Integer", "Boolean", "Double", "null", "true", "false", "this", "super"]
  },
  ruby: {
    lineComments: ["#"],
    keywords: [
      "def", "class", "module", "end", "if", "elsif", "else", "unless", "while",
      "until", "do", "return", "yield", "require", "require_relative", "begin",
      "rescue", "ensure", "raise", "attr_accessor", "attr_reader", "nil"
    ],
    builtins: ["puts", "print", "p", "lambda", "proc", "self", "true", "false"],
    keysAreProperties: false
  }
};

const ALIASES: Record<string, string> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  console: "shell",
  shellscript: "shell",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  python3: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "javascript",
  tsx: "javascript",
  typescript: "javascript",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  scss: "css",
  less: "css",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
  golang: "go",
  rs: "rust",
  h: "c",
  hpp: "c",
  cpp: "c",
  "c++": "c",
  cc: "c",
  cs: "csharp",
  kotlin: "java",
  rb: "ruby"
};

const HTML_LANGUAGES = new Set(["html", "xml", "svg", "vue", "svelte", "markup"]);
const DIFF_LANGUAGES = new Set(["diff", "patch"]);

/** Highlights `code` and returns one token list per line (newlines excluded). */
export function highlightCode(code: string, language: string | null): HighlightToken[][] {
  const normalized = normalize(language);

  if (normalized && DIFF_LANGUAGES.has(normalized)) {
    return highlightDiff(code);
  }

  if (normalized && HTML_LANGUAGES.has(normalized)) {
    return toLines(scan(code, HTML_GRAMMAR));
  }

  const grammar = normalized ? GRAMMARS[normalized] : undefined;

  // Unknown languages are shown as plain text rather than mis-coloured: a wrong
  // highlight is more distracting than none.
  if (!grammar) {
    return code.split("\n").map((line) => (line.length > 0 ? [{ type: "plain" as const, text: line }] : []));
  }

  return toLines(scan(code, grammar));
}

export function languageLabel(language: string | null): string {
  const normalized = normalize(language);

  if (!normalized) {
    return "code";
  }

  const display = normalized === "javascript" && language?.toLowerCase().startsWith("ts") ? language : normalized;
  return display;
}

function normalize(language: string | null | undefined): string | null {
  if (!language) {
    return null;
  }

  const cleaned = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (cleaned.length === 0) {
    return null;
  }

  return ALIASES[cleaned] ?? cleaned;
}

const HTML_GRAMMAR: Grammar = {
  lineComments: [],
  blockComment: ["<!--", "-->"],
  keywords: [],
  keysAreProperties: true
};

function scan(source: string, grammar: Grammar): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const keywords = keywordSet(grammar.keywords, grammar.caseInsensitive);
  const types = keywordSet(grammar.types ?? [], grammar.caseInsensitive);
  const builtins = keywordSet(grammar.builtins ?? [], grammar.caseInsensitive);
  const lineComments = grammar.lineComments.filter((marker) => marker.length > 0);

  let index = 0;

  const push = (type: TokenType, text: string): void => {
    if (text.length === 0) {
      return;
    }
    const previous = tokens[tokens.length - 1];
    if (previous && previous.type === type) {
      previous.text += text;
      return;
    }
    tokens.push({ type, text });
  };

  const rest = (): string => source.slice(index);

  while (index < source.length) {
    const remaining = rest();

    if (grammar.blockComment) {
      const [open, close] = grammar.blockComment;
      if (remaining.startsWith(open)) {
        const end = source.indexOf(close, index + open.length);
        const stop = end === -1 ? source.length : end + close.length;
        push("comment", source.slice(index, stop));
        index = stop;
        continue;
      }
    }

    const lineMarker = lineComments.find((marker) => {
      if (!remaining.startsWith(marker)) {
        return false;
      }
      // `#` inside `$#` or `a#b` is not a comment in shell scripts.
      if (marker === "#" && grammar.hashNeedsBoundary !== false) {
        const before = source[index - 1] ?? " ";
        return /[\s;(){}[\]|&]/.test(before) || index === 0;
      }
      return true;
    });

    if (lineMarker) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      push("comment", source.slice(index, stop));
      index = stop;
      continue;
    }

    if (grammar.tripleQuotes && (remaining.startsWith('"""') || remaining.startsWith("'''"))) {
      const quote = remaining.slice(0, 3);
      const end = source.indexOf(quote, index + 3);
      const stop = end === -1 ? source.length : end + 3;
      push("string", source.slice(index, stop));
      index = stop;
      continue;
    }

    const quote = remaining[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const stop = endOfString(source, index, quote);
      const text = source.slice(index, stop);
      const after = source.slice(stop).match(/^\s*:/);
      push(grammar.keysAreProperties && after ? "property" : "string", text);
      index = stop;
      continue;
    }

    const number = /^(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[a-zA-Z]+)?/.exec(remaining);
    if (number && /^[\d.]/.test(remaining)) {
      push("number", number[0]);
      index += number[0].length;
      continue;
    }

    if (grammar.shellVariables && remaining.startsWith("$")) {
      const variable = /^\$(?:\{[^}]*\}|\(\(?[^)]*\)?\)|[A-Za-z_][\w]*|[@*#?$!-])/.exec(remaining);
      if (variable) {
        push("variable", variable[0]);
        index += variable[0].length;
        continue;
      }
    }

    const word = /^[A-Za-z_$@][\w$-]*/.exec(remaining);
    if (word) {
      const text = word[0];
      const looked = grammar.caseInsensitive ? text.toLowerCase() : text;
      const after = source.slice(index + text.length);
      const isCall = /^\s*\(/.test(after);
      const isKey = grammar.keysAreProperties === true && /^\s*:/.test(after);

      if (keywords.has(looked)) {
        push("keyword", text);
      } else if (types.has(looked)) {
        push("type", text);
      } else if (builtins.has(looked)) {
        push("builtin", text);
      } else if (isCall) {
        push("function", text);
      } else if (isKey) {
        push("property", text);
      } else {
        push("plain", text);
      }

      index += text.length;
      continue;
    }

    if (/[{}()[\]]/.test(remaining[0] ?? "")) {
      push("punctuation", remaining[0] ?? "");
      index += 1;
      continue;
    }

    const operator = /^[+\-*/%=<>!&|^~?@:]+/.exec(remaining);
    if (operator) {
      push("operator", operator[0]);
      index += operator[0].length;
      continue;
    }

    push("plain", remaining[0] ?? "");
    index += 1;
  }

  return tokens;
}

/** Colours only a leading `+`/`-` so a diff keeps its alignment. */
function highlightDiff(code: string): HighlightToken[][] {
  return code.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) {
      return [{ type: "comment", text: line }];
    }
    if (line.startsWith("@@")) {
      return [{ type: "keyword", text: line }];
    }
    if (line.startsWith("+")) {
      return [{ type: "added", text: line }];
    }
    if (line.startsWith("-")) {
      return [{ type: "removed", text: line }];
    }

    return line.length > 0 ? [{ type: "plain", text: line }] : [];
  });
}

function endOfString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === quote) {
      return index + 1;
    }

    // An unterminated single-quoted string stops at the line end; template
    // literals and triple quotes may span lines, so they keep scanning.
    if (char === "\n" && quote !== "`") {
      return index;
    }

    index += 1;
  }

  return source.length;
}

function keywordSet(words: string[], caseInsensitive: boolean | undefined): Set<string> {
  return new Set(words.map((word) => (caseInsensitive ? word.toLowerCase() : word)));
}

function toLines(tokens: HighlightToken[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];

  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, position) => {
      if (position > 0) {
        lines.push([]);
      }
      if (part.length > 0) {
        lines[lines.length - 1]?.push({ type: token.type, text: part });
      }
    });
  }

  return lines;
}
