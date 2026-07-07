// Guardrail: гоняет движок распознавания из index.html поверх скомпилированного словаря titles.generated.js.
// Запуск: node test-roles.js   (после compile.js). Падает с кодом 1, если есть провалы — удобно как pre-commit.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Вырезаем движок из index.html БЕЗ его встроенного TITLES (его подменяем скомпилированным).
const A0 = html.indexOf('const CITIES = [');
const T0 = html.indexOf('const TITLES = [');
const G0 = html.indexOf('const GENERIC =');
const endM = 'return {raw:raw.trim(), role, techs, city, grade, matched};\n}';
const E = html.indexOf(endM) + endM.length;
if (A0<0||T0<0||G0<0||E<endM.length) { console.error('❌ Не нашёл маркеры движка в index.html'); process.exit(1); }
const engine = html.slice(A0, T0) + '\n' + html.slice(G0, E);
const titles = fs.readFileSync(path.join(__dirname, 'titles.generated.js'), 'utf8').replace(/^\/\/.*$/gm, '');

const sb = {};
new Function(titles + '\n' + engine + '\nthis.parse = parse;').call(sb);
const parse = sb.parse;

const cases = [
  ['Сеньор дата аналитик из банков со знанием python и js в москве','DataAnalyst'],
  ['Сеньор data analyst из банков со знанием python в москве','DataAnalyst'],
  ['аналитик данных','DataAnalyst'],
  ['системный аналитик','SystemAnalyst'],
  ['бизнес-аналитик','BusinessAnalyst'],
  ['bi аналитик','BIAnalyst'],
  ['продуктовый аналитик','ProductAnalyst'],
  ['аналитик','Analyst'],
  ['data scientist','DataScientist'],
  ['дата-сайентист','DataScientist'],
  ['ml engineer','MLEngineer'],
  ['мл инженер','MLEngineer'],
  ['data engineer','DataEngineer'],
  ['дата инженер','DataEngineer'],
  ['бэкенд разработчик','Backend'],
  ['фронтенд разработчик','Frontend'],
  ['фулстек разработчик','Fullstack'],
  ['android разработчик','Android'],
  ['ios разработчик','iOS'],
  ['разработчик','Developer'],
  ['python разработчик','Developer'],
  ['go developer','Developer'],
  ['девопс инженер','DevOps'],
  ['тестировщик','QA'],
  ['qa automation','QAAuto'],
  ['пентестер','Pentester'],
  ['CTO','CTO'],
  ['технический директор','CTO'],
  ['генеральный директор','CEO'],
  ['продуктовый дизайнер figma','ProductDesigner'],
  ['графический дизайнер','GraphicDesigner'],
  ['маркетолог','Marketing'],
  ['seo специалист','SEO'],
  ['smm менеджер','SMM'],
  ['менеджер по продажам','Sales'],
  ['рекрутер','Recruiter'],
  ['юрист','Lawyer'],
  ['бухгалтер','Accountant'],
  ['логист','Logistics'],
  ['project manager','ProjectManager'],
  ['продакт менеджер','PM'],
  ['скрам мастер','ScrumMaster'],
];

let ok=0, bad=0;
for (const [q, exp] of cases) {
  const got = parse(q).role.key;
  const pass = got === exp;
  pass ? ok++ : bad++;
  console.log((pass?'✅':'❌')+' '+String(got).padEnd(16)+'(ожид '+String(exp).padEnd(16)+') ← '+q);
}
console.log('\nИтого: '+ok+' ок, '+bad+' провалов');
process.exit(bad ? 1 : 0);
