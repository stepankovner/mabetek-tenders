export function identity(x) {
  if (!x.procedure || !x.lot || !x.source) throw Error('Не определён идентификатор лота');
  return JSON.stringify([x.eis?'eis':x.source,x.eis||x.procedure,String(x.lot)]);
}
export function authorized(chat,from,owner) {
  return chat?.type==='private' && Number.isSafeInteger(from) && from===chat.id && String(from)===owner;
}
export function feed(xml) {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/channel>\s*<\/rss>\s*$/i.test(xml)) throw Error('Ожидалась выдача RSS');
  function field(item,key) {
    const raw=item.match(new RegExp('<'+key+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+key+'>','i'))?.[1]||'';
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').trim();
  }
  const items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if(items.length!==(xml.match(/<item\b/gi)||[]).length) throw Error('Повреждена запись RSS');
  return items.map(([,item])=>{
    const url=field(item,'link'), title=field(item,'title');
    if(!url || !title || new URL(url).hostname!=='zakupki.gov.ru' || !url.startsWith('https://')) throw Error('Изменился формат извещения');
    return {url,title,description:field(item,'description'),published:field(item,'pubDate')};
  });
}

export function rzdCard(html,url) {
  const u = new URL(url);
  if(u.origin!=='https://rzd.rts-tender.ru' || u.pathname!=='/TenderInterests/LogViewAndRedirect' || !/^\d+$/.test(u.searchParams.get('tenderId')||'')) throw Error('Требуется карточка секции РЖД');
  const lines=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/(?:td|th|div|h[1-6]|span|li|p|a)>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').split(/\n/).map(s=>s.trim()).filter(Boolean);
  function get(key){const i=lines.findIndex(s=>s.replace(/:$/,'')===key);return i<0?'':lines[i+1]||'';}
  const title=get('Наименование'),customer=get('Заказчик');
  if(!title||!customer||!get('Площадка')) throw Error('Не распознана карточка РЖД');
  const documents=[];
  for(const [,tr] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const link=tr.match(/href=["'](https:\/\/223\.rts-tender\.ru\/files\/FileDownloadHandler\.ashx\?FileGuid=[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})["']/i)?.[1];
    const name=tr.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    if(link && /\.(?:docx?|xlsx?|pdf|zip)$/i.test(name) && !documents.some(d=>d.url===link))documents.push({name,url:link});
  }
  const registrations=new Set();
  for(const [,href] of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)){
    let apply;
    try{apply=new URL(href.replace(/&amp;/g,'&'),u);}catch{continue;}
    const number=apply.searchParams.get('registrationNumber')||'';
    if(apply.origin===u.origin && apply.pathname==='/Tenders/Apply' && apply.searchParams.get('tenderId')===u.searchParams.get('tenderId') && /^\d{11}$/.test(number))registrations.add(number);
  }
  const registration=registrations.size===1?[...registrations][0]:null;
  return {...(registration?{registration}:{}),...(documents.length?{documents}:{}),source:'rzd-rts',procedure:u.searchParams.get('tenderId'),lot:'процедура',title,customer,place:get('Место поставки'),region:get('Регион'),price:get('НМЦ'),deadline:get('Дата окончания подачи заявок'),status:get('Статус на площадке'),url:u.href};
}

// The RZD procurement section publishes its clocks in Moscow time (UTC+3).
export function rzdTime(raw) {
  const m=String(raw||'').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?:\s+МСК)?$/i);
  const unknown={original:raw,utc:null,khabarovsk:null};
  if(!m || +m[4]>23 || +m[5]>59)return unknown;
  const ms=Date.UTC(+m[3],+m[2]-1,+m[1],+m[4]-3,+m[5]);
  function local(h){
    const d=new Date(ms+h*3600000).toISOString();
    return d.slice(8,10)+'.'+d.slice(5,7)+'.'+d.slice(0,4)+' '+d.slice(11,16);
  }
  if(local(3)!==m[1]+'.'+m[2]+'.'+m[3]+' '+m[4]+':'+m[5])return unknown;
  return {original:raw,utc:new Date(ms).toISOString(),moscow:local(3),khabarovsk:local(10)};
}

