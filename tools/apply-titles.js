// Вставляет titles.generated.js в ../index.html вместо блока const TITLES = [...]. Идемпотентно.
// Запуск: node apply-titles.js  (после compile.js). Затем — git commit index.html.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const idxPath = path.join(root, 'index.html');

let html = fs.readFileSync(idxPath, 'utf8');
const gen = fs.readFileSync(path.join(__dirname, 'titles.generated.js'), 'utf8')
  .replace(/^\/\/.*$/gm, '')            // убрать строки-комментарии
  .replace(/^\s*\n/, '')                // и первую пустую
  .trimEnd() + '\n';                    // -> 'const TITLES = [ ... ];'

const T0 = html.indexOf('const TITLES = [');
const G0 = html.indexOf('const GENERIC =');
if (T0 < 0 || G0 < 0 || G0 < T0) { console.error('❌ Не нашёл границы TITLES/GENERIC в index.html'); process.exit(1); }

const before = html.slice(0, T0);
const after = html.slice(G0);
html = before + gen + '\n' + after;
fs.writeFileSync(idxPath, html);

const count = (gen.match(/\{key:/g) || []).length;
console.log('OK: TITLES заменён в index.html | ролей:', count);
