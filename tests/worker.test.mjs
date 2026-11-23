import test from 'node:test';
import assert from 'node:assert/strict';
const core=await import('../src/core.mjs').catch(()=>({}));
const item={source:'eis',procedure:'A',lot:'1',title:'Приём вагонов',url:'https://zakupki.gov.ru/a'};
test('Оригинал ЕИС связывает номер, заказчика, место, цену и явно указанный часовой пояс',()=>{
  const number='0322200001326000255';
  const url='https://zakupki.gov.ru/epz/order/notice/zk20/view/common-info.html?regNumber='+number;
  const header=(name,value)=>'<span class="cardMainInfo__title">'+name+'</span><span class="cardMainInfo__content">'+value+'</span>';
  const field=(name,value)=>'<section><span class="section__title">'+name+'</span><span class="section__info">'+value+'</span></section>';
  const page='<span class="cardMainInfo__purchaseLink distancedText"><a href="#">№ '+number+'</a></span>'+
    '<span class="cardMainInfo__state distancedText">Подача заявок</span>'+
    header('Объект закупки','Погрузка и выгрузка вагонов')+header('Заказчик','<a>Хабаровский заказчик</a>')+
    header('Начальная цена','322 666,67 ₽')+field('Место поставки товара, выполнения работы или оказания услуги','Хабаровск, Пушкина, 46')+
    field('Дата и время окончания срока подачи заявок', "07.12.2099 11:00 <span class='timeZoneName'>(МСК+7)</span>")+
    '<a class="tabsNav__item" href="/epz/order/notice/zk20/view/documents.html?regNumber='+number+'">Документы</a>';
  const card=core.eisOrderCard(page,url);
  assert.equal(card.procedure,number);
  assert.equal(card.customer,'Хабаровский заказчик');
  assert.equal(card.place,'Хабаровск, Пушкина, 46');
  assert.equal(card.price,'322 666,67');
  assert.equal(core.eisTime(card.deadline).utc,'2099-12-07T01:00:00.000Z');
  assert.equal(core.eisTime('07.12.2099 11:00').utc,null);
  assert.equal(core.eisTime('31.02.2099 11:00 (МСК+7)').utc,null);
  assert.ok(card.documentsPage.includes('/documents.html?'));
  assert.equal(core.eisOrderCard(page+header('Заказчик','Другой заказчик'),url).customer,'');
  assert.equal(core.eisOrderCard(page+header('Обновлено','23.11.2026'),url).updated,'23.11.2026');
  assert.throws(()=>core.eisOrderCard(page.replace('№ '+number,'№ 0322200001326000256'),url),/номер/i);
});
test('ЕИС 223-ФЗ читает альтернативную разметку и привязывает документы к номеру',()=>{
  const number='32616611130';
  const base='https://zakupki.gov.ru/epz/order/notice/notice223/';
  const url=base+'common-info.html?regNumber='+number;
  const tab='documents.html?purchaseNoticeNumber='+number+'&noticeGuid=065fb6a1-f124-4aad-8251-e85321fad545';
  const field=(name,value)=>'<div class="common-text__title">'+name+'</div><div class="common-text__value">'+value+'</div>';
  const page='<div class="registry-entry__header-mid__number"><a>№ '+number+'</a></div>'+
    '<div class="registry-entry__header-mid__title">Подача заявок</div>'+
    field('Наименование закупки','Погрузка вагонов')+
    field('Наименование организации','<div class="common-text__value"><a>Заказчик</a></div>')+
    field('Место нахождения','Хабаровск, ул. Ленина')+
    field('Контактный телефон','+7 000 000 00 00')+
    field('Дата и время окончания срока подачи заявок (по местному времени заказчика)','30.11.2099 16:00 (МСК+7)')+
    '<div class="price-block__value">3&nbsp;250&nbsp;243,00&nbsp;&#8381;</div>'+
    '<a href="'+base+tab.replace('&','&amp;')+'">Документы</a>';
  const card=core.eisOrderCard(page,url);
  assert.equal(card.title,'Погрузка вагонов');
  assert.equal(card.customer,'Заказчик');
  assert.equal(card.place,'');
  assert.equal(card.phone,'+7 000 000 00 00');
  assert.equal(card.price,'3 250 243,00');
  assert.equal(core.eisTime(card.deadline).utc,'2099-11-30T06:00:00.000Z');
  assert.equal(card.documentsPage,base+tab);
  assert.equal(core.eisOrderCard(page.replace('purchaseNoticeNumber='+number,'purchaseNoticeNumber=32616611131'),url).documentsPage,'');
  assert.equal(core.eisOrderCard(page.replace('href="'+base,'href="https://example.org/'),url).documentsPage,'');
  assert.throws(()=>core.eisOrderCard(page.replace('№ '+number,'№ 32616611131'),url),/номер/i);
});
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
 assert.equal(catalogueMatch('Обеспечение продуктами питания (поставка, хранение, перевозка до пункта назначения, погрузо-разгрузочные работы, очистка и санитарная обработка транспортных средств) для ГБОУ средняя школа №257 Пушкинского района Санкт-Петербурга'),false);
 assert.equal(catalogueMatch('Погрузо-разгрузочные работы при обеспечении продуктами питания'),true);
 assert.equal(catalogueMatch('Перевалка вагонов для нужд заказчика'),true);
});
test('Sber international registry keeps closed bids out of active notices',()=>{
 const row=status=>'&lt;Purchase>&lt;PurchaseID>850&lt;/PurchaseID>&lt;PurchaseName>Приём вагонов&lt;/PurchaseName>&lt;purchStatus>'+status+'&lt;/purchStatus>&lt;purchHref>/documentView.aspx?formCode=PurchaseInfo&amp;amp;id=850&lt;/purchHref>&lt;/Purchase>';
 assert.equal(core.sberRegistry(row('Cancelled'))[0].url,'https://world.sberbank-ast.ru/documentView.aspx?formCode=PurchaseInfo&id=850');
 assert.deepEqual(core.publicIndex('sberWorld',row('Summing up of the bidding')),[]);
 assert.equal(core.publicIndex('sberWorld',row('Bids submission')).length,1);
 assert.throws(()=>core.publicIndex('sberWorld','unavailable'));
});
test('Asset sale and engineering paperwork stay separate from use of railway tracks',()=>{
 assert.equal(core.catalogueMatch('Продажа железнодорожных путей (жд тупик) необщего пользования'),false);
 assert.equal(core.catalogueMatch('Оказание услуг по разработке инструкции о порядке обслуживания движения по пути необщего пользования'),false);
 assert.equal(core.catalogueMatch('Аренда железнодорожного тупика для постановки вагонов'),true);
});

