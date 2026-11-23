import {draftWord,supportsForm,verifyOriginal} from './rzd-form';
import {rankNotices} from './semantic';
import {b2b,publicPoll,macCatalogue,noticeStatements,queueEisNotice,confirmLocation} from './monitor';
import {setup} from './setup';
import {questions,validate,offer} from './dialog';
// Cloudflare Worker. Aggregate RSS announcements stay separate from verified lots.
import { parseCard, pendingCardUrl, readCard } from './card';
import { authorized, feed, identity, eisTime, eisOrderNumber, rzdTime, publicCatalogues, catalogueMatch } from './core.mjs';

interface Statement {
  bind(...args:unknown[]):Statement;
  first<T=Record<string,any>>():Promise<T|null>;
  all():Promise<{results:Record<string,any>[]}>;
  run():Promise<unknown>;
}
interface Env {
  DB:{prepare(sql:string):Statement;batch(sql:Statement[]):Promise<{meta:{changes:number}}[]>};
  SCAN_DAILY_LIMIT?:string; SCAN_COMMAND_RESERVE?:string; RELEASE?:string; AI?:{run:Function}; WEBHOOK_SECRET:string; BOT_TOKEN:string; AGENT_KEY:string;
}
const help='/watch ссылка — открыть извещение ЕИС, РЖД или лот Росэлторга\n/status — источники и Mac\n/sources — ссылки для ручного поиска\n/check — запросить обход\n/inbox — последние извещения\n/settings — управление агентом\n/semantic — смысловая подборка';
const now=()=>Math.floor(Date.now()/1000);
const sql=(e:Env,s:string,...p:unknown[])=>e.DB.prepare(s).bind(...p);
const response=(body:unknown,status=200)=>Response.json(body,{status});
function splitReply(text:string){
  const parts:string[]=[];
  while(text.length>3800){
    let end=text.lastIndexOf('\n',3800);
    if(end<1900)end=3800;
    if(/[\uD800-\uDBFF]/.test(text[end-1]))end--;
    parts.push(text.slice(0,end));
    text=text.slice(end).replace(/^\n/,'');
  }
  parts.push(text);
  return parts;
}
async function localHealth(e:Env){
  const row=await sql(e,"SELECT value FROM profile WHERE key='agent.telemetry'").first();
  try{return row?JSON.parse(row.value):null;}catch{return null;}
}
async function checkAgentHealth(e:Env){
  const agent=await sql(e,'SELECT seen,paused FROM agent_state WHERE id=1').first();
  if(!agent?.seen||agent.paused||agent.seen>now()-1200)return;
  await sql(e,"INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,o.id,? FROM owner o CROSS JOIN agent_state a WHERE a.id=1 AND a.seen=? AND a.paused=0 AND a.seen<=unixepoch()-1200",
    'mac-offline/'+agent.seen,JSON.stringify({text:'Mac не выходит на связь более 20 минут. Сбор с Mac и подготовка документов задержаны. Облачный поиск продолжает работу на доступных площадках. Проверьте, что Mac включён, подключён к сети и выполнен вход в macOS. Состояние: /status.'}),agent.seen).run();
}
async function deliveryStats(e:Env) {
  // Один снимок D1 для обоих распределений, включая случаи без времени публикации.
  return sql(e,`WITH recent AS (
    SELECT sent,queued,published FROM delivery_observations WHERE sent>=unixepoch()-604800
  ), queue AS (
    SELECT sent-queued AS seconds, row_number() OVER (ORDER BY sent-queued) AS pos,
           count(*) OVER () AS n FROM recent WHERE queued<=sent
  ), full_delay AS (
    SELECT sent-published AS seconds, row_number() OVER (ORDER BY sent-published) AS pos,
           count(*) OVER () AS n FROM recent WHERE published<=sent
  ) SELECT (SELECT count(*) FROM recent) AS total,
           (SELECT count(*) FROM full_delay) AS dated,
           (SELECT seconds FROM full_delay WHERE pos=(95*n+99)/100) AS publication_p95_seconds,
           (SELECT count(*) FROM queue) AS queued,
           (SELECT seconds FROM queue WHERE pos=(95*n+99)/100) AS queue_p95_seconds`).first();
}
async function hash(s:string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function same(a:string|null,b:string) {
  return Boolean(a && b && await hash(a)===await hash(b));
}
async function poll(e:Env) {
  const source=await sql(e,"UPDATE sources SET next_at=unixepoch()+900 WHERE id='eis' AND next_at<=unixepoch() RETURNING *").first();
  if(!source)return;
  let delay=900;
  try {
    const url=new URL(source.url);
    url.searchParams.set('searchString','железнодорожный');
    url.searchParams.set('pageNumber',String(Number(source.cursor)||1));
    url.searchParams.set('recordsPerPage','_10');
    const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
    if(res.status===429) {
      const after=res.headers.get('retry-after')||'';
      delay=Math.max(900, Number(after)||Math.ceil((Date.parse(after)-Date.now())/1000)||900);
    }
    if(!res.ok)throw Error('HTTP '+res.status);
    const reader=res.body!.getReader(), decoder=new TextDecoder();
    let xml='', bytes=0;
    for(;;){
      const part=await reader.read();if(part.done)break;
      bytes+=part.value.length;
      if(bytes>1048576){await reader.cancel();throw Error('Превышен размер RSS');}
      xml+=decoder.decode(part.value,{stream:true});
    }
    const rows=feed(xml+decoder.decode());
    const next=rows.length>=10?String((Number(source.cursor)||1)+1):'1';
    const batch=rows.map((r:any)=>sql(e,'INSERT INTO notices(url,title,description,published) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,published=excluded.published,updated=unixepoch() WHERE title!=excluded.title OR description!=excluded.description',r.url,r.title,r.description,r.published));
    for(const notice of rows.filter(r=>catalogueMatch(r.title)).slice(0,2)){
      const location=await confirmLocation(notice);
      if(!location)continue;
      const message='ЕИС · закупка в Хабаровске\n'+notice.title.slice(0,600)+'\n'+location+'\n'+notice.url;
      batch.push(queueEisNotice(e,notice.url,JSON.stringify({text:message,location})));
    }
    batch.push(sql(e,"UPDATE sources SET last_ok=unixepoch(),cursor=?,last_error=NULL WHERE id='eis'",next));
    await e.DB.batch(batch);
  } catch(err) {
    const detail=err instanceof Error && /^(HTTP \d+|Ожидалась|Превышен|Изменился|Повреждена)/.test(err.message)?err.message:'Нет доступа к публичной выдаче';
    await sql(e,"UPDATE sources SET last_error=?,next_at=unixepoch()+? WHERE id='eis'",detail,delay).run();
  }
}
function scanBudget(e:Env){
  function setting(raw:string|undefined,fallback:number){
    return raw!==undefined && /^\d{1,6}$/.test(raw)?Number(raw):fallback;
  }
  const limit=setting(e.SCAN_DAILY_LIMIT,112);
  return {limit,reserve:Math.min(limit,setting(e.SCAN_COMMAND_RESERVE,16))};
}
async function pollAll(e:Env,background=false){
  const {limit,reserve}=scanBudget(e);
  const daily=await sql(e,"INSERT INTO scan_usage(day,total,background) SELECT date('now'),1,? WHERE ?>0 AND (?=0 OR ?>0) ON CONFLICT(day) DO UPDATE SET total=total+1,background=background+excluded.background WHERE total<? AND (?=0 OR background<?) RETURNING total",Number(background),limit,Number(background),limit-reserve,limit,Number(background),limit-reserve).first();
  if(!daily)return false;
  await Promise.all([poll(e),b2b(e),publicPoll(e,'roseltorg'),publicPoll(e,'tektorg'),publicPoll(e,'tektorgRzd'),publicPoll(e,'rosneft'),publicPoll(e,'gpb'),publicPoll(e,'sberWorld'),publicPoll(e,'rad'),publicPoll(e,'zakazrf'),publicPoll(e,'otc'),publicPoll(e,'fabrikant'),checkWatchedRzd(e)]);
  return true;
}
async function retryDelay(r:Response){
  if(r.status!==429)return null;
  const body=await r.json().catch(()=>null) as any;
  if(body?.ok!==false || body.error_code!==429)return null;
  const delay=body.parameters?.retry_after;
  return Number.isSafeInteger(delay) && delay>0 ? delay : 60;
}
function cooldown(e:Env,seconds:number){
  return sql(e,'INSERT INTO telegram_cooldown(id,until_ts) VALUES(1,unixepoch()+?) ON CONFLICT(id) DO UPDATE SET until_ts=max(until_ts,excluded.until_ts)',seconds);
}
async function telegramSend(e:Env,method:'sendMessage'|'sendDocument',body:string|FormData){
  try{
    return await fetch('https://api.telegram.org/bot'+e.BOT_TOKEN+'/'+method,{
      method:'POST',body,headers:typeof body==='string'?{'Content-Type':'application/json'}:undefined,
      signal:AbortSignal.timeout(10000)
    });
  }catch{
    // The request may have reached Telegram. The database already records uncertainty.
    return null;
  }
}
async function telegramResult(response:Response|null){
  const ack=response&&!response.bodyUsed?await response.json().catch(()=>null):null;
  if(response?.ok&&ack?.ok===true&&Number.isSafeInteger(ack.result?.message_id))return {state:'sent' as const,ack:ack.result};
  if(response&&[400,401,403,404].includes(response.status)&&ack?.ok===false&&ack.error_code===response.status)
    return {state:'failed' as const};
  return {state:'uncertain' as const};
}
async function deliver(e:Env) {
  for(let n=0;n<5;n++){
    // Persist uncertainty before sending. Never resend a possible successful delivery automatically.
    const m=await sql(e,"UPDATE outbox SET state='uncertain' WHERE id=(SELECT id FROM outbox WHERE state='ready' AND NOT EXISTS(SELECT 1 FROM telegram_cooldown WHERE until_ts>unixepoch()) ORDER BY id LIMIT 1) RETURNING *").first();
    if(!m)return;
    const {location,...payload}=JSON.parse(m.payload);
    const key=String(m.dedupe);
    const source=key.startsWith('eis/')?'eis':key.startsWith('b2b/')?'b2b':key.startsWith('https://')?'catalogue':null;
    if(source&&!location){
      await sql(e,"UPDATE outbox SET state='suppressed' WHERE id=? AND state='uncertain'",m.id).run();
      continue;
    }
    let r:Response|null;
    if(payload.word){
      const {lot,vat}=payload.word;
      const test=payload.word.deliveryTest===true;
      const draft=draftWord(lot,vat,test),form=new FormData();
      form.set('chat_id',m.owner);form.set('document',draft.file,test?'Mabetek-delivery-test.docx':'RZD-32616584495-'+(lot?'lot-'+lot:'blank')+'.docx');
      form.set('caption',test?'Тест доставки DOCX. Лот и ставка НДС учебные. Для подачи не используется.':(payload.word.cached?'Бланк из ранее проверенной копии приложения. Сверьте его с оригиналом перед подачей. ':'')+'Черновик технического предложения РЖД. '+(draft.filled?'Ставка НДС перенесена из ваших условий.':'Поле ставки НДС оставлено пустым. Подтвердите его заполнение вручную.')+(lot?'':' Впишите номер лота из извещения.')+' Проверьте пункт 1 о полном соответствии ТЗ и место оказания услуг до подачи. Сведения об участнике, персонале и согласия оформляются отдельно.');
      r=await telegramSend(e,'sendDocument',form);
    }else{
      r=await telegramSend(e,'sendMessage',JSON.stringify({chat_id:m.owner,...payload}));
    }
    const delay=r?await retryDelay(r):null;
    if(delay!==null){
      await e.DB.batch([cooldown(e,delay),sql(e,"UPDATE outbox SET state='ready' WHERE id=? AND state='uncertain'",m.id)]);
      return;
    }
    const result=await telegramResult(r);
    if(result.state==='failed'){
      await sql(e,"UPDATE outbox SET state='failed' WHERE id=? AND state='uncertain'",m.id).run();
    }
    if(result.state!=='sent')continue;
    const ack=result.ack;
    const changes=[sql(e,"UPDATE outbox SET state='sent',message_id=? WHERE id=?",ack.message_id,m.id)];
    if(source && Number.isSafeInteger(ack.date)){
      let published=null;
      const noticeUrl=source==='b2b'?String(payload.text||'').trim().split('\n').pop():source==='eis'?key.slice(4):key;
      const notice=await sql(e,'SELECT published FROM notices WHERE url=?',noticeUrl).first();
      const raw=notice?.published||'';
      if(/(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim())){
        const t=Math.floor(Date.parse(raw)/1000);
        if(Number.isFinite(t)&&t<=ack.date)published=t;
      }
      changes.push(sql(e,'INSERT OR IGNORE INTO delivery_observations VALUES(?,?,?,?,?)',m.id,source,m.created,ack.date,published));
    }
    await e.DB.batch(changes);
  }
}
async function checkWatchedRzd(e:Env){
  const source='watch/rzd';
  await sql(e,'INSERT OR IGNORE INTO sources(id,url) VALUES(?,?)',source,'https://rzd.rts-tender.ru/').run();
  const lease=await sql(e,'UPDATE sources SET next_at=unixepoch()+900 WHERE id=? AND next_at<=unixepoch() RETURNING cursor',source).first();
  if(!lease)return;
  const row=await sql(e,`SELECT l.id,l.revision,v.payload FROM links k JOIN lots l ON l.id=k.lot
    JOIN versions v ON v.lot=l.id AND v.revision=l.revision
    WHERE k.source='rzd-rts' AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.lot=l.id AND d.revision=l.revision)
    ORDER BY (l.id>?) DESC,l.id LIMIT 1`,Number(lease.cursor)||0).first();
  if(!row)return;
  try{
    const old=JSON.parse(row.payload);
    const card=await readCard(old.url);
    if(card.source!=='rzd-rts'||identity(card)!==identity(old))throw Error('identity');
    await saveCard(e,card,row.revision);
    await sql(e,'UPDATE sources SET cursor=?,last_ok=unixepoch(),last_error=NULL WHERE id=?',String(row.id),source).run();
  }catch{
    await sql(e,'UPDATE sources SET cursor=?,last_error=? WHERE id=?',String(row.id),'Проверка отслеживаемого оригинала РЖД не завершилась',source).run();
  }
}
async function saveCard(e:Env,c:any,watchedRevision?:number){
  const key=identity(c),payload=JSON.stringify(c),digest=await hash(payload);
  const previous=await sql(e,'SELECT l.id,l.revision,v.digest,v.payload FROM lots l JOIN versions v ON l.id=v.lot AND l.revision=v.revision WHERE l.canonical=?',key).first();
  if(previous?.digest===digest)return previous;
  const revision=(previous?.revision||0)+1;
  const notifications:Statement[]=[];
  if(watchedRevision!==undefined){
    if(previous?.revision!==watchedRevision)throw Error('Карточка уже обновилась');
    const old=JSON.parse(previous.payload);
    const labels:Record<string,string>={title:'Предмет',customer:'Заказчик',status:'Статус',place:'Место',region:'Регион',price:'Цена',deadline:'Срок',registration:'Регистрационный номер'};
    const changes=Object.entries(labels).filter(([key])=>old[key]!==c[key])
      .map(([key,label])=>label+': '+String(old[key]||'не указано').slice(0,120)+' → '+String(c[key]||'не указано').slice(0,120));
    const documents=(card:any)=>(card.documents||[]).map((d:any)=>JSON.stringify([d.name,d.url])).sort();
    if(JSON.stringify(documents(old))!==JSON.stringify(documents(c)))changes.push('Изменился список приложений');
    if(!changes.length)return previous;
    const message={text:'Изменение в отслеживаемой закупке РЖД\n'+changes.join('\n')+'\n'+c.url};
    notifications.push(sql(e,'INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner',
      'revision/'+previous.id+'/'+revision,JSON.stringify(message)));
  }
  // A concurrent write conflicts on the version and rolls back the entire batch.
  await e.DB.batch([
    sql(e,"INSERT INTO lots(canonical,procedure_no,lot_no,revision,deadline,status) VALUES(?,?,?,?,?,?) ON CONFLICT(canonical) DO UPDATE SET revision=excluded.revision,deadline=excluded.deadline,status=excluded.status WHERE lots.revision=excluded.revision-1",key,c.procedure,c.lot,revision,c.deadline,c.status),
    sql(e,'INSERT INTO versions SELECT id,?,?,?,unixepoch() FROM lots WHERE canonical=?',revision,digest,payload,key),
    sql(e,'INSERT OR IGNORE INTO links SELECT id,?,? FROM lots WHERE canonical=?',c.source,c.url,key),
    sql(e,"UPDATE offers SET state='устарело' WHERE lot=(SELECT id FROM lots WHERE canonical=?)",key),
    ...notifications
  ]);
  return (await sql(e,'SELECT id,revision FROM lots WHERE canonical=?',key).first())!;
}
const decisionKeys=(id:number,v:number)=>({inline_keyboard:[[{text:'Уточнить условия',callback_data:'/terms '+id+' '+v},{text:'Не подходит',callback_data:'/reject '+id+' '+v}]]});
function cardTime(c:any){
  return c?.source==='eis-order'?eisTime(c.deadline):rzdTime(c?.deadline);
}
function acceptingCard(c:any){
  const deadline=cardTime(c).utc;
  const status=String(c?.status||'').trim().replace(/ё/gi,'е');
  return Boolean(deadline&&Date.parse(deadline)>Date.now()
    && /^(?:прием|подача) заявок(?: на участие)?$/i.test(status));
}
function cardMessage(c:any,lot:any){
  const time=cardTime(c);
  const text=[c.title.slice(0,700),c.customer?.slice(0,400)||'Заказчик не указан',
    ...(c.source==='eis-order'?['Извещение ЕИС № '+c.procedure,'Площадка: '+(c.venue?.slice(0,200)||'не указано'),'Контакт: '+(c.phone?.slice(0,150)||'не указано')]:[]),
    'Статус: '+(c.status?.slice(0,180)||'не указано'),'Место: '+(c.place?.slice(0,650)||'не указано'),
    (c.source==='roseltorg'?'Цена лота в карточке: ':'НМЦ заказчика: ')+(c.price?c.price+' руб.':'не указано'),
    'Срок: '+(time.utc?time.moscow+' МСК / '+time.khabarovsk+' Хабаровск':c.deadline?.slice(0,120)||'не указано'),
    'Требуют уточнения: место исполнения и доступность площадки.'].join('\n');
  const reply_markup={inline_keyboard:[[{text:'Оригинал',url:c.url},{text:'Документы',callback_data:'/documents '+lot.id+' '+lot.revision}],[{text:'Разобрать',callback_data:'/analyze '+lot.id+' '+lot.revision}],...decisionKeys(lot.id,lot.revision).inline_keyboard]};
  return {text,reply_markup};
}
async function telegram(req:Request,e:Env){
  if(!await same(req.headers.get('X-Telegram-Bot-Api-Secret-Token'),e.WEBHOOK_SECRET))return response({},403);
  const u=await req.json() as any, cb=u.callback_query;
  const msg=cb?{chat:cb.message?.chat,from:cb.from,text:cb.data}:u.message, id=msg?.from?.id;
  if(!Number.isSafeInteger(u.update_id)||!Number.isSafeInteger(id)||msg?.chat?.type!=='private'||msg.chat.id!==id)return response({});
  const text=String(msg.text||''), user=String(id);
  if(text.startsWith('/start ') && text.length<150){
    const digest=await hash(text.slice(7).trim());
    await e.DB.batch([
      sql(e,'INSERT OR IGNORE INTO owner(id) SELECT ? FROM pairing WHERE digest=? AND expires>unixepoch()',user,digest),
      sql(e,'DELETE FROM pairing WHERE digest=?',digest)
    ]);
  }
  const owner=await sql(e,'SELECT id FROM owner').first();
  if(!authorized(msg.chat,id,owner?.id))return response({});
  if(cb?.id) await fetch('https://api.telegram.org/bot'+e.BOT_TOKEN+'/answerCallbackQuery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callback_query_id:cb.id}),signal:AbortSignal.timeout(5000)}).catch(()=>undefined);
  if(await sql(e,'SELECT 1 FROM updates WHERE id=?',u.update_id).first())return response({});
  let reply=help;
  let markup:unknown=undefined;
  const mutations:Statement[]=[];
  const session=await sql(e,'SELECT s.*,v.payload,l.revision AS current FROM sessions s JOIN lots l ON l.id=s.lot JOIN versions v ON v.lot=s.lot AND v.revision=s.revision WHERE s.owner=?',user).first();

  const fields=async(id:number,v:number)=>Object.fromEntries((await sql(e,'SELECT field,value FROM answers WHERE owner=? AND lot=? AND revision=?',user,id,v).all()).results.map(r=>[r.field,r.value]));

  switch(text.split(' ')[0]){
    case '/ros':case '/watch':case '/notice':{
      let input=text.startsWith('/ros ')?'https://www.roseltorg.ru/procedure/'+text.slice(5).trim():text.slice(7).trim();
      if(text.startsWith('/notice ')){
        const notice=/^\d{1,16}$/.test(input)?await sql(e,'SELECT url FROM notices WHERE rowid=?',input).first():null;
        if(typeof notice?.url!=='string'||!eisOrderNumber(notice.url)){reply='Карточка ЕИС больше не доступна в текущей подборке.';break;}
        input=notice.url;
      }
      try{
        const c=await readCard(input), lot=await saveCard(e,c);
        if(c.source==='rzd-rts' && 'documents' in c && c.documents?.length){
          mutations.push(sql(e,"INSERT OR IGNORE INTO jobs(lot,revision,op) VALUES(?,?,'analysis')",lot.id,lot.revision));
        }
        const message=cardMessage(c,lot);
        reply=message.text;markup=message.reply_markup;
      }catch{
        const fallback=pendingCardUrl(input);
        if(fallback){
          mutations.push(sql(e,'INSERT INTO pending_cards(url,owner,request_id) VALUES(?,?,?) ON CONFLICT(url) DO NOTHING',fallback,user,u.update_id));
          reply='Cloudflare не смог открыть лот. Проверка передана на Mac. Результат придёт в этот чат.';
        }else reply='Не удалось прочитать оригинал закупки. Проверьте ссылку или доступность источника.';
      }
      break;
    }
    case '/documents':{
      const [,id,revision]=text.split(' ');
      const row=await sql(e,'SELECT x.payload FROM versions x JOIN lots l ON l.id=x.lot AND l.revision=x.revision WHERE x.lot=? AND x.revision=?',id||'',revision||'').first();
      if(!row){reply='Откройте актуальную карточку.';break;}
      const stored=JSON.parse(row.payload);
      if(stored.source==='eis-order'){
        reply=stored.documentsPage?'Вкладка с приложениями на ЕИС. Проверьте актуальный комплект в оригинале.':'Список приложений доступен для проверки в оригинале ЕИС.';
        markup={inline_keyboard:[[{text:stored.documentsPage?'Документы ЕИС':'Оригинал ЕИС',url:stored.documentsPage||stored.url}]]};
        break;
      }
      try{
        const current=await readCard(stored.url);
        const docs='documents' in current?current.documents||[]:[];
        const links:any[][]=docs.slice(0,30).map((d:any)=>[{text:d.name.slice(0,60),url:d.url}]);
        if(supportsForm(current))links.push([{text:'Пустой бланк технического предложения Word',callback_data:'/blank '+id+' '+revision}]);
        links.push([{text:'Все документы в оригинале',url:stored.url}]);
        reply=docs.length?'Приложения к извещению: '+docs.length:'На странице не найдены ссылки на приложения.';
        markup={inline_keyboard:links};
      }catch{reply='Приложения временно недоступны.';markup={inline_keyboard:[[{text:'Оригинал',url:stored.url}]]};}
      break;
    }
    case '/terms':case '/reject':case '/restore':{
      const [action,id,v]=text.split(' ');
      const row=await sql(e,'SELECT id FROM lots WHERE id=? AND revision=?',id||'',v||'').first();
      if(!row){reply='Откройте актуальную карточку.';break;}
      if(action==='/restore'){
        mutations.push(sql(e,'DELETE FROM decisions WHERE owner=? AND lot=? AND revision=?',user,id,v));reply='Лот восстановлен.';break;
      }
      const stop=await sql(e,'SELECT reason FROM decisions WHERE owner=? AND lot=? AND revision=?',user,id,v).first();
      if(stop && action==='/terms'){reply='Подготовка остановлена: '+stop.reason;markup={inline_keyboard:[[{text:'Восстановить',callback_data:'/restore '+id+' '+v}]]};break;}
      const values=await fields(Number(id),Number(v));
      const missing=questions.find(([k])=>!values[k])||questions[0];
      const field=action==='/reject'?'reject':missing[0];
      mutations.push(sql(e,'INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)',user,id,v,field));
      reply=field==='reject'?'Почему лот не подходит?':missing[1];break;
    }
    case '/testword':{
      const payload={word:{lot:'1',vat:'20%',deliveryTest:true}};
      mutations.push(sql(e,'INSERT OR IGNORE INTO outbox(dedupe,owner,payload) VALUES(?,?,?)','testword/'+user+'/'+u.update_id,user,JSON.stringify(payload)));
      reply='Проверка доставки тестового Word.';
      break;
    }
    case '/blank':{
      const [,id,v]=text.split(' ');
      const row=await sql(e,'SELECT x.payload FROM versions x JOIN lots l ON l.id=x.lot AND l.revision=x.revision WHERE x.lot=? AND x.revision=?',id||'',v||'').first();
      const card=row && JSON.parse(row.payload);
      if(!card || !supportsForm(card)){reply='Откройте документы актуальной карточки.';break;}
      try{
        if(!supportsForm(await readCard(card.url)))throw Error();
        const source=await verifyOriginal();
        if(source==='changed')throw Error();
        mutations.push(sql(e,'INSERT OR IGNORE INTO outbox(dedupe,owner,payload) VALUES(?,?,?)','blank/'+user+'/'+id+'/'+v,user,JSON.stringify({word:{lot:'',vat:'',cached:source==='unavailable'}})));
        reply='Пустой бланк для этой версии закупки выдаётся один раз. Заполненная форма доступна после сводки условий.';
      }catch{reply='Оригинал формы не удалось подтвердить. Повторите запрос позже.';}
      break;
    }
    case '/word':case '/transfer':{
      const [,lot,v]=text.split(' ');
      const row=await sql(e,'SELECT x.payload FROM lots l JOIN versions x ON x.lot=l.id AND x.revision=l.revision WHERE l.id=? AND l.revision=?',lot||'',v||'').first();
      if(!row){reply='Карточка обновилась. Откройте текущую версию.';break;}
      if(await sql(e,'SELECT 1 FROM decisions WHERE owner=? AND lot=? AND revision=?',user,lot,v).first()){reply='Подготовка лота остановлена.';break;}
      try{
        const card=JSON.parse(row.payload);
        const answers=await fields(Number(lot),Number(v)), info=offer(card,answers);
        const signature=(await hash(JSON.stringify(info.data))).slice(0,16);
        if(text.startsWith('/word ')){
          if(text.split(' ')[3]!==signature || !supportsForm(card)){reply='Откройте актуальную сводку условий.';break;}
          const current=await readCard(card.url);
          const source=await verifyOriginal();
          if(JSON.stringify(current)!==JSON.stringify(card)||source==='changed'){reply='Не удалось подтвердить исходную форму. Откройте оригинал и проверьте приложения.';break;}
          const draft=draftWord(answers.verified,answers.vat);
          const dedupe='word/'+user+'/'+lot+'/'+v+'/'+signature;
          const previous=await sql(e,'SELECT state FROM outbox WHERE dedupe=?',dedupe).first();
          if(previous){reply=previous.state==='sent'?'Эта версия формы уже отправлена в чат.':'Эта версия формы уже поставлена на отправку. Проверьте историю чата.';break;}
          mutations.push(sql(e,'INSERT OR IGNORE INTO outbox(dedupe,owner,payload) VALUES(?,?,?)',dedupe,user,JSON.stringify({word:{lot:answers.verified,vat:answers.vat,cached:source==='unavailable'}})));
          reply=draft.filled?'Подготовлен черновик Word со ставкой из ваших условий.':'Подготовлен черновик Word. Требуется ручное заполнение поля НДС.';
          break;
        }
        if(supportsForm(card))markup={inline_keyboard:[[{text:'Получить черновик формы Word',callback_data:'/word '+lot+' '+v+' '+signature}]]};
        reply=['Значения для переноса в форму заказчика',info.summary,'Сведения о персонале, согласия и подпись заполняются отдельно.','Оригинал: '+card.url].join('\n');
      }catch(err){reply=(err as Error).message;}
      break;
    }
    case '/confirm':{
      const [,id,v,signature]=text.split(' ');
      const row=await sql(e,'SELECT x.payload FROM lots l JOIN versions x ON x.lot=l.id AND x.revision=l.revision WHERE l.id=? AND l.revision=?',id||'',v||'').first();
      if(!row || await sql(e,'SELECT 1 FROM decisions WHERE owner=? AND lot=? AND revision=?',user,id||'',v||'').first()){reply='Подготовка остановлена или версия изменилась.';break;}
      const card=JSON.parse(row.payload);
      let details;
      try{details=offer(card,await fields(Number(id),Number(v)));}catch(err){reply=(err as Error).message;break;}
      const digest=await hash(JSON.stringify(details.data));
      if(signature!==digest.slice(0,16)){reply='Сводка изменилась, перепроверьте условия.';break;}
      const current=await readCard(card.url).catch(()=>null);
      // For EIS, Mac retries the same official original immediately before rendering if the Worker cannot reach it.
      const macRecheck=card.source==='eis-order'&&current===null&&acceptingCard(card);
      if(!macRecheck&&(!acceptingCard(current)||JSON.stringify(card)!==JSON.stringify(current))){
        reply='Выпуск остановлен. Срок, статус или актуальность карточки требуют проверки.';break;
      }
      const job=await sql(e,'SELECT state FROM jobs WHERE lot=? AND revision=? AND op=?',id,v,'pdf/'+digest).first();
      if(job?.state==='done'){reply='КП с этими условиями уже отправлено в чат.';break;}
      if(job?.state==='uncertain'){reply='Подтверждение доставки PDF не получено. Проверьте историю чата.';break;}
      mutations.push(sql(e,"INSERT INTO jobs(lot,revision,op,input) VALUES(?,?,?,?) ON CONFLICT(lot,revision,op) DO UPDATE SET state='queued',attempts=0,until_ts=0,lease=NULL WHERE jobs.state='failed' OR (jobs.state='running' AND jobs.until_ts<unixepoch() AND jobs.attempts>=4)",id,v,'pdf/'+digest,JSON.stringify(details.data)));
      reply='Подтверждение принято. PDF в очереди Mac.';break;
    }
    case '/analyze':{
      const [,lot,rev]=text.split(' ');
      const valid=await sql(e,'SELECT id FROM lots WHERE id=? AND revision=?',lot||'',rev||'').first();
      if(!valid){reply='Карточка устарела.';break;}
      const job=await sql(e,"SELECT state,until_ts,attempts,id FROM jobs WHERE lot=? AND revision=? AND op='analysis'",lot,rev).first();
      if(job?.state==='done'){
        const delivered=await sql(e,'SELECT payload FROM outbox WHERE dedupe=? AND owner=?','job/'+job.id,user).first();
        reply='Разбор готов.'+(delivered?'\n'+JSON.parse(delivered.payload).text:'');break;
      }
      if(job?.state==='running' && job.until_ts>=now()){reply='Mac обрабатывает документы.';break;}
      const agent=await sql(e,'SELECT seen,paused FROM agent_state WHERE id=1').first();
      mutations.push(sql(e,"INSERT INTO jobs(lot,revision,op) VALUES(?,?,'analysis') ON CONFLICT(lot,revision,op) DO UPDATE SET state='queued',attempts=0,until_ts=0,lease=NULL WHERE jobs.state='failed' OR (jobs.state='running' AND jobs.until_ts<unixepoch() AND jobs.attempts>=4)",lot,rev));
      if(agent?.paused)reply='Разбор в очереди. Mac на паузе. Возобновить: /resume';
      else if(!agent?.seen || agent.seen<now()-180)reply='Разбор ожидает подключения Mac.';
      else reply='Разбор поставлен в очередь на Mac.';
      break;
    }
    case '/check':{
      const admitted=await pollAll(e);
      if(admitted)await rankNotices(e);
      reply=admitted?'Проверка обработана с учётом интервала опроса. Результат в /status.':'Дневной бюджет обходов исчерпан. Новый бюджет начнётся в 00:00 UTC.';
      break;
    }
    case '/sources':{
      reply='Для ручного поиска выберите регион исполнения «Хабаровский край» и действующий приём заявок или предложений. Ищите по одному запросу: «выгрузка вагонов», «железнодорожный тупик», «перевалка», «склад с подъездным путём». Адрес и обязательные услуги сверяйте в ТЗ.\n\nОригиналы ЕИС, карточки РЖД из секции РТС и ссылки на отдельные лоты Росэлторга можно прислать сюда командой /watch.';
      markup={inline_keyboard:[
        [{text:'ЕИС · закупки',url:'https://zakupki.gov.ru/epz/order/extendedsearch/results.html'},{text:'ЕИС · запросы цен',url:'https://zakupki.gov.ru/epz/pricereq/search/results.html'}],
        [{text:'РТС · поиск',url:'https://www.rts-tender.ru/poisk/'},{text:'РЖД · секция РТС',url:'https://rzd.rts-tender.ru/'}],
        [{text:'ЕАТ Берёзка',url:'https://agregatoreat.ru/purchases/all'},{text:'OTC · Хабаровский край',url:'https://market.otc.ru/khabkray'}],
        [{text:'Росэлторг',url:publicCatalogues.roseltorg.url},{text:'Сбербанк-АСТ',url:'https://www.sberbank-ast.ru/'}],
        [{text:'ТЭК-Торг',url:publicCatalogues.tektorg.url},{text:'Роснефть',url:publicCatalogues.rosneft.url}],
        [{text:'Фабрикант',url:publicCatalogues.fabrikant.url},{text:'ЗаказРФ',url:publicCatalogues.zakazrf.url}],
        [{text:'ЭТП ГПБ',url:publicCatalogues.gpb.url},{text:'КОМИТА',url:'https://market.comita.ru/purchases223'}],
        [{text:'B2B-Center',url:'https://www.b2b-center.ru/app/next/market-search/'},{text:'РАД',url:'https://gz.lot-online.ru/etp_front/'}]
      ]};
      break;
    }
    case '/status':{
      const sources=(await sql(e,'SELECT * FROM sources ORDER BY id').all()).results;
      const labels:Record<string,string>={'eis-orders':'ЕИС · закупки','eis-price_requests':'ЕИС · запросы цен','watch/rzd':'РЖД · отслеживаемые оригиналы',eat:'ЕАТ Берёзка','otc-khab':'OTC · Хабаровский край','comita-rzd':'КОМИТА РЖД','rts-rzd-search':'РТС · РЖД',eis:'ЕИС',b2b:'B2B-Center',...Object.fromEntries(Object.entries(publicCatalogues).map(([id,c])=>[id,c.name]))};
      const sourceStatus=sources.map(s=>(s.id.startsWith('mac/')?'Mac · '+(labels[s.id.slice(4)]||s.id.slice(4)):(labels[s.id]||s.id))+': '+(s.last_error||(s.last_ok?'проверено '+new Date(s.last_ok*1000).toISOString():'проверки ещё не было'))).join('\n');
      const a=await sql(e,'SELECT * FROM agent_state WHERE id=1').first();
      const count=await sql(e,"SELECT count(*) AS n,min(j.created) AS oldest FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision WHERE j.state IN ('queued','running') AND (j.state='queued' OR j.until_ts>=unixepoch() OR j.attempts<4)").first();
      const failures=await sql(e,"SELECT count(*) AS n FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision WHERE j.state IN ('failed','uncertain') OR (j.state='running' AND j.until_ts<unixepoch() AND j.attempts>=4)").first();
      const cards=await sql(e,'SELECT count(*) AS n FROM pending_cards').first();
      const usage=await sql(e,"SELECT total,background FROM scan_usage WHERE day=date('now')").first();
      const budget=scanBudget(e);
      const sample=await deliveryStats(e);
      const deliveryErrors=await sql(e,"SELECT count(CASE WHEN state='failed' THEN 1 END) AS failed,count(CASE WHEN state='uncertain' THEN 1 END) AS uncertain FROM outbox WHERE created>=unixepoch()-604800 AND state IN ('failed','uncertain')").first();
      reply=sourceStatus+'\nРЖД: чтение оригинала по ссылке /watch'+'\nMac: '+(a?.seen?new Date(a.seen*1000).toISOString():'контакта ещё не было')+'\nЗадач: '+count?.n+'\nСбой или неподтверждённая доставка: '+(failures?.n||0)+'\nСообщения за 7 дней: отказов Telegram '+(deliveryErrors?.failed||0)+', без подтверждения '+(deliveryErrors?.uncertain||0)+'\nКарточек ожидают Mac: '+cards?.n+'\nВозраст старейшей задачи разбора или КП, с: '+(count?.oldest?now()-count.oldest:0)+'\nДиск Mac, ГБ: '+(a?.free_bytes?Math.floor(a.free_bytes/1e9):'неизвестно')+'\nДоставка за 7 дней: '+(sample?.total||0)+' подтверждено, '+(sample?.dated||0)+' с известным временем публикации. P95: '+(sample?.publication_p95_seconds!=null?Math.ceil(sample.publication_p95_seconds/60)+' мин':'нет данных')+'\nОчередь → Telegram: '+(sample?.queued||0)+' наблюдений, P95: '+(sample?.queue_p95_seconds!=null?sample.queue_p95_seconds+' с':'нет данных')+'\nОбходы проекта сегодня (UTC): '+(usage?.total||0)+' из '+budget.limit+', резерв ручных запусков: '+budget.reserve+'.\nРасход всего аккаунта: нет телеметрии.';
      const local=await localHealth(e);
      if(local)reply+='\nВерсия Mac: '+local.release+'\nНаходок в локальной очереди: '+local.pending+', возраст старейшей, с: '+(local.oldest?Math.max(0,now()-local.oldest):0)+'\nБаз Mac с ошибкой чтения: '+local.unreadable+'\nПоследняя резервная копия: '+(local.backup_at?new Date(local.backup_at*1000).toISOString():'ещё не создана');
      break;
    }
    case '/semantic':{
      if(!e.AI){reply='Бесплатная модель поиска пока не подключена.';break;}
      const {results}=await sql(e,'SELECT n.title,n.url,r.scenario FROM semantic_results r JOIN notices n ON n.url=r.url AND n.updated=r.source_updated ORDER BY r.score DESC LIMIT 4').all();
      reply=results.length?'Архив смыслового поиска. Место исполнения в этих карточках может быть не подтверждено.\n\n'+results.map(x=>x.title.slice(0,360)+'\nСопоставлено со сценарием: '+x.scenario+'\n'+x.url).join('\n\n'):'Очередь смысловой проверки ещё не обработана.';
      break;
    }
    case '/inbox':{
      const {results}=await sql(e,"SELECT json_extract(payload,'$.text') AS text FROM outbox WHERE owner=? AND json_extract(payload,'$.location') IS NOT NULL ORDER BY id DESC LIMIT 5",user).all();
      reply=results.map(x=>x.text).join('\n\n').slice(0,3900) || 'Пока нет новых закупок с указанным местом исполнения в Хабаровске.';break;
    }
    case '/pause':case '/resume':
      mutations.push(sql(e,'UPDATE agent_state SET paused=? WHERE id=1',text==='/pause'?1:0));reply=text==='/pause'?'Mac на паузе.':'Mac продолжит обработку.';break;
    default:{
      if(!session||text.startsWith('/'))break;
      if(session.current!==session.revision){reply='Лот обновился, откройте его новую версию.';break;}
      const {lot,revision,field}=session;
      if(field==='reject'){
        if(!text.trim()){reply='Укажите причину.';break;}
        mutations.push(sql(e,'INSERT OR REPLACE INTO decisions VALUES(?,?,?,?)',user,lot,revision,text.trim().slice(0,600)),sql(e,'DELETE FROM sessions WHERE owner=?',user));
        markup={inline_keyboard:[[{text:'Восстановить',callback_data:'/restore '+lot+' '+revision}]]};reply='Причина сохранена.';break;
      }
      const values=await fields(lot,revision);
      try{values[field]=validate(field,text);}catch(err){reply=(err as Error).message;break;}
      const saveAnswer=sql(e,'INSERT OR REPLACE INTO answers VALUES(?,?,?,?,?)',user,lot,revision,field,values[field]);
      const next=questions.find(([k])=>!values[k]);
      if(next){mutations.push(saveAnswer,sql(e,'UPDATE sessions SET field=? WHERE owner=?',next[0],user));reply=next[1];}
      else{
        let details;
        try{details=offer(JSON.parse(session.payload),values);}catch(err){reply=(err as Error).message;break;}
        mutations.push(saveAnswer);
        const signature=(await hash(JSON.stringify(details.data))).slice(0,16);
        reply=details.summary;markup={inline_keyboard:[[{text:'Сформировать КП',callback_data:'/confirm '+lot+' '+revision+' '+signature},{text:'Исправить',callback_data:'/edit '+lot+' '+revision}],[{text:'Данные для формы заказчика',callback_data:'/transfer '+lot+' '+revision}]]};
        mutations.push(sql(e,'DELETE FROM sessions WHERE owner=?',user));
      }
      break;
    }
    case '/edit':{
      const [,id,v]=text.split(' '), row=await sql(e,'SELECT 1 FROM lots WHERE id=? AND revision=?',id||'',v||'').first();
      if(!row){reply='Карточка устарела.';break;}
      markup={inline_keyboard:questions.map(([k,label])=>[{text:label,callback_data:'/field '+id+' '+v+' '+k}])};reply='Какое поле изменить?';break;
    }
    case '/field':{
      const [,id,v,k]=text.split(' '), q=questions.find(([f])=>f===k);
      if(!q || !await sql(e,'SELECT 1 FROM lots WHERE id=? AND revision=?',id||'',v||'').first()){reply='Карточка устарела.';break;}
      mutations.push(sql(e,'INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)',user,id,v,k));reply=q[1];break;
    }
    case '/settings':reply='/pause — приостановить Mac\n/resume — продолжить';break;
  }
  const parts=splitReply(reply);
  const replies=parts.map((text,index)=>sql(e,'INSERT INTO outbox(dedupe,owner,payload) VALUES(?,?,?)',
    'update/'+u.update_id+(index?'/part/'+index:''),user,JSON.stringify({text,reply_markup:index===parts.length-1?markup:undefined})));
  try{
    await e.DB.batch([sql(e,'INSERT INTO updates(id) VALUES(?)',u.update_id),...mutations,...replies]);
  }catch(err){if(!await sql(e,'SELECT 1 FROM updates WHERE id=?',u.update_id).first())throw err;}
  await deliver(e);return response({});
}
type Background = {waitUntil(task:Promise<unknown>):void};
async function agent(req:Request,e:Env,path:string,ctx?:Background) {
  if(!await same(req.headers.get('Authorization'),'Bearer '+(e.AGENT_KEY||''))||!e.AGENT_KEY)return response({},403);
  if(path==='/agent/check'||path==='/agent/status'){
    const admitted=path==='/agent/check'?await pollAll(e):false;
    if(path==='/agent/check')await deliver(e);
    const {results}=await sql(e,'SELECT id,last_ok,last_error,cursor,next_at FROM sources ORDER BY id').all();
    return response({sources:results,admitted,delivery:await deliveryStats(e),agent:await sql(e,'SELECT * FROM agent_state WHERE id=1').first(),local:await localHealth(e)});
  }
  if(path==='/agent/pdf'){
    const id=req.headers.get('x-job'),lease=req.headers.get('x-lease');
    const job=await sql(e,"SELECT j.*,o.id AS owner FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision CROSS JOIN owner o WHERE j.id=? AND j.lease=? AND j.until_ts>=unixepoch() AND j.state='running' AND j.op LIKE 'pdf/%' AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.lot=j.lot AND d.revision=j.revision)",id,lease).first();
    if(!job)return response({},409);
    const version=await sql(e,'SELECT payload FROM versions WHERE lot=? AND revision=?',job.lot,job.revision).first();
    const answers=await sql(e,'SELECT field,value FROM answers WHERE owner=? AND lot=? AND revision=?',job.owner,job.lot,job.revision).all();
    if(!version)return response({},409);
    const card=JSON.parse(version.payload);
    let blob:Blob;
    if(card.source==='eis-order'){
      const form=await req.formData().catch(()=>null);
      const pdf=form?.get('pdf'),original=form?.get('original');
      if(typeof original!=='string'||original.length>3000000)return response({},400);
      const fresh=readEisForPdf(original,card.url);
      if(!acceptingCard(fresh)||JSON.stringify(card)!==JSON.stringify(fresh)){
        const [notification]=await e.DB.batch([
          sql(e,"INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT 'pdf-stale/'||id,?,? FROM jobs WHERE id=? AND lease=? AND state='running'",job.owner,JSON.stringify({text:'КП не отправлено. ЕИС не подтвердила прежние условия, действующий срок и статус подачи. Откройте оригинал заново через /watch.'}),id,lease),
          sql(e,"UPDATE jobs SET state='failed',lease=NULL WHERE id=? AND lease=? AND state='running'",id,lease)
        ]);
        if(notification.meta.changes>0)await dispatchQueued(e,ctx);
        return response({stale:true},409);
      }
      if(!(pdf instanceof Blob))return response({},400);
      blob=pdf;
    }else{
      blob=await req.blob();
    }
    if(blob.size>8000000 || await blob.slice(0,5).text()!=='%PDF-')return response({},400);
    let approved;
    try{approved=offer(card,Object.fromEntries(answers.results.map(r=>[r.field,r.value])));}
    catch{return response({},409);}
    if(job.op!=='pdf/'+await hash(JSON.stringify(approved.data)))return response({},409);
    const locked=await sql(e,"UPDATE jobs SET state='uncertain' WHERE id=? AND state='running' AND lease=? AND until_ts>=unixepoch() AND EXISTS(SELECT 1 FROM lots WHERE lots.id=jobs.lot AND lots.revision=jobs.revision) AND NOT EXISTS(SELECT 1 FROM decisions WHERE decisions.lot=jobs.lot AND decisions.revision=jobs.revision) RETURNING id",id,lease).first();
    if(!locked)return response({},409);
    const form=new FormData();form.set('chat_id',job.owner);form.set('document',blob,'KP.pdf');form.set('caption','Предложение для проверки и ручной подачи.');
    const sent=await telegramSend(e,'sendDocument',form);
    const delay=sent?await retryDelay(sent):null;
    if(delay!==null){
      await e.DB.batch([cooldown(e,delay),sql(e,"UPDATE jobs SET state='queued',until_ts=unixepoch()+?,lease=NULL,attempts=max(0,attempts-1) WHERE id=? AND lease=? AND state='uncertain'",delay,id,lease)]);
      return response({deferred:true},202);
    }
    const result=await telegramResult(sent);
    if(result.state==='failed'){
      await sql(e,"UPDATE jobs SET state='failed',lease=NULL WHERE id=? AND lease=? AND state='uncertain'",id,lease).run();
    }
    if(result.state!=='sent')return response({},502);
    await e.DB.batch([sql(e,"UPDATE jobs SET state='done' WHERE id=?",id),sql(e,"INSERT INTO offers(lot,revision,digest,state) VALUES(?,?,?,'отправлено владельцу')",job.lot,job.revision,job.op.slice(4))]);return response({});
  }
  const body=await req.json() as any;
  if(path==='/agent/card-claim'){
    const task=await sql(e,"UPDATE pending_cards SET lease=?,available=unixepoch()+120 WHERE url=(SELECT url FROM pending_cards WHERE available<=unixepoch() AND (SELECT paused FROM agent_state WHERE id=1)=0 ORDER BY request_id LIMIT 1) RETURNING url,lease",crypto.randomUUID()).first();
    return response(task??null);
  }
  if(path==='/agent/card-result'){
    const task=await sql(e,'SELECT * FROM pending_cards WHERE url=? AND lease=? AND available>=unixepoch()',body.url,body.lease).first();
    if(!task)return response({},409);
    if(typeof body.html!=='string'||body.html.length>3000000)return response({},400);
    let message:any={text:'Mac также не смог прочитать лот. Оригинал: '+task.url};
    let card;
    const candidate=body.resolved_url??task.url;
    if(candidate!==task.url&&(!eisOrderNumber(task.url)||eisOrderNumber(candidate)!==eisOrderNumber(task.url)))return response({},400);
    try{card=parseCard(body.html,candidate);}catch{}
    if(card)message=cardMessage(card,await saveCard(e,card));
    await e.DB.batch([sql(e,'INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,owner,? FROM pending_cards WHERE url=? AND lease=?','card/'+task.request_id,JSON.stringify(message),task.url,task.lease),sql(e,'DELETE FROM pending_cards WHERE url=? AND lease=?',task.url,task.lease)]);
    await deliver(e);
    return response({});
  }
  const localSources = {
    'eis-orders': {name:'ЕИС · закупки', page:'https://zakupki.gov.ru/epz/order/extendedsearch/results.html'},
    'eis-price_requests': {name:'ЕИС · запросы цен', page:'https://zakupki.gov.ru/epz/pricereq/search/results.html'},
    'otc-khab': {name:'OTC · Хабаровский край', page:'https://market.otc.ru/khabkray'},
    'eat': {name:'ЕАТ Берёзка', page:'https://agregatoreat.ru/purchases/all'},
    'comita-rzd': {name:'КОМИТА РЖД', page:'https://market.comita.ru/purchases223'},
    'rts-rzd-search': {name:'РТС · РЖД', page:'https://www.rts-tender.ru/poisk/'}
  };
  if(path==='/agent/scan-report'){
    const id=body?.source as keyof typeof localSources;
    if(!Object.hasOwn(localSources,id)||typeof body.ok!=='boolean')return response({},400);
    const eisReasons:Record<string,string>={
      eis_pagination_404:'ЕИС вернула HTTP 404 на продолжении',
      eis_pagination_unavailable:'ЕИС не отдала подтверждённую следующую страницу',
      eis_unrecognized_rows:'Часть строк ЕИС не распознана',
      eis_search_incomplete:'ЕИС не подтвердила часть профильных запросов',
    };
    const partial=!body.ok && body.partial===true && typeof body.reason==='string';
    const partialReason=partial&&(
      id.startsWith('eis-') && Object.hasOwn(eisReasons,body.reason)?eisReasons[body.reason]:
      id==='rts-rzd-search' && body.reason==='rts_pagination_incomplete'?'РТС не отдала продолжение выдачи':null
    );
    const error=partialReason?'Частичный обход. '+partialReason:
      id==='rts-rzd-search' && body.reason==='rts_public_search_unavailable'
        ? 'РТС вернула HTTP 503 и страницу Anti-DDoS' : 'Ошибка обхода на Mac';
    await sql(e,'INSERT INTO sources(id,url,last_ok,last_error) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_ok=coalesce(excluded.last_ok,sources.last_ok),last_error=excluded.last_error',
      'mac/'+id,localSources[id].page,body.ok?now():null,body.ok?null:error).run();
    return response({ok:true});
  }
  if(['/agent/eat-candidate','/agent/comita-candidate','/agent/rts-candidate','/agent/otc-region-candidate','/agent/eis-candidate'].includes(path)){
    const eat=path==='/agent/eat-candidate', rts=path==='/agent/rts-candidate', regional=path==='/agent/otc-region-candidate';
    const {url,title,procedure}=body||{};
    const uid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
    const eis=path==='/agent/eis-candidate';
    const eisUrl=/^https:\/\/zakupki\.gov\.ru\/(?:(?:epz\/order\/notice\/[a-z0-9]+\/(?:view\/)?common-info\.html|223\/purchase\/public\/purchase\/info\/common-info\.html)\?regNumber=(\d{11}|\d{19})|epz\/pricereq\/card\/common-info\.html\?reestrNumber=(\d{19}))$/;
    const original=eis?eisUrl:regional?/^https:\/\/etp\.otc\.ru\/tender\/(\d{1,16})$/:rts?/^https:\/\/223\.rts-tender\.ru\/supplier\/auction\/Trade\/View\.aspx\?Id=(\d{1,16})#\d{1,8}$/i:
      new RegExp(eat?'^https://agregatoreat\\.ru/purchases/announcement/'+uid+'/$':'^https://eshoprzd\\.ru/purchases/'+uid+'$');
    const match=typeof url==='string' && original.exec(url);
    if(!match||typeof procedure!=='string'||!(eis?/^(?:\d{11}|\d{19})$/:eat?/^\d{18}$/:/^\d{1,16}$/).test(procedure)
       ||(eis&&(match[1]||match[2])!==procedure)||((regional||rts)&&match[1]!==procedure)||typeof title!=='string'||!title.trim()||title.length>4000)return response({},400);
    const review=eis&&body.review===true;
    const matched=!review&&catalogueMatch(title);
    if(!matched&&!review)return response({status:'filtered'});
    if(!await sql(e,'SELECT id FROM owner LIMIT 1').first())return response({},503);
    let published:string|null=null;
    if(path==='/agent/comita-candidate' && body.published!=null){
      const value=body.published;
      if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))return response({},400);
      const stamp=Date.parse(value);
      if(!Number.isFinite(stamp)||stamp<=0||stamp>Date.now()||new Date(stamp).toISOString()!==value)return response({},400);
      published=value;
    }
    const location=matched?await confirmLocation({title,url}):'';
    const {statements,notifications}=noticeStatements(e,eis?(match[2]?'eis-price_requests':'eis-orders'):regional?'otc-khab':eat?'eat':rts?'rts-rzd-search':'comita-rzd',[{title,url,published,location}],!review);
    const results=await e.DB.batch(statements);
    if(notifications.some(i=>results[i].meta.changes>0))await dispatchQueued(e,ctx);
    return response({status:matched?'accepted':'filtered'});
  }
  if(path==='/agent/catalogue'){
    if(!Object.hasOwn(publicCatalogues,body.source)||typeof body.html!=='string'||body.html.length>3000000)return response({},400);
    const error=body.error==='unavailable'?'Площадка недоступна с Mac':'';
    const {count,error:issue,queued}=await macCatalogue(e,body.source as keyof typeof publicCatalogues,body.html,error);
    if(queued)await dispatchQueued(e,ctx);
    return response({count,error:issue});
  }
  if(path==='/agent/heartbeat'){
    const previous=await sql(e,'SELECT seen FROM agent_state WHERE id=1').first();
    const mutations:Statement[]=[];
    if(previous?.seen && previous.seen<=now()-1200){
      const dedupe='mac-offline/'+previous.seen;
      mutations.push(sql(e,"INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner WHERE EXISTS(SELECT 1 FROM outbox WHERE dedupe=? AND state IN ('sent','uncertain'))",
        'mac-online/'+previous.seen,JSON.stringify({text:'Mac снова на связи. Сохранённые находки и задачи продолжат обработку. Состояние: /status.'}),dedupe),
        sql(e,"UPDATE outbox SET state='suppressed' WHERE dedupe=? AND state='ready'",dedupe));
    }
    const local=body.local;
    if(local && typeof local.release==='string' && /^(?:[a-f0-9]{16}|development)$/.test(local.release)
       && ['pending','unreadable','backup_at'].every(k=>Number.isSafeInteger(local[k])&&local[k]>=0)
       && (local.oldest===null||(Number.isSafeInteger(local.oldest)&&local.oldest>=0))){
      const value=JSON.stringify({release:local.release,pending:local.pending,unreadable:local.unreadable,backup_at:local.backup_at,oldest:local.oldest});
      mutations.push(sql(e,"INSERT INTO profile(key,value) VALUES('agent.telemetry',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value));
    }
    mutations.push(sql(e,'UPDATE agent_state SET seen=unixepoch(),free_bytes=? WHERE id=1',Number(body.free_bytes)||0));
    await e.DB.batch(mutations);
    const state=await sql(e,'SELECT paused FROM agent_state WHERE id=1').first();
    const failed=await sql(e,"SELECT s.id,m.cursor FROM sources s LEFT JOIN sources m ON m.id='mac/'||s.id WHERE s.id IN ('rosneft','roseltorg','tektorg','tektorgRzd','gpb','zakazrf','otc','fabrikant') AND s.last_error IS NOT NULL").all();
    const pending=await sql(e,"SELECT 1 FROM pending_cards WHERE available<=unixepoch() LIMIT 1").first();
    return response({...state,pendingCard:Boolean(pending),failedCatalogues:failed.results.map(r=>r.id),rosneftPage:Number(failed.results.find(r=>r.id==='rosneft')?.cursor)||1});
  }
  if(path==='/agent/claim'){
    const job=await sql(e,"UPDATE jobs SET state='running',lease=?,until_ts=unixepoch()+300,attempts=attempts+1 WHERE id=(SELECT j.id FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision WHERE ((j.state='queued' AND j.until_ts<=unixepoch()) OR (j.state='running' AND j.until_ts<unixepoch())) AND (j.op NOT LIKE 'pdf/%' OR (NOT EXISTS(SELECT 1 FROM telegram_cooldown WHERE until_ts>unixepoch()) AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.lot=j.lot AND d.revision=j.revision))) AND j.attempts<4 AND (SELECT paused FROM agent_state WHERE id=1)=0 ORDER BY j.created LIMIT 1) RETURNING *",crypto.randomUUID()).first();
    if(!job)return response(null);
    const version=await sql(e,'SELECT payload FROM versions WHERE lot=? AND revision=?',job.lot,job.revision).first();
    return response({...job,card:JSON.parse(version!.payload)});
  }
  if(path==='/agent/result'){
    if(typeof body.text!=='string'||body.text.length>3500)return response({},400);
    const args=[body.id,body.lease];
    const [notification]=await e.DB.batch([
      sql(e,"INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT 'job/'||j.id,o.id,? FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision CROSS JOIN owner o WHERE j.id=? AND j.lease=? AND j.op='analysis' AND j.state='running' AND j.until_ts>=unixepoch()",JSON.stringify({text:body.text}),...args),
      sql(e,"UPDATE jobs SET state='done' WHERE id=? AND lease=? AND op='analysis' AND state='running' AND until_ts>=unixepoch() AND EXISTS(SELECT 1 FROM lots WHERE lots.id=jobs.lot AND lots.revision=jobs.revision)",...args)
    ]);
    if(notification.meta.changes>0)await dispatchQueued(e,ctx);
    return response({});
  }
  return response({},404);
}
function readEisForPdf(html:string,url:string){
  try{return parseCard(html,url);}catch{return null;}
}
async function dispatchQueued(e:Env,ctx?:Background){
  const task=deliver(e);
  if(ctx)ctx.waitUntil(task);
  else await task;
}
export default {
  async fetch(req:Request,e:Env,ctx?:Background){
    const path=new URL(req.url).pathname;
    if(req.method==='GET' && path==='/health')return response({release:e.RELEASE||'unknown'});
    if(path==='/setup')return setup(req,e,same,hash);
    if(req.method!=='POST')return response({},404);
    if(path==='/telegram')return telegram(req,e);
    if(path.startsWith('/agent/'))return agent(req,e,path,ctx);
    return response({},404);
  },
  async scheduled(_event:unknown,e:Env){await checkAgentHealth(e);const admitted=await pollAll(e,true);await deliver(e);if(admitted)await rankNotices(e);}
};
