// Bundles the bot engine + in-memory store + demo UI into ONE html file that runs with no server.
// Run: node scripts/build-standalone.js  -> dist/klinikbot-demo.html
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLINIC_ID = process.env.CLINIC || 'demo-dental';

// Minimal CommonJS bundler: each module wrapped in a function; relative requires resolved by path.
const modules = {
  './engine/scheduling': 'src/engine/scheduling.js',
  './engine/parser': 'src/engine/parser.js',
  './engine/messages': 'src/engine/messages.js',
  './engine/ai': 'src/engine/ai.js',
  './engine/conversation': 'src/engine/conversation.js',
  './store/db': 'src/store/memory.js', // swap SQLite for memory in the browser
  './store': 'src/store/index.js',
  './store/index': 'src/store/index.js',
  'node:async_hooks': 'src/store/node-stub.js',
};
function resolveReq(fromKey, req) {
  // normalise '../store/db' / './scheduling' relative to the module's folder
  const base = path.posix.dirname(fromKey);
  let r = path.posix.normalize(path.posix.join(base, req));
  if (!r.startsWith('.')) r = './' + r;
  if (modules[r]) return r;
  if (modules[req]) return req; // bare ids like 'node:async_hooks'
  throw new Error(`Unresolved require '${req}' from ${fromKey}`);
}
let out = `(function(){\nconst __defs = {};\nconst __cache = {};\nfunction __req(k){ if(__cache[k]) return __cache[k].exports; const m={exports:{}}; __cache[k]=m; __defs[k](m, m.exports); return m.exports; }\n`;
for (const [key, file] of Object.entries(modules)) {
  let src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  src = src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, req) => `__req(${JSON.stringify(resolveReq(key, req))})`);
  out += `__defs[${JSON.stringify(key)}] = function(module, exports){\n${src}\n};\n`;
}
const clinic = JSON.parse(fs.readFileSync(path.join(ROOT, 'clinics', `${CLINIC_ID}.json`), 'utf8'));
out += `__req('./store').use(__req('./store/db'));\nwindow.KB = { clinic: ${JSON.stringify(clinic)}, db: __req('./store/db'), store: __req('./store'), S: __req('./engine/scheduling'), ...__req('./engine/conversation') };\n})();\n`;

let html = fs.readFileSync(path.join(ROOT, 'public', 'demo.html'), 'utf8');
html = html.replace('<script>', `<script>\n${out}\n</script>\n<script>`);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const dest = path.join(ROOT, 'dist', 'klinikbot-demo.html');
fs.writeFileSync(dest, html);
console.log(`built ${dest} (${(html.length / 1024).toFixed(0)} KB)`);

// Artifact variant: the artifact host wraps the file in its own doctype/head/body skeleton, so strip ours.
let art = html.replace(/^[\s\S]*?<head>/, '').replace(/<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*/g, '')
  .replace('</head>\n<body>', '').replace(/<\/body>\s*<\/html>\s*$/, '');
const artDest = path.join(ROOT, 'dist', 'klinikbot-demo.artifact.html');
fs.writeFileSync(artDest, art);
console.log(`built ${artDest} (${(art.length / 1024).toFixed(0)} KB)`);