test('РАД: действующие извещения и точная ссылка на оригинал',()=>{
  const row={status:'accept',direction:'44fz',purchaseNumber:'0387200015126000082',purchaseObjectInfo:'Поставка продуктов питания (овощи консервированные)'};
  const feed=items=>JSON.stringify({status:0,data:{count:items.length,items,hasNext:false}});
  assert.deepEqual(core.publicIndex('rad',feed([row,{...row,status:'contract'}])),[{title:row.purchaseObjectInfo,url:'https://gz.lot-online.ru/etp_front/procedure/view/procedure/common/0387200015126000082'}]);
  const market={direction:'tender223_market',status:'Идет прием коммерческих предложений',lotId:'abc123',purchaseObjectInfo:'Выгрузка вагонов',externalUrl:'https://tender.lot-online.ru/app/section/pochta/SmallPurchaseCard/page?SmallPurchaseCard.smallPurchaseEntity=MT%3Aabc123'};
  assert.deepEqual(core.publicIndex('rad',feed([market,{...market,lotId:'other'},{...market,status:'Завершена'}])),[{title:market.purchaseObjectInfo,url:market.externalUrl}]);
  assert.deepEqual(core.publicIndex('rad',feed([])),[]);
  assert.throws(()=>core.publicIndex('rad',JSON.stringify({status:1})));
  assert.throws(()=>core.publicIndex('rad',feed([{...row,purchaseNumber:'bad'}])));
});