export function eisOrderNumber(link) {
  return /^https:\/\/zakupki\.gov\.ru\/(?:epz\/order\/notice\/[a-z0-9]+\/(?:view\/)?common-info\.html|223\/purchase\/public\/purchase\/info\/common-info\.html)\?regNumber=(\d{11}|\d{19})$/.exec(link)?.[1]||null;
}

export function eisTime(raw) {
  const match=/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s+\(?(?:МСК)([+-]\d{1,2})?\)?$/iu.exec(raw||'');
  const unknown={original:raw,utc:null,khabarovsk:null};
  if(!match)return unknown;
  const [,day,month,year,hour,minute,shift]=match;
  const offset=3+Number(shift||0);
  if(offset<0||offset>12)return unknown;
  const wall=year+'-'+month+'-'+day+'T'+hour+':'+minute;
  const base=Date.parse(wall+':00Z');
  if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,16)!==wall)return unknown;
  const actual=base-offset*3600000;
  const local=hours=>{
    const time=new Date(actual+hours*3600000).toISOString();
    return time.slice(8,10)+'.'+time.slice(5,7)+'.'+time.slice(0,4)+' '+time.slice(11,16);
  };
  return {original:raw,utc:new Date(actual).toISOString(),moscow:local(3),khabarovsk:local(10)};
}

export function eisOrderCard(html,url) {
  const procedure=eisOrderNumber(url);
  if(!procedure)throw Error('Требуется ссылка на извещение ЕИС');
  const clean=value=>value.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;|&#xA0;/gi,' ')
    .replace(/&quot;|&#34;/gi,'"').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
  function span(source,index){
    let depth=1;
    for(const token of source.slice(index).matchAll(/<\/?span\b[^>]*>/gi)){
      depth+=token[0][1]==='/'?-1:1;
      if(depth===0)return {value:clean(source.slice(index,index+token.index)),end:index+token.index+token[0].length};
    }
    return null;
  }
  function first(className) {
    const tag=[...html.matchAll(/<span\b[^>]*class=["']([^"']*)["'][^>]*>/gi)]
      .find(item=>item[1].split(/\s+/).includes(className));
    return tag?span(html,tag.index+tag[0].length)?.value||'':'';
  }
  const visible=first('cardMainInfo__purchaseLink').replace(/^№\s*/,'');
  if(visible!==procedure)throw Error('ЕИС: номер в карточке отличается от номера ссылки');
  const fields=new Map();
  for(const label of html.matchAll(/<span\b[^>]*class=["'](?:cardMainInfo__title|section__title)(?:\s[^"']*)?["'][^>]*>([^<]*)<\/span>/gi)){
    const next=/^\s*<span\b[^>]*class=["'](?:cardMainInfo__content|section__info)(?:\s[^"']*)?["'][^>]*>/i.exec(html.slice(label.index+label[0].length));
    if(!next)continue;
    const key=clean(label[1]).toLowerCase();
    const value=span(html,label.index+label[0].length+next[0].length)?.value;
    if(value&&!fields.has(key))fields.set(key,value);
  }
  const read=(...keys)=>keys.map(key=>fields.get(key)).find(Boolean)||'';
  const title=read('объект закупки','наименование объекта закупки','наименование закупки');
  const customer=read('заказчик');
  const status=first('cardMainInfo__state')||read('этап закупки');
  if(!title||!customer||!status)throw Error('Основные поля извещения ЕИС не распознаны');
  const price=read('начальная цена').match(/^([\d ]+(?:,\d{1,2})?)\s*(?:₽|руб\.)$/i)?.[1]||'';
  const docsPath=new URL(url).pathname.replace(/common-info\.html$/,'documents.html');
  const docs=html.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>\s*Документы(?:\s+закупки)?\s*<\/a>/iu)?.[1];
  const documentsPage=docs&&[docsPath+'?regNumber='+procedure,'https://zakupki.gov.ru'+docsPath+'?regNumber='+procedure].includes(docs)
    ?new URL(docs,url).href:'';
  return {source:'eis-order',eis:procedure,procedure,lot:'процедура',title,customer,status,price,url,documentsPage,
    place:read('место поставки товара, выполнения работы или оказания услуги','место поставки товара или место выполнения работы или оказания услуги'),
    venue:read('наименование электронной площадки в информационно-телекоммуникационной сети «интернет»'),
    phone:read('номер контактного телефона'),
    deadline:read('дата и время окончания срока подачи заявок')};
}

