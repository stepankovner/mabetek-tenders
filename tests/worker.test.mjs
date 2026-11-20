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
test('РЖД: зона каталога, лишние пробелы и обе местные даты',()=>{
 const t=core.rzdTime('24.11.2026  02:00');
 assert.equal(t.utc,'2026-11-23T23:00:00.000Z');
 assert.equal(t.khabarovsk,'24.11.2026 09:00');
 assert.equal(core.rzdTime('24.11.2026').utc,null);
 assert.equal(core.rzdTime('31.02.2026 12:00').utc,null);
});
test('B2B-Center: извещения, повторы ссылок, контроль оригинала и капчи',()=>{
 const u='/app/market-next/postanovka-vagonov/tender-1234567/';
 const html='<h1>Поиск</h1><a href="'+u+'">№ 1234567</a><a href="'+u+'">№ 1234567</a>';
 assert.deepEqual(core.b2bIndex(html),[{id:'1234567',url:'https://www.b2b-center.ru'+u}]);
 assert.throws(()=>core.b2bIndex('<title>Captcha</title>'));
 assert.throws(()=>core.b2bIndex('<a href="https://foreign.invalid'+u+'">Торги</a>'));
});

test('B2B strips the tracking fragment used in the public catalogue',()=>{
  const path='/market/sklad/tender-4691136/';
  const html='<a href="'+path+'#btid=2&amp;tsid=4691136004"></a>';
  assert.deepEqual(core.b2bIndex(html),[{id:'4691136',url:'https://www.b2b-center.ru'+path}]);
});

test('B2B uses the subject and verifies the original procedure number',()=>{
  const page='<title>Услуги хранения — Тендер № 123 — B2B-Center</title><h1>Запрос предложений № 123</h1>';
  assert.equal(core.b2bTitle(page,'123'),'Услуги хранения');
  assert.throws(()=>core.b2bTitle(page,'12'));
  assert.throws(()=>core.b2bTitle('<title>Вход</title>','123'));
});
test('B2B associates search titles with the same procedure and distinguishes a valid empty catalogue',()=>{
 const url='/app/market-next/obshchii-zapros/tender-1234/';
 const html='<a href="'+url+'#ref">№1234</a><p class="panel-procedure__dscr-main">Услуги <mark>погрузки</mark> вагонов</p>';
 assert.equal(core.b2bIndex(html)[0].title,'Услуги погрузки вагонов');
 assert.deepEqual(core.b2bIndex('<main>По вашему запросу \n нет актуальных процедур</main>'),[]);
});
test('Original catalogues retain distinct lots and require recognised links',()=>{
 const card=(lot)=>'<a class="search-results__link--description" href="/procedure/B2011261722344/'+lot+'">Услуги перевалки</a>';
 assert.equal(core.publicIndex('roseltorg',card(1)+card(2)).length,2);
 assert.equal(core.publicIndex('tektorg','<a href="/org/rzd/procedures/20204348">Разгрузка грузов</a>')[0].title,'Разгрузка грузов');
 assert.throws(()=>core.publicIndex('gpb','<a href="https://other.test/front/procedure/view/x" class="vTitle">Запрос поставки</a>'));
 assert.throws(()=>core.publicIndex('tektorg','<title>Войдите</title>'));
});
test('Roseltorg reads only the selected lot and keeps unknown dates and addresses explicit',()=>{
 const chunk=(n,s)=>'<div class="lot-page__left-column-lot" data-feature-favorite-lots-procedure-number="B1234" data-feature-favorite-lots-lot-number="'+n+'"><div class="lot-title"><h1>'+s+'</h1></div><div class="customer-name js-seo-customer-name"><a>Заказчик '+n+'</a></div><div class="lot-delivery__text"><div class="lot-expand-text__text">;;</div></div></div>';
 const c=core.roseltorgCard(chunk(1,'Первый предмет')+chunk(2,'Второй предмет'),'https://www.roseltorg.ru/procedure/B1234/2');
 assert.equal(c.title,'Второй предмет');assert.equal(c.customer,'Заказчик 2');assert.equal(c.lot,'2');assert.equal(c.place,'');assert.equal(c.deadline,'');
});
test('Облачный отбор улавливает прямо названные услуги, ремонт сам по себе не подходит',()=>{
 for(const s of ['Аренда ж/д тупика','Путь необщего пользования исполнителя','Приём полувагонов на площадке','Приёмка с железнодорожного транспорта','Перевалка','Склад с подъездным путём','Раскрытие вагона','Площадка для перегрузки'])assert.ok(core.serviceMatch(s),s);
 for(const s of ['Поставка колёс для вагонов','Ремонт пути необщего пользования','Поставка типовых ж/д вагонов'])assert.equal(core.serviceMatch(s),false,s);
});
test('Catalogue separates the purchase subject from its destination',async()=>{
 const {catalogueMatch}=await import('../src/core.mjs');
 assert.equal(catalogueMatch('Поставка насосов для нужд терминала по перевалке'),false);
 assert.equal(catalogueMatch('Услуги по очистке от снега путей необщего пользования'),false);
 assert.equal(catalogueMatch('Перевалка вагонов для нужд заказчика'),true);
});
