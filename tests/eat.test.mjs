import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readPublicPage} from '../tools/eat_catalogue.mjs';

const url='https://agregatoreat.ru/purchases/announcement/74f64b08-f3cc-4393-bbd3-bf5d6923727b/';
function parse(cards) {
  return runInNewContext('('+readPublicPage.toString()+')()',{
    location:new URL('https://agregatoreat.ru/purchases/all'),
    document:{
      querySelector:()=>({textContent:'1'}),
      querySelectorAll:()=>cards
    }
  });
}
function card(status,href=url) {
  return {innerText:'200909569126100426\n'+status+'\nНаименование\n\nВыгрузка вагонов\n\nЗаказчик\nОрганизация',
    querySelector:()=>({innerText:status,href})};
}
test('ЕАТ сохраняет только открытые карточки в стадии подачи',()=>{
  const result=parse([card('Подача предложений'),card('Запланирована'),{innerText:'Войти в профиль\n для просмотра закупки'}]);
  assert.equal(result.restricted,1);
  assert.equal(result.inactive,1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows)),[{number:'200909569126100426',title:'Выгрузка вагонов',url}]);
});
test('ЕАТ отличает пустую оболочку и неподтверждённый адрес от результатов',()=>{
  assert.throws(()=>parse([]),/не загружен/);
  assert.throws(()=>parse([card('Подача предложений','https://example.org/')]),/карточка/);
});