test('Содержание путей из рабочей выдачи B2B не создаёт заявку на аренду',()=>{
  for(const title of [
    'Текущее содержание железнодорожных путей необщего пользования и межцеховых подтележечных путей ООО «Эл 6»',
    'Оказание услуг по содержанию железнодорожных путей необщего пользования АО «УК Разрез Степной»',
    'Выполнение комплекса работ: 1.демонтаж Здания склада № 17; 2.обустройство грузовой площадки'
  ]) assert.equal(core.infrastructureOnly(title),true);
  assert.equal(core.infrastructureOnly('Содержание железнодорожных путей и выгрузка вагонов'),false);
});

test('ЗаказРФ: предмет и активный статус берутся из именованных колонок одной строки',()=>{
  const header='<tr><th>Предмет закупки</th><th>Номер закупки</th><th>Состояние закупки</th></tr>';
  const item=state=>'<tr><td>Разгрузка вагонов</td><td><a href="/NotificationEx/id/2116895">0813500000126022596</a></td><td>'+state+'<br/></td></tr>';
  assert.deepEqual(core.publicIndex('zakazrf',header+item('Идет подача заявок на участие')+item('Завершена')),[{title:'Разгрузка вагонов',url:'https://zakazrf.ru/NotificationEx/id/2116895'}]);
  assert.deepEqual(core.publicIndex('zakazrf',header+item('&nbsp;')),[]);
  assert.throws(()=>core.publicIndex('zakazrf','<html>Вход</html>'));
});

test('OTC проверяет статус и официальный адрес в пределах одной карточки',()=>{
  const item=(state,url)=>'<div class="Paper TenderItem-module_paper_x"><a href="'+url+'" class="TenderItem-module_title_x"><span class="index_lotNameTitle_x">Перевалка &amp; хранение</span></a><div class="TenderItem-module_salesCountdown_x"><span>'+state+'</span></div></div>';
  const url='https://etp.otc.ru/tender/90686033';
  const open=item('1 день осталось для подачи заявки',url);
  assert.deepEqual(core.publicIndex('otc',open+open+item('Подача завершена',url+'1')),[{title:'Перевалка & хранение',url}]);
  assert.throws(()=>core.publicIndex('otc',open.replace('etp.otc.ru','example.org')));
  assert.throws(()=>core.publicIndex('otc','<html>Каталог временно недоступен</html>'));
});

test('SOAP ТЭК-Торг хранит открытые лоты одной процедуры отдельно и сохраняет дату с часовым поясом',()=>{
  const link='https://www.tektorg.ru/223-fz/procedures/20383933';
  const lot=(n,status)=>'<lot><number>'+n+'</number><subject>Услуги &amp; хранение</subject><status>'+status+'</status></lot>';
  const response='<proceduresResponse><sectionCode>zakupki</sectionCode><procedures><procedure><url_to_showcase>'+link+'</url_to_showcase><datePublished>2026-11-20T17:48:15+03:00</datePublished><lots>'+lot(1,'Приём заявок')+lot(2,'Завершена')+lot(3,'Прием заявок')+'</lots></procedure></procedures></proceduresResponse>';
  const rows=core.publicIndex('tektorg',response);
  assert.deepEqual(core.publicIndex('tektorgRzd',response.replace('>zakupki<','>rzd<')),rows);
  assert.throws(()=>core.publicIndex('tektorgRzd',response));
  assert.throws(()=>core.publicIndex('tektorgRzd','<html>Вход</html>'));
  assert.deepEqual(rows.map(r=>r.url),[link+'#lot-1',link+'#lot-3']);
  assert.equal(rows[0].published,'2026-11-20T17:48:15+03:00');
  assert.equal(rows[0].title,'Услуги & хранение');
  assert.throws(()=>core.publicIndex('tektorg',response.replace('www.tektorg.ru','example.org')));
});

