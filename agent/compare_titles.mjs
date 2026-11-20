import fs from 'node:fs';
import {catalogueMatch} from '../src/core.mjs';
const [manifest, output] = process.argv.slice(2);
if (!manifest || !output) throw Error('Укажите путь к манифесту и к результату.');
const cards = fs.readFileSync(manifest, 'utf8').trim().split('\n').map(line=>JSON.parse(line));
const result = cards.map(card=>JSON.stringify({id:card.id,title_match:catalogueMatch(card.subject)})).join('\n')+'\n';
if (fs.existsSync(output)) {
  if (fs.readFileSync(output,'utf8')!==result) throw Error('Файл исходных результатов уже зафиксирован.');
} else {
  fs.writeFileSync(output,result,{flag:'wx'});
}
