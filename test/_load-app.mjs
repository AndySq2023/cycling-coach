// Test harness for the single-file front-end.
//
// app/cycling-coach.html is deliberately build-free: HTML + CSS + one <script>. That
// keeps deployment trivial but means the logic inside it can't be `import`ed. Rather
// than break the no-build rule to gain tests, this loader lifts named top-level
// functions out of the script text and evaluates them in a plain Node scope.
//
// It only works for PURE functions (regex/JSON/date maths, no DOM, no globals) — which
// is exactly the set worth pinning down: the fenced-block parsers that write to the
// training plan and the coach's memory, the date guards, and the route codec.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'cycling-coach.html');

function scriptBody() {
  const html = readFileSync(APP, 'utf8');
  const open = html.indexOf('<script>');
  const close = html.lastIndexOf('</script>');
  if (open === -1 || close === -1) throw new Error('Could not find the app <script> block.');
  return html.slice(open + '<script>'.length, close);
}

// Pull `function name(...) { ... }` out by brace-matching from its opening brace.
// Brace-counting is naive about braces inside strings/regex/comments, so it is only
// trusted to the extent that the extracted source then parses — if a function came out
// truncated, evaluating it below throws and the test fails loudly rather than silently
// testing the wrong thing.
function extractFunction(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Function ${name}() not found in the app script.`);
  const start = m.index;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unbalanced braces while extracting ${name}().`);
}

// Pull a top-level `const NAME = [...]` / `= {...}` out by bracket-matching. Some pure
// functions are only pure given a lookup table declared beside them (the band
// inventory, the anchor list) — without these the function would have to be rewritten
// to take them as arguments purely to be testable, which is the tail wagging the dog.
function extractConst(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=`);
  const m = re.exec(src);
  if (!m) throw new Error(`Constant ${name} not found in the app script.`);
  // Scan to the terminating semicolon at nesting depth zero. Depth alone isn't
  // enough: the anchor table's values contain parentheses inside string literals,
  // so quotes have to be skipped or the counter desynchronises.
  let i = m.index + m[0].length, depth = 0, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`Unterminated declaration while extracting ${name}.`);
}

// Evaluate the named functions together (so they can call each other) and return
// them. `consts` are declared first so the functions close over them, and are
// returned too — a lookup table the app prescribes from is itself worth asserting on.
export function loadAppFunctions(names, consts = []) {
  const src = scriptBody();
  const decls = consts.map(n => extractConst(src, n)).join('\n');
  const defs = names.map(n => extractFunction(src, n)).join('\n\n');
  const out = [...consts, ...names].join(', ');
  const factory = new Function(`${decls}\n${defs}\nreturn { ${out} };`);
  return factory();
}