test('Фабрикант сохраняет секунды публикации и сверяет номер строки со ссылкой',()=>{
  const n='0321300003026000428';
  const item='<tr><td class="row-procedure_number sortable">'+n+'</td><td class="row-status ">Прием заявок</td><td class="row-procedure_name sortable"><a href="/44/procedure/ea21/'+n+'?backurl=catalog">Погрузка грузов</a></td><td class="row-publication_datetime sortable">21.11.2026 12:36:46<span>(MSK+00:00)</span></td></tr>';
  assert.equal(core.publicIndex('fabrikant',item)[0].published,'2026-11-21T09:36:46.000Z');
  assert.equal(core.publicIndex('fabrikant',item.replace('MSK+00:00',''))[0].published,null);
  assert.deepEqual(core.publicIndex('fabrikant',item.replace('Прием заявок','Завершена')),[]);
  assert.throws(()=>core.publicIndex('fabrikant',item.replace(n,'0000000000000000000')));
});

test('Явное исключение ПРР не создаёт совпадение и сохраняет другие услуги',()=>{
  assert.equal(core.serviceMatch('Перевозка мебели без учета погрузочно-разгрузочных работ'),false);
  assert.equal(core.serviceMatch('Аренда тупика без погрузочно-разгрузочных работ'),true);
  assert.equal(core.serviceMatch('Погрузочно-разгрузочные работы без учета стоимости материалов'),true);
});

test('B2B uses the publication field from the matching original URL and validates the date',()=>{
 const path='/market/gruz/tender-1234567/';
 const anchor='<a href="'+path+'">Лот</a>';
 const field=(url,date)=>'url:'+JSON.stringify(url)+',date_actual:"25.11.2026 12:00",date_published:"'+date+'"';
 const parsed=(url,date)=>core.b2bIndex(anchor+field(url,date))[0].published;
 assert.equal(parsed(path+'#track','20.11.2026 17:35'),'2026-11-20T17:35+03:00');
 assert.equal(parsed('/market/other/tender-1234567/','20.11.2026 17:35'),undefined);
 assert.equal(parsed(path,'31.02.2026 17:35'),undefined);
});

test('Роснефть проверяет секцию, действующий срок и номер страницы серверной выдачи',()=>{
 const item={id:145,sectionAlias:'rosneft',statusName:'Приём заявок',title:'Перевалка грузов',dates:{datePublished:'2026-11-20T12:00:00+03:00',dateRegistrationTech:'2026-11-23T12:00:00+03:00'}};
 const html=(items,query={page:'2'})=>'<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({page:'/rosneft/procedures',query,props:{pageProps:{initialReduxState:{listingProcedures:{data:items,limitPage:1,total:2,totalPages:2,currentPage:1,status:'success'}}}}})+'</script>';
 const now=Date.parse('2026-11-22T12:00:00+03:00');
 const parsed=core.rosneftPage(html([item]),2,now);
 assert.equal(parsed.cursor,'1');
 assert.equal(parsed.rows[0].url,'https://www.tektorg.ru/rosneft/procedures/145');
 assert.deepEqual(core.rosneftPage(html([item]),2,Date.parse(item.dates.dateRegistrationTech)).rows,[]);
 assert.throws(()=>core.rosneftPage(html([item],{}),2,now));
 assert.throws(()=>core.rosneftPage(html([{...item,sectionAlias:'sale'}]),2,now));
 assert.throws(()=>core.rosneftPage(html([]),2,now));
});

test('Охрана нефтебазы с перевалкой в названии объекта не является перевалкой',()=>{
 assert.equal(core.catalogueMatch('Оказание  охранных услуг на объектах нефтебазы по хранению и перевалке нефти'),false);
 assert.equal(core.catalogueMatch('Перевалка нефти на нефтебазе'),true);
});
