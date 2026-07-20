// roles-data.js → X-Raya-roles.xlsx (первичная генерация таблицы-источника правды).
// Запуск: node build-xlsx.js   (нужен: npm i xlsx)
const XLSX = require('xlsx');
const path = require('path');
const roles = require('./roles-data.js');

const LIST = ' | ';
const cols = ['key','cat','flags','extra','ghKw','ru','stack','syn','al'];
const headerRu = {
  key:'Ключ (уникальный)', cat:'Категория (it/nonit)', flags:'Флаги (exec)',
  extra:'Профильные площадки', ghKw:'GitHub-ключ', ru:'Русское название',
  stack:'Стек по умолчанию', syn:'Синонимы для запросов', al:'Алиасы распознавания'
};
const listFields = new Set(['flags','extra','stack','syn','al']);

const rows = roles.map(r => {
  const o = {};
  for (const c of cols) {
    const v = r[c];
    o[headerRu[c]] = v == null ? '' : (listFields.has(c) ? (v || []).join(LIST) : v);
  }
  return o;
});

const ws = XLSX.utils.json_to_sheet(rows, { header: cols.map(c => headerRu[c]) });
ws['!cols'] = [
  {wch:16},{wch:14},{wch:12},{wch:22},{wch:16},{wch:26},{wch:22},{wch:48},{wch:70}
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Роли');
const out = path.join(__dirname, '..', 'X-Raya-roles.xlsx');
XLSX.writeFile(wb, out);
console.log('OK ->', out, '| ролей:', roles.length);