export function b2bIndex(html) {
  const unique=new Map();
  const anchors=[...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+\/tender-(\d+)\/(?:[?#][^"']*)?)["']/gi)];
  for(const [i,a] of anchors.entries()){
    const url=new URL(a[1].replace(/&amp;/g,'&'),'https://www.b2b-center.ru');
    if(url.origin!=='https://www.b2b-center.ru' || !/^\/(?:app\/market-next|market)\//.test(url.pathname))continue;
    const block=html.slice(a.index+a[0].length,anchors[i+1]?.index??html.length);
    const raw=block.match(/<p\b[^>]*class=["'][^"']*\bpanel-procedure__dscr-main\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const title=raw?.replace(/<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&laquo;/g,'«').replace(/&raquo;/g,'»').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    const item=unique.get(a[2])||{id:a[2],url:url.origin+url.pathname};
    if(title)item.title=title;
    unique.set(a[2],item);
  }
  // The public index supplies Moscow time to the minute beside the canonical link.
  const metadata = /\burl:("(?:\\.|[^"\\])*"),date_actual:(?:"[^"]*"|\w+),date_published:"(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})"/g;
  for (const [, encoded, day, month, year, hour, minute] of html.matchAll(metadata)) {
    let url;
    try { url = new URL(JSON.parse(encoded), 'https://www.b2b-center.ru'); }
    catch { continue; }
    const item = unique.get(url.pathname.match(/\/tender-(\d+)\/$/)?.[1]);
    if (!item || item.url !== url.origin + url.pathname) continue;
    const wall = year+'-'+month+'-'+day+'T'+hour+':'+minute;
    const date = new Date(wall+'Z');
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0,16) === wall)
      item.published = wall+'+03:00';
  }
  if(!unique.size && !/(?:ничего не найдено|по вашему запросу\s+нет актуальных процедур|по вашему запросу.*не найдено)/i.test(html))throw Error('Не распознана выдача B2B-Center');
  return [...unique.values()];
}

export function b2bTitle(html,id) {
  const element = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!element || !/^\d+$/.test(id)) throw Error('Нет заголовка оригинала');
  const parts = element[1].split(/\s+[—–]\s+(?:Тендер|Закупка|Лот)\s*№\s*/i);
  if (parts.length !== 2 || parts[1].match(/^\d+/)?.[0] !== id) throw Error('Нет заголовка оригинала');
  const title = parts[0].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&laquo;/g,'«').replace(/&raquo;/g,'»').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  if (!title) throw Error('Нет заголовка оригинала');
  return title;
}

export const publicCatalogues={
  rosneft:{name:'Роснефть · ТЭК-Торг',url:'https://www.tektorg.ru/rosneft/procedures'},
  fabrikant:{name:'Фабрикант · 44-ФЗ',url:'https://44.fabrikant.ru/44/catalog/procedure'},
  otc:{name:'OTC · малые закупки',url:'https://etp.otc.ru/tenders/small/'},
  zakazrf:{name:'ЗаказРФ',url:'https://zakazrf.ru/NotificationEx'},
  rad:{name:'РАД',url:'https://gz.lot-online.ru/etp_back/procedure/list'},
  sberWorld:{name:'Сбербанк-АСТ · международная секция',url:'https://world.sberbank-ast.ru/tableForm.aspx?formCode=PurchaseList'},
  roseltorg:{name:'Росэлторг',url:'https://www.roseltorg.ru/procedures/search'},
  tektorgRzd:{name:'РЖД · ТЭК-Торг',url:'https://www.tektorg.ru/org/rzd/procedures'},
  tektorg:{name:'ТЭК-Торг',url:'https://www.tektorg.ru/procedures'},
  gpb:{name:'ЭТП ГПБ',url:'https://etpgpb.ru/procedures/'}
};

export function sberRegistry(html){
  const xml=html.replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  const rows=[];
  for(const [,block] of xml.matchAll(/<Purchase>([\s\S]*?)<\/Purchase>/g)){
    const field=key=>block.match(new RegExp('<'+key+'>([\\s\\S]*?)</'+key+'>','i'))?.[1]?.trim()||'';
    const id=field('PurchaseID'), title=field('PurchaseName'), status=field('purchStatus');
    const link=field('purchHref').replace(/&amp;(?:amp;)?/g,'&');
    if(!/^\d+$/.test(id)||link!=='/documentView.aspx?formCode=PurchaseInfo&id='+id||!title||!status)throw Error('Не распознана карточка Сбербанк-АСТ');
    rows.push({title:title.replace(/&amp;quot;|&quot;/g,'"').replace(/&amp;/g,'&'),url:'https://world.sberbank-ast.ru'+link,status});
  }
  if(!rows.length)throw Error('Не распознан реестр Сбербанк-АСТ');
  return rows;
}
export function rosneftPage(html, expectedPage=null, now=Date.now()){
  const fail=()=>{throw Error('Не распознана выдача закупок Роснефти');};
  const script=html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  let data;
  try{data=JSON.parse(script?.[1]||'');}catch{fail();}
  const listing=data?.props?.pageProps?.initialReduxState?.listingProcedures;
  // The server renders the requested page in query.page but leaves Redux currentPage at 1.
  const number=Number(data?.query?.page??1);
  if(data?.page!=='/rosneft/procedures'||listing?.status!=='success'||
     !Array.isArray(listing.data)||!Number.isSafeInteger(listing.total)||listing.total<0||
     !Number.isSafeInteger(listing.limitPage)||listing.limitPage<1||
     listing.totalPages!==Math.ceil(listing.total/listing.limitPage)||
     !Number.isSafeInteger(number)||number<1||
     (expectedPage!==null&&number!==expectedPage))fail();
  const count=Math.max(0,Math.min(listing.limitPage,listing.total-(number-1)*listing.limitPage));
  if(listing.data.length!==count)fail();
  const rows=[];
  for(const item of listing.data){
    if(item?.sectionAlias!=='rosneft'||!Number.isSafeInteger(item.id)||item.id<=0||
       typeof item.statusName!=='string'||!item.statusName.trim())fail();
    if(!/^при[её]м заявок$/iu.test(item.statusName.trim()))continue;
    const published=item.dates?.datePublished,end=item.dates?.dateEndRegistration??item.dates?.dateRegistrationTech;
    const dated=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
    if(!dated(end)||!dated(published)||typeof item.title!=='string'||!item.title.trim())fail();
    if(Date.parse(end)>now)rows.push({url:publicCatalogues.rosneft.url+'/'+item.id,title:item.title.trim(),published});
  }
  return {rows,cursor:String(number<listing.totalPages?number+1:1)};
}

export function publicIndex(source,html) {
  if(source==='rosneft')return rosneftPage(html).rows;
  if(source==='tektorgRzd' || (source==='tektorg' && html.includes('proceduresResponse'))){
    const field=(doc,tag)=>doc.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>'))?.[1]?.trim() || '';
    const list=html.match(/<procedures\s*>([\s\S]*?)<\/procedures>/);
    if(!list || field(html,'sectionCode')!==(source==='tektorgRzd'?'rzd':'zakupki'))throw Error('Не распознана секция ТЭК-Торг');
    const rows=[];
    for(const [,proc] of list[1].matchAll(/<procedure\b[^>]*>([\s\S]*?)<\/procedure>/g)){
      const url=field(proc,'url_to_showcase'), published=field(proc,'datePublished');
      if(!/^https:\/\/www\.tektorg\.ru\/223-fz\/procedures\/\d+$/.test(url))throw Error('Не распознана ссылка ТЭК-Торг');
      for(const [,lot] of proc.matchAll(/<lot\b[^>]*>([\s\S]*?)<\/lot>/g)){
        if(!/^при[её]м заявок$/i.test(field(lot,'status')))continue;
        const number=field(lot,'number'), subject=field(lot,'subject');
        if(!/^\d+$/.test(number)||!subject)throw Error('Не распознан лот ТЭК-Торг');
        const title=subject.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
        // Фрагмент различает лоты и открывает официальный оригинал процедуры.
        rows.push({url:url+'#lot-'+number,title,
          published:/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(published)?published:null});
      }
    }
    return rows;
  }
  if(source==='fabrikant'){
    const rows=[];
    let recognized=false;
    for(const [,row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const cells=new Map();
      for(const [,key,body] of row.matchAll(/<td\b[^>]*\bclass=["']row-([\w_]+)[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi))cells.set(key,body);
      if(!cells.has('procedure_number')||!cells.has('status'))continue;
      recognized=true;
      if(!/^при[её]м заявок$/i.test(cells.get('status').trim()))continue;
      const link=cells.get('procedure_name')?.match(/<a\b[^>]*href=["'](\/44\/procedure\/[a-z\d]+\/(\d{19}))(?:\?[^"']*)?["'][^>]*>([^<]+)<\/a>/i);
      if(!link || link[2]!==cells.get('procedure_number').trim())throw Error('Не распознана карточка Фабриканта');
      const raw=(cells.get('publication_datetime')||'').replace(/<[^>]+>/g,' ').trim();
      const clock=raw.match(/^(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}):(\d\d)\s*\(MSK\+00:00\)$/);
      const utc=clock && +clock[2]<60 && rzdTime(clock[1]).utc;
      rows.push({url:'https://44.fabrikant.ru'+link[1],title:link[3].replace(/&quot;/g,'"').replace(/&amp;/g,'&').trim(),
        published:utc?utc.replace(':00.000Z',':'+clock[2]+'.000Z'):null});
    }
    if(!recognized)throw Error('Не распознана выдача Фабриканта');
    return rows;
  }
  if(source==='otc'){
    const cards=html.split(/<div\b[^>]*class=["'][^"']*\bTenderItem-module_paper_[^"']*["'][^>]*>/i).slice(1);
    if(!cards.length)throw Error('Не распознана выдача OTC');
    const rows=new Map();
    for(const card of cards){
      const countdown=card.match(/class=["']TenderItem-module_salesCountdown_[^"']*["'][^>]*>\s*<span[^>]*>([^<]*)<\/span>/i);
      if(!countdown)throw Error('Не распознан срок закупки OTC');
      if(!/осталось для подачи заявки/i.test(countdown[1]))continue;
      const anchor=card.match(/<a\s+href=["'](https:\/\/etp\.otc\.ru\/tender\/\d+)["'][^>]*class=["']TenderItem-module_title_[^"']+["'][^>]*>([\s\S]*?)<\/a>/i);
      const raw=anchor?.[2].match(/<span\s+class=["']index_lotNameTitle_[^"']+["'][^>]*>([^<]+)<\/span>/i)?.[1];
      if(!raw?.trim())throw Error('Не распознан предмет закупки OTC');
      const title=raw.replace(/&quot;/gi,'"').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').trim();
      rows.set(anchor[1],{title,url:anchor[1]});
    }
    return [...rows.values()];
  }
  if(source==='zakazrf'){
    const cellText=cell=>cell.replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&quot;/gi,'"').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
    const rows=[];
    let columns=null, recognized=0;
    for(const [,body] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const headers=Array.from(body.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi),m=>cellText(m[1]));
      if(headers.length){
        const indices=['Номер закупки','Состояние закупки','Предмет закупки'].map(name=>headers.indexOf(name));
        columns=indices.every(i=>i>=0)?indices:null;
        continue;
      }
      if(!columns)continue;
      const cells=Array.from(body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),m=>m[1]);
      const [number,state,subject]=columns.map(i=>cells[i]||'');
      const href=number.match(/\bhref=["'](\/NotificationEx\/id\/\d+)["']/i)?.[1];
      if(!href)continue;
      recognized++;
      if(!/^ид[её]т подача заявок на участие$/i.test(cellText(state)))continue;
      const title=cellText(subject);
      if(!title)throw Error('Не распознан предмет закупки ЗаказРФ');
      rows.push({title,url:'https://zakazrf.ru'+href});
    }
    if(!recognized)throw Error('Не распознана выдача ЗаказРФ');
    return rows;
  }
  if(source==='rad'){
    const {status,data}=JSON.parse(html);
    if(status!==0 || !Array.isArray(data?.items) || !Number.isSafeInteger(data.count) || data.count<data.items.length)throw Error('Не распознана выдача РАД');
    const rows=[];
    for(const row of data.items){
      let url;
      if(row.direction==='44fz' && row.status==='accept'){
        if(!/^\d{19}$/.test(row.purchaseNumber))throw Error('Не распознана карточка РАД');
        url='https://gz.lot-online.ru/etp_front/procedure/view/procedure/common/'+row.purchaseNumber;
      }else if(['tender223','tender223_market'].includes(row.direction) &&
               /^ид[её]т при[её]м (?:заявок|коммерческих предложений)$/i.test(row.status)){
        const link=String(row.externalUrl||'');
        const match=link.match(/^https:\/\/tender\.lot-online\.ru\/app\/(?:section\/[a-z0-9_-]+\/)?(LotCard|SmallPurchaseCard)\/page\?(LotCard\.lotEntity=LT|SmallPurchaseCard\.smallPurchaseEntity=MT)%3A([a-z0-9]+)$/i);
        if(!match || !match[2].startsWith(match[1]+'.') || match[3]!==row.lotId)continue;
        url=link;
      }else continue;
      if(typeof row.purchaseObjectInfo!=='string'||!row.purchaseObjectInfo.trim())throw Error('Не распознан предмет закупки РАД');
      rows.push({url,title:row.purchaseObjectInfo.trim()});
    }
    return rows;
  }
  if(source==='sberWorld')return sberRegistry(html).filter(r=>/^(?:Bids submission|Submission of bids|Accepting bids)$/i.test(r.status));

  const catalogue=publicCatalogues[source];
  const found=new Map();
  for(const [,attrs,body] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const href=attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if(!href)continue;
    let url;
    try{url=new URL(href,catalogue.url);}catch{continue;}
    if(url.protocol!=='https:'||url.username||url.password||url.port)continue;
    if(source==='roseltorg' && !(url.hostname==='www.roseltorg.ru' && /^\/procedure\/[\w-]+(?:\/\d+)?\/?$/.test(url.pathname) && attrs.includes('search-results__link--description')))continue;
    if(source==='tektorg' && !(url.hostname==='www.tektorg.ru' && /^\/(?:org\/[\w-]+\/)?procedures\/\d+\/?$/.test(url.pathname)))continue;
    if(source==='gpb' && !(/^([a-z0-9-]+\.)?etpgpb\.ru$/.test(url.hostname) && /^\/front\/procedure\/view\/[\da-f-]+\/?$/i.test(url.pathname) && attrs.includes('vTitle')))continue;
    const title=body.replace(/<!--[\s\S]*?-->|<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&laquo;/g,'«').replace(/&raquo;/g,'»').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    if(title.length<5 || /^№\s*[\w-]+$/.test(title))continue;
    const canonical=url.origin+url.pathname;
    found.set(canonical,{url:canonical,title});
  }
  if(!found.size)throw Error('Не распознана выдача '+catalogue.name);
  return [...found.values()];
}

export function serviceMatch(subject){
  const normal=subject.toLowerCase().replace(/ё/g,'е').replace(/ж\s*[/.-]\s*д/g,'жд')
    .replace(/(?:без(?:\s+учета)?|за\s+исключением)\s+погрузочно[-\s]разгрузочных\s+(?:работ|услуг)(?=[^а-я]|$)/gu,' ');
  const handling=/(?:выгруз|разгруз|погруз|перегруз|раскрыти).{0,60}(?:вагон|груз)|перевалк|погрузочно[-\s]разгрузоч|(?:прием|постановк).{0,35}(?:вагон|железнодорожн.{0,12}транспорт)|площадк.{0,24}перегруз/u;
  if(handling.test(normal))return true;
  if(/ремонт|строительств|реконструкц/u.test(normal))return false;
  return /(?:аренд|предоставлен).{0,45}тупик|тупик.{0,25}исполнител|пут[а-яь]{1,4} необщего пользования|хранени.{0,30}(?:с жд|с железнодорож)|(?:склад|площадк).{0,40}подъездн.{0,15}пут/u.test(normal);
}

export function roseltorgCard(html,input){
  const url=new URL(input);
  const path=url.pathname.match(/^\/procedure\/([\w-]+)\/(\d+)\/?$/);
  if(url.origin!=='https://www.roseltorg.ru'||!path)throw Error('Требуется ссылка на конкретный лот Росэлторга');
  const [,procedure,lot]=path;
  const starts=[...html.matchAll(/<div\b[^>]*class=["'][^"']*\blot-page__left-column-lot\b[^"']*["'][^>]*>/gi)];
  const index=starts.findIndex(m=>m[0].includes('data-feature-favorite-lots-procedure-number="'+procedure+'"')&&m[0].includes('data-feature-favorite-lots-lot-number="'+lot+'"'));
  if(index<0)throw Error('Лот не найден в оригинале');
  const tail=html.slice(starts[index].index+starts[index][0].length);
  let depth=1,end=-1;
  for(const tag of tail.matchAll(/<\/?div\b[^>]*>/gi)){
    depth+=tag[0][1]==='/'?-1:1;
    if(depth===0){end=tag.index;break;}
  }
  if(end<0)throw Error('Неполный блок лота');
  const block=tail.slice(0,end);
  const clean=(s='')=>s.replace(/<[^>]+>/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
  const title=clean(block.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1]);
  const customer=clean(block.match(/class="[^"]*js-seo-customer-name[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  const rawPlace=clean(block.match(/class="lot-delivery__text[^"]*"[^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  if(!title)throw Error('Предмет лота не распознан');
  const amount=block.match(/class="lot-item__sum lot-price"[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'';
  const price=/itemprop="priceCurrency"\s+content="RUB"/.test(amount)?(amount.match(/itemprop="price"\s+content="([\d ]+(?:\.\d{1,2})?)"/)?.[1]||'').replace('.',','):'';
  const registration=clean(block.match(/class="lot-start-registration lot-card-info"[^>]*>([\s\S]*?<\/div>\s*<div[^>]*>[\s\S]*?)<\/div>/i)?.[1]);
  const clock=registration.match(/до\s+(\d{2}\.\d{2}\.)(\d{2}|\d{4})\s+(\d{2}:\d{2})\s*\(МСК\)/i);
  const deadline=clock?clock[1]+(clock[2].length===2?'20':'')+clock[2]+' '+clock[3]+' МСК':'';
  const badge=clean(block.match(/class="lot-status lot-status--[\w-]+"[^>]*>(?:\s*<div[^>]*><\/div>)?([\s\S]*?)<\/div>/i)?.[1]);
  const status=badge.match(/При[её]м заявок|Процедура завершена|Процедура отменена|Работа комиссии|Приостановлена/i)?.[0]||'';
  return {source:'roseltorg',procedure,lot,title,customer,place:/[а-я\d]/i.test(rawPlace)?rawPlace:'',region:'',price,deadline,status,url:url.origin+url.pathname};
}

export const construction=/^(?:устройство|ремонт|строительство|реконструкция|поставка запасных частей)(?:\s|$)/iu;
export function infrastructureOnly(title){
  const subject=title.toLowerCase().replace(/^окпд(?:2|\s*2)?\s*[\d.]+[.:\s]*/u,'').trim();
  const trackMaintenance=/^(?:оказание услуг по |работы по )?(?:текущ(?:ее|ему) )?содержани(?:е|ю) (?:железнодорожных|ж\/д) путей/u.test(subject);
  const demolition=/^(?:выполнение комплекса работ[:\s]+)?(?:1[.)]\s*)?демонтаж здания склада/u.test(subject);
  if(trackMaintenance || demolition){
    return !/(?:при[её]м|выгрузк|погрузк|постановк|перевалк|аренд|предоставлени)[а-яё]*\s+(?:[а-яё-]+\s+){0,3}(?:вагон|груз|тупик|пут)/u.test(subject);
  }
  // These words describe sale of the asset or preparation of engineering documentation.
  return /^продажа\s+железнодорожных путей(?:\s|[.,;:]|$)/u.test(subject) ||
    /^(?:оказание услуг по разработке|разработка)\s+инструкции о порядке обслуживания движения/u.test(subject);
}
export function catalogueMatch(title){
  // Project names after these phrases describe the buyer's facility.
  const subject=title.toLowerCase().split(/(?:для нужд|в рамках проекта|рамках проекта|для проекта|для объекта)/u)[0].trim();
  if(/^(?:оказание\s+)?охранных\s+услуг\s+на\s+объект/iu.test(subject))return false;
  const otherService=/(?:контролю за техническим состоянием|очистке от снега|предоставлению спецтехники и автотранспорта)/u;
  if(infrastructureOnly(title)||otherService.test(subject)||construction.test(subject))return false;
  if(/^поставка\s/u.test(subject)&&!/(?:с оказанием услуг|и оказание услуг|и услуги)\s/u.test(subject))return false;
  // Food provision is the primary contract. Logistics listed in parentheses describe fulfilment.
  const foodProvision=/^обеспечение\s+продуктами\s+питания\s*\(\s*поставка\s*[,)]/u;
  if(foodProvision.test(subject))return false;
  return serviceMatch(subject);
}
