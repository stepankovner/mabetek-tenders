import test from 'node:test';
import assert from 'node:assert/strict';
import {activeCount} from '../tools/otc_region.mjs';
import {readRzdPage} from '../tools/rts_catalogue.mjs';
import {runInNewContext} from 'node:vm';

test('Региональный OTC требует явно указанное число актуальных закупок',()=>{
  assert.equal(activeCount('18\nколичество опубликованных закупок\n0\nколичество актуальных закупок\n5'),0);
  assert.equal(activeCount('3\n\nколичество актуальных закупок'),3);
  assert.throws(()=>activeCount('Нет результатов'),/счётчика/);
});

test('Последняя страница РТС сверяется с полным числом результатов',()=>{
  function read(count,number,rows){
    const doc={querySelector:()=>({value:String(count)}),
      querySelectorAll:()=>Array.from({length:rows},()=>({querySelectorAll:()=>[]}))};
    return runInNewContext('('+readRzdPage.toString()+')({html:"",number})',{
      number,DOMParser:class {parseFromString(){return doc}}
    });
  }
  assert.equal(read(142,15,2).count,142);
  assert.throws(()=>read(142,15,1),/Неполная/);
  assert.throws(()=>read(142,2,9),/Неполная/);
});

test('РТС хранит позицию конкретного лота и отличает ноль витрины от цены',()=>{
  function read(price){
    const link='https://223.rts-tender.ru/supplier/auction/Trade/View.aspx?Id=123#2';
    const eis='https://zakupki.gov.ru/epz/order/notice/notice223/common-info.html?regNumber=32616599045';
    const values={
      'time[itemprop="availabilityEnds"]':'07.12.2099 11:00:00 +03:00',
      '[itemprop="price"]':price,'[itemprop="priceCurrency"]':'RUB'
    };
    const row={
      querySelector:sel=>sel.includes('PurchaseName')?{textContent:'Общая закупка'}:{getAttribute:()=>values[sel]},
      querySelectorAll:sel=>sel==='a[href]'?[link,eis].map(href=>({getAttribute:()=>href})):
        sel.includes('description')?[{textContent:'ИНН 7708503727'}]:[{textContent:' Выгрузка  вагонов '}]
    };
    const doc={querySelector:()=>({value:'1'}),querySelectorAll:()=>[row]};
    return runInNewContext('('+readRzdPage.toString()+')({html:"",number:1})',{
      URL,DOMParser:class {parseFromString(){return doc}}
    }).cards[0];
  }
  const card=read('1183790.40');
  assert.equal(card.positions[0],'Выгрузка вагонов');
  assert.equal(card.lot,'2');
  assert.equal(card.catalogue_price_rub,'1183790.40');
  assert.ok(card.eis_url.endsWith('32616599045'));
  assert.equal(read('0.00').catalogue_price_rub,undefined);
});

test('Сверка НМЦ учитывает валюту, номер лота и проверку доступа',async()=>{
  const {originalRubles,compare}=await import('../tools/check-rts-prices.mjs');
  assert.equal(originalRubles('Начальная (максимальная) цена : 1 183 790,40 (Российский рубль)'), '1183790.40');
  assert.equal(originalRubles('Стоимость услуг оператора: 14 442,24 ₽'), null);
  const cards=['1','2','3'].map(procedure=>({procedure,lot:'2',catalogue_price_rub:'9.00',
    url:'https://223.rts-tender.ru/supplier/auction/Trade/View.aspx?Id='+procedure+'#2'}));
  let visits=0;
  const page={goto:async()=>{visits++;return {status:()=>200,ok:()=>true}},
    url:()=>visits===1?cards[0].url:'https://223.rts-tender.ru/ProtectionProxy.aspx',
    locator:()=>({evaluateAll:async()=>({'1':'Начальная (максимальная) цена: 9,00 (Российский рубль)'})})};
  const result=await compare(page,cards);
  assert.equal(visits,2);
  assert.ok(result.every(x=>x.match===null));
  assert.match(result[2].reason,/проверку доступа/);
});
