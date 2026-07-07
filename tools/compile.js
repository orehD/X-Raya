// X-Raya-roles.xlsx → titles.generated.js  (готовый массив TITLES для вставки в index.html).
// Запуск: node compile.js   (нужен: npm i xlsx)
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const LIST = /\s*\|\s*/;
const cols = ['key','cat','flags','extra','ghKw','ru','stack','syn','al'];
const headerRu = {
  key:'Ключ (уникальный)', cat:'Категория (it/nonit)', flags:'Флаги (exec)',
  extra:'Профильные площадки', ghKw:'GitHub-ключ', ru:'Русское название',
  stack:'Стек по умолчанию', syn:'Синонимы для запросов', al:'Алиасы распознавания'
};
const listFields = new Set(['flags','extra','stack','syn','al']);

const src = path.join(__dirname, '..', 'X-Raya-roles.xlsx');
const wb = XLSX.readFile(src);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

const q = s => "'" + String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'") + "'";
const errs = [];
const seen = new Set();

const objs = rows.map((row, i) => {
  const r = {};
  for (const c of cols) {
    let v = row[headerRu[c]];
    v = (v == null ? '' : String(v)).trim();
    if (listFields.has(c)) r[c] = v ? v.split(LIST).map(x=>x.trim()).filter(Boolean) : [];
    else r[c] = v;
  }
  if (!r.key) errs.push('строка '+(i+2)+': пустой key');
  if (seen.has(r.key)) errs.push('дубль key: '+r.key);
  seen.add(r.key);
  if (r.cat!=='it' && r.cat!=='nonit') errs.push(r.key+': cat должен быть it/nonit (сейчас "'+r.cat+'")');
  if (!r.al.length) errs.push(r.key+': пустые алиасы (al)');
  if (!r.syn.length) errs.push(r.key+': пустые синонимы (syn)');

  const parts = ['key:'+q(r.key), "cat:'"+r.cat+"'"];
  if (r.flags.length) parts.push('flags:['+r.flags.map(q).join(',')+']');
  if (r.extra.length) parts.push('extra:['+r.extra.map(q).join(',')+']');
  if (r.ghKw) parts.push('ghKw:'+q(r.ghKw));
  parts.push('ru:'+q(r.ru));
  if (r.stack.length) parts.push('stack:['+r.stack.map(q).join(',')+']');
  parts.push('syn:['+r.syn.map(q).join(',')+']');
  parts.push('al:['+r.al.map(q).join(',')+']');
  return '  {'+parts.join(', ')+'}';
});

if (errs.length) { console.error('❌ Ошибки в таблице:\n - '+errs.join('\n - ')); process.exit(1); }

const out = '// АВТОГЕНЕРАЦИЯ из X-Raya-roles.xlsx — правь таблицу, не этот файл.\n'
          + '// Вставить массив в index.html вместо const TITLES = [...].\n'
          + 'const TITLES = [\n' + objs.join(',\n') + '\n];\n';
const dst = path.join(__dirname, 'titles.generated.js');
fs.writeFileSync(dst, out);
console.log('OK ->', dst, '| ролей:', objs.length);
