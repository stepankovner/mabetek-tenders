import test from 'node:test';
import assert from 'node:assert/strict';
const core=await import('../src/core.mjs').catch(()=>({}));
const item={source:'eis',procedure:'A',lot:'1',title:'Приём вагонов',url:'https://zakupki.gov.ru/a'};
test('Зеркала и отдельные лоты',()=>{
  assert.equal(typeof core.identity,'function');
  assert.equal(core.identity({...item,eis:'123'}),core.identity({...item,eis:'123',source:'rts'}));
  assert.notEqual(core.identity(item),core.identity({...item,lot:'2'}));
});
test('Приватный чат и владелец',()=>{
  assert.equal(typeof core.authorized,'function');
  for(const [type,id,from,ok] of [['private',5,5,true],['group',5,5,false],['private',4,5,false],['private',4,4,false]])
    assert.equal(core.authorized({type,id},from,'5'),ok);
});
test('Недоступная выдача и пустая RSS',()=>{
  assert.equal(typeof core.feed,'function');
  for(const html of ['<html>captcha</html>','<html>Вход</html>','<rss></rss>'])
    assert.throws(()=>core.feed(html));
  assert.deepEqual(core.feed('<rss><channel><title>ЕИС</title></channel></rss>'),[]);
});
test('Карточка секции РЖД сохраняет место из ТЗ отдельно от региона',()=>{
  const html='<table>'+Object.entries({'Наименование':'Погрузка и выгрузка грузов','Заказчик':'ОАО РЖД','Регион':'Хабаровский край','Место поставки':'Место указано в техническом задании','Площадка':'РТС-тендер','Дата окончания подачи заявок':'24.11.2026 02:00 МСК'}).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table>';
  const url='https://rzd.rts-tender.ru/TenderInterests/LogViewAndRedirect?tenderId=24233643&tenderStatus=RTS_Notification';
  assert.match(core.rzdCard(html,url).place,/техническом/);
  assert.throws(()=>core.rzdCard('<html>Вход</html>',url));
});
