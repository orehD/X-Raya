// Прогоняет все 192 специализации Candy через движок распознавания (поверх titles.generated.js)
// и делит на «распознано» / «провал в GENERIC». Источник Candy — ../../candy-specializations.md (раздел 2).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const A0 = html.indexOf('const CITIES = [');
const T0 = html.indexOf('const TITLES = [');
const G0 = html.indexOf('const GENERIC =');
const endM = 'return {raw:raw.trim(), role, techs, city, grade, matched};\n}';
const E = html.indexOf(endM) + endM.length;
const engine = html.slice(A0, T0) + '\n' + html.slice(G0, E);
const titles = fs.readFileSync(path.join(__dirname, 'titles.generated.js'), 'utf8').replace(/^\/\/.*$/gm, '');
const sb = {};
new Function(titles + '\n' + engine + '\nthis.parse = parse;').call(sb);
const parse = sb.parse;

const md = fs.readFileSync('/Users/macbook/candy-specializations.md', 'utf8');
const sec2 = md.split('## 2.')[1];
const listLine = sec2.split('\n').find(l => l.includes(' · '));
const items = listLine.split('·').map(s => s.trim()).filter(Boolean);

const covered = [], missed = [];
for (const it of items) {
  const p = parse(it);
  const generic = !p.matched || p.role.key === 'Специалист' || p.role.key === 'Developer' && !/develop|разработ|программист|engineer/i.test(it);
  // «Developer» считаем покрытием только если строка реально про разработку
  if (p.matched && p.role.key !== 'Специалист') covered.push([it, p.role.key]);
  else missed.push(it);
}

console.log('ПОКРЫТО ('+covered.length+'):');
covered.forEach(([it,k]) => console.log('  ✅ '+it+'  → '+k));
console.log('\nПРОВАЛ В GENERIC ('+missed.length+'):');
missed.forEach(it => console.log('  ❌ '+it));
console.log('\nВсего Candy: '+items.length+' | покрыто: '+covered.length+' | пробелов: '+missed.length);
fs.writeFileSync(path.join(__dirname, 'candy-missed.json'), JSON.stringify(missed, null, 1));
