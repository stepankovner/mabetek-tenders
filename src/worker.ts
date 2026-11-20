import {draftWord,supportsForm,verifyOriginal} from './rzd-form';
import {rankNotices} from './semantic';
import {b2b,publicPoll,macCatalogue} from './monitor';
import {setup} from './setup';
import {questions,validate,offer} from './dialog';
// Cloudflare Worker. Aggregate RSS announcements stay separate from verified lots.
import { readCard } from './card';
import { authorized, feed, identity, rzdTime, publicCatalogues, roseltorgCard, serviceMatch } from './core.mjs';

interface Statement {
  bind(...args:unknown[]):Statement;
  first<T=Record<string,any>>():Promise<T|null>;
  all():Promise<{results:Record<string,any>[]}>;
  run():Promise<unknown>;
}
interface Env {
  DB:{prepare(sql:string):Statement;batch(sql:Statement[]):Promise<unknown>};
  SCAN_DAILY_LIMIT?:string; SCAN_COMMAND_RESERVE?:string; RELEASE?:string; AI?:{run:Function}; WEBHOOK_SECRET:string; BOT_TOKEN:string; AGENT_KEY:string;
}
const help='/watch ссылка — разобрать извещение РЖД или лот Росэлторга\n/status — источники и Mac\n/check — запросить обход\n/inbox — последние извещения\n/settings — управление агентом\n/semantic — смысловая подборка';
const now=()=>Math.floor(Date.now()/1000);
const sql=(e:Env,s:string,...p:unknown[])=>e.DB.prepare(s).bind(...p);
const response=(body:unknown,status=200)=>Response.json(body,{status});
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
    for(const notice of rows){
      if(!serviceMatch(notice.title+' '+notice.description))continue;
      const message='ЕИС · требуется проверить место исполнения в оригинале\n'+notice.title.slice(0,600)+'\n'+notice.url;
      batch.push(sql(e,"INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,id,? FROM owner",'eis/'+notice.url,JSON.stringify({text:message})));
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
  await Promise.all([poll(e),b2b(e),publicPoll(e,'roseltorg'),publicPoll(e,'tektorg'),publicPoll(e,'gpb'),publicPoll(e,'sberWorld'),publicPoll(e,'rad')]);
  return true;
}
async function deliver(e:Env) {
  for(let n=0;n<5;n++){
    // Persist uncertainty before sending. Never resend a possible successful delivery automatically.
    const m=await sql(e,"UPDATE outbox SET state='uncertain' WHERE id=(SELECT id FROM outbox WHERE state='ready' ORDER BY id LIMIT 1) RETURNING *").first();
    if(!m)return;
    const payload=JSON.parse(m.payload);
    let r:Response;
    if(payload.word){
      const {lot,vat}=payload.word;
      const draft=draftWord(lot,vat),form=new FormData();
      form.set('chat_id',m.owner);form.set('document',draft.file,'RZD-32616584495-'+(lot?'lot-'+lot:'blank')+'.docx');
      form.set('caption',(payload.word.cached?'Бланк из ранее проверенной копии приложения. Сверьте его с оригиналом перед подачей. ':'')+'Черновик технического предложения РЖД. '+(draft.filled?'Ставка НДС перенесена из ваших условий.':'Поле ставки НДС оставлено пустым. Подтвердите его заполнение вручную.')+(lot?'':' Впишите номер лота из извещения.')+' Проверьте пункт 1 о полном соответствии ТЗ и место оказания услуг до подачи. Сведения об участнике, персонале и согласия оформляются отдельно.');
      r=await fetch('https://api.telegram.org/bot'+e.BOT_TOKEN+'/sendDocument',{method:'POST',body:form,signal:AbortSignal.timeout(10000)});
    }else{
      r=await fetch('https://api.telegram.org/bot'+e.BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:m.owner,...payload}),signal:AbortSignal.timeout(10000)});
    }
    if(r.ok){
      const ack=await r.json() as any;
      if(ack.ok){
        const changes=[sql(e,"UPDATE outbox SET state='sent',message_id=? WHERE id=?",ack.result.message_id,m.id)];
        const key=String(m.dedupe);
        const source=key.startsWith('eis/')?'eis':key.startsWith('b2b/')?'b2b':key.startsWith('https://')?'catalogue':null;
        if(source && Number.isSafeInteger(ack.result.date)){
          let published=null;
          if(source==='eis'){
            const notice=await sql(e,'SELECT published FROM notices WHERE url=?',key.slice(4)).first();
            const raw=notice?.published||'';
            if(/(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim())){
              const t=Math.floor(Date.parse(raw)/1000);
              if(Number.isFinite(t)&&t<=ack.result.date)published=t;
            }
          }
          changes.push(sql(e,'INSERT OR IGNORE INTO delivery_observations VALUES(?,?,?,?,?)',m.id,source,m.created,ack.result.date,published));
        }
        await e.DB.batch(changes);
      }
    }
  }
}
async function saveCard(e:Env,c:any){
  const key=identity(c),payload=JSON.stringify(c),digest=await hash(payload);
  const previous=await sql(e,'SELECT l.id,l.revision,v.digest FROM lots l JOIN versions v ON l.id=v.lot AND l.revision=v.revision WHERE l.canonical=?',key).first();
  if(previous?.digest===digest)return previous;
  const revision=(previous?.revision||0)+1;
  // A concurrent write conflicts on the version and rolls back the entire batch.
  await e.DB.batch([
    sql(e,"INSERT INTO lots(canonical,procedure_no,lot_no,revision,deadline,status) VALUES(?,?,?,?,?,?) ON CONFLICT(canonical) DO UPDATE SET revision=excluded.revision,deadline=excluded.deadline,status=excluded.status WHERE lots.revision=excluded.revision-1",key,c.procedure,c.lot,revision,c.deadline,c.status),
    sql(e,'INSERT INTO versions SELECT id,?,?,?,unixepoch() FROM lots WHERE canonical=?',revision,digest,payload,key),
    sql(e,'INSERT OR IGNORE INTO links SELECT id,?,? FROM lots WHERE canonical=?',c.source,c.url,key),
    sql(e,"UPDATE offers SET state='устарело' WHERE lot=(SELECT id FROM lots WHERE canonical=?)",key)
  ]);
  return (await sql(e,'SELECT id,revision FROM lots WHERE canonical=?',key).first())!;
}
const decisionKeys=(id:number,v:number)=>({inline_keyboard:[[{text:'Уточнить условия',callback_data:'/terms '+id+' '+v},{text:'Не подходит',callback_data:'/reject '+id+' '+v}]]});
function cardMessage(c:any,lot:any){
const time=rzdTime(c.deadline);
        const text=[c.title,c.customer||'Заказчик не указан','Статус: '+(c.status||'не указано'),'Место: '+(c.place||'не указано'),(c.source==='roseltorg'?'Цена лота в карточке: ':'НМЦ заказчика: ')+(c.price?c.price+' руб.':'не указано'),'Срок: '+(time.utc?time.moscow+' МСК / '+time.khabarovsk+' Хабаровск':c.deadline||'не указано'),'Требуют уточнения: место исполнения и доступность площадки.'].join('\n');
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
    case '/ros':case '/watch':{
      const input=text.startsWith('/ros ')?'https://www.roseltorg.ru/procedure/'+text.slice(5).trim():text.slice(7).trim();
      try{
        const c=await readCard(input), lot=await saveCard(e,c);
        const message=cardMessage(c,lot);
        reply=message.text;markup=message.reply_markup;
      }catch{
        if(/^https:\/\/www\.roseltorg\.ru\/procedure\/[A-Za-z0-9_-]+\/\d+\/?$/.test(input)){
          mutations.push(sql(e,'INSERT INTO pending_cards(url,owner,request_id) VALUES(?,?,?) ON CONFLICT(url) DO NOTHING',input.replace(/\/$/,''),user,u.update_id));
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
      const time=rzdTime(current?.deadline);
      if(!time.utc || Date.parse(time.utc)<=Date.now() || !/прием заявок/i.test((current?.status||'').replace(/ё/gi,'е')) || JSON.stringify(card)!==JSON.stringify(current)){
        reply='Выпуск остановлен. Срок, статус или актуальность карточки требуют проверки.';break;
      }
      mutations.push(sql(e,"INSERT OR IGNORE INTO jobs(lot,revision,op,input) VALUES(?,?,?,?)",id,v,'pdf/'+digest,JSON.stringify(details.data)));
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
      mutations.push(sql(e,"INSERT INTO jobs(lot,revision,op) VALUES(?,?,'analysis') ON CONFLICT(lot,revision,op) DO UPDATE SET state='queued',attempts=0 WHERE jobs.state='running' AND jobs.until_ts<unixepoch() AND jobs.attempts>=4",lot,rev));
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
    case '/status':{
      const sources=(await sql(e,'SELECT * FROM sources ORDER BY id').all()).results;
      const labels:Record<string,string>={eis:'ЕИС',b2b:'B2B-Center',...Object.fromEntries(Object.entries(publicCatalogues).map(([id,c])=>[id,c.name]))};
      const sourceStatus=sources.map(s=>(s.id.startsWith('mac/')?'Mac · '+(labels[s.id.slice(4)]||s.id.slice(4)):(labels[s.id]||s.id))+': '+(s.last_error||(s.last_ok?'проверено '+new Date(s.last_ok*1000).toISOString():'проверки ещё не было'))).join('\n');
      const a=await sql(e,'SELECT * FROM agent_state WHERE id=1').first();
      const count=await sql(e,"SELECT count(*) AS n,min(created) AS oldest FROM jobs WHERE state IN ('queued','running')").first();
      const cards=await sql(e,'SELECT count(*) AS n FROM pending_cards').first();
      const usage=await sql(e,"SELECT total,background FROM scan_usage WHERE day=date('now')").first();
      const budget=scanBudget(e);
      const sample=await sql(e,'SELECT count(*) AS total,count(published) AS dated FROM delivery_observations WHERE sent>=unixepoch()-604800').first();
      const percentile=sample?.dated?await sql(e,'SELECT sent-published AS seconds FROM delivery_observations WHERE sent>=unixepoch()-604800 AND published IS NOT NULL ORDER BY sent-published LIMIT 1 OFFSET ?',Math.ceil(sample.dated*0.95)-1).first():null;
      reply=sourceStatus+'\nРЖД: чтение оригинала по ссылке /watch'+'\nMac: '+(a?.seen?new Date(a.seen*1000).toISOString():'контакта ещё не было')+'\nЗадач: '+count?.n+'\nКарточек ожидают Mac: '+cards?.n+'\nВозраст старейшей задачи разбора или КП, с: '+(count?.oldest?now()-count.oldest:0)+'\nДиск Mac, ГБ: '+(a?.free_bytes?Math.floor(a.free_bytes/1e9):'неизвестно')+'\nДоставка за 7 дней: '+(sample?.total||0)+' подтверждено, '+(sample?.dated||0)+' с известным временем публикации. P95: '+(percentile?Math.ceil(percentile.seconds/60)+' мин':'нет данных')+'\nОбходы проекта сегодня (UTC): '+(usage?.total||0)+' из '+budget.limit+', резерв ручных запусков: '+budget.reserve+'.\nРасход всего аккаунта: нет телеметрии.';break;
    }
    case '/semantic':{
      if(!e.AI){reply='Бесплатная модель поиска пока не подключена.';break;}
      const {results}=await sql(e,'SELECT n.title,n.url,r.scenario FROM semantic_results r JOIN notices n ON n.url=r.url AND n.updated=r.source_updated ORDER BY r.score DESC LIMIT 4').all();
      reply=results.map(x=>x.title.slice(0,360)+'\nСопоставлено со сценарием: '+x.scenario+'\n'+x.url).join('\n\n') || 'Очередь смысловой проверки ещё не обработана.';
      break;
    }
    case '/inbox':{
      const {results}=await sql(e,'SELECT title,url FROM notices ORDER BY updated DESC LIMIT 5').all();
      reply=results.map(x=>x.title.slice(0,320)+'\n'+x.url).join('\n\n') || 'Извещений пока нет.';break;
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
  try{
    await e.DB.batch([sql(e,'INSERT INTO updates(id) VALUES(?)',u.update_id),...mutations,sql(e,'INSERT INTO outbox(dedupe,owner,payload) VALUES(?,?,?)','update/'+u.update_id,user,JSON.stringify({text:reply,reply_markup:markup}))]);
  }catch(err){if(!await sql(e,'SELECT 1 FROM updates WHERE id=?',u.update_id).first())throw err;}
  await deliver(e);return response({});
}
async function agent(req:Request,e:Env,path:string) {
  if(!await same(req.headers.get('Authorization'),'Bearer '+(e.AGENT_KEY||''))||!e.AGENT_KEY)return response({},403);
  if(path==='/agent/check'){
    const admitted=await pollAll(e);
    await deliver(e);
    const {results}=await sql(e,'SELECT id,last_ok,last_error,cursor,next_at FROM sources ORDER BY id').all();
    return response({sources:results,admitted});
  }
  if(path==='/agent/pdf'){
    const id=req.headers.get('x-job'),lease=req.headers.get('x-lease');
    const job=await sql(e,"SELECT j.*,o.id AS owner FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision CROSS JOIN owner o WHERE j.id=? AND j.lease=? AND j.until_ts>=unixepoch() AND j.state='running' AND j.op LIKE 'pdf/%' AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.lot=j.lot AND d.revision=j.revision)",id,lease).first();
    if(!job)return response({},409);
    const blob=await req.blob();
    if(blob.size>8000000 || await blob.slice(0,5).text()!=='%PDF-')return response({},400);
    const version=await sql(e,'SELECT payload FROM versions WHERE lot=? AND revision=?',job.lot,job.revision).first();
    const answers=await sql(e,'SELECT field,value FROM answers WHERE owner=? AND lot=? AND revision=?',job.owner,job.lot,job.revision).all();
    if(!version)return response({},409);
    let approved;
    try{approved=offer(JSON.parse(version.payload),Object.fromEntries(answers.results.map(r=>[r.field,r.value])));}
    catch{return response({},409);}
    if(job.op!=='pdf/'+await hash(JSON.stringify(approved.data)))return response({},409);
    const locked=await sql(e,"UPDATE jobs SET state='uncertain' WHERE id=? AND state='running' AND lease=? RETURNING id",id,lease).first();
    if(!locked)return response({},409);
    const form=new FormData();form.set('chat_id',job.owner);form.set('document',blob,'KP.pdf');form.set('caption','Предложение для проверки и ручной подачи.');
    const sent=await fetch('https://api.telegram.org/bot'+e.BOT_TOKEN+'/sendDocument',{method:'POST',body:form});
    if(!sent.ok)return response({},502);
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
    try{card=roseltorgCard(body.html,task.url);}catch{}
    if(card)message=cardMessage(card,await saveCard(e,card));
    await e.DB.batch([sql(e,'INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT ?,owner,? FROM pending_cards WHERE url=? AND lease=?','card/'+task.request_id,JSON.stringify(message),task.url,task.lease),sql(e,'DELETE FROM pending_cards WHERE url=? AND lease=?',task.url,task.lease)]);
    await deliver(e);
    return response({});
  }
  if(path==='/agent/catalogue'){
    if(!Object.hasOwn(publicCatalogues,body.source)||typeof body.html!=='string'||body.html.length>3000000)return response({},400);
    const error=body.error==='unavailable'?'Площадка недоступна с Mac':'';
    return response(await macCatalogue(e,body.source as keyof typeof publicCatalogues,body.html,error));
  }
  if(path==='/agent/heartbeat'){
    await sql(e,'UPDATE agent_state SET seen=unixepoch(),free_bytes=? WHERE id=1',Number(body.free_bytes)||0).run();
    const state=await sql(e,'SELECT paused FROM agent_state WHERE id=1').first();
    const failed=await sql(e,"SELECT id FROM sources WHERE id IN ('roseltorg','tektorg','gpb') AND last_error IS NOT NULL").all();
    const pending=await sql(e,"SELECT 1 FROM pending_cards WHERE available<=unixepoch() LIMIT 1").first();
    return response({...state,pendingCard:Boolean(pending),failedCatalogues:failed.results.map(r=>r.id)});
  }
  if(path==='/agent/claim'){
    const job=await sql(e,"UPDATE jobs SET state='running',lease=?,until_ts=unixepoch()+300,attempts=attempts+1 WHERE id=(SELECT j.id FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision WHERE (j.state='queued' OR (j.state='running' AND j.until_ts<unixepoch())) AND j.attempts<4 AND (SELECT paused FROM agent_state WHERE id=1)=0 ORDER BY j.created LIMIT 1) RETURNING *",crypto.randomUUID()).first();
    if(!job)return response(null);
    const version=await sql(e,'SELECT payload FROM versions WHERE lot=? AND revision=?',job.lot,job.revision).first();
    return response({...job,card:JSON.parse(version!.payload)});
  }
  if(path==='/agent/result'){
    if(typeof body.text!=='string'||body.text.length>3500)return response({},400);
    const args=[body.id,body.lease];
    await e.DB.batch([
      sql(e,"INSERT OR IGNORE INTO outbox(dedupe,owner,payload) SELECT 'job/'||j.id,o.id,? FROM jobs j JOIN lots l ON l.id=j.lot AND l.revision=j.revision CROSS JOIN owner o WHERE j.id=? AND j.lease=? AND j.state='running' AND j.until_ts>=unixepoch()",JSON.stringify({text:body.text}),...args),
      sql(e,"UPDATE jobs SET state='done' WHERE id=? AND lease=? AND until_ts>=unixepoch()",...args)
    ]);return response({});
  }
  return response({},404);
}
export default {
  async fetch(req:Request,e:Env){
    const path=new URL(req.url).pathname;
    if(req.method==='GET' && path==='/health')return response({release:e.RELEASE||'unknown'});
    if(path==='/setup')return setup(req,e,same,hash);
    if(req.method!=='POST')return response({},404);
    if(path==='/telegram')return telegram(req,e);
    if(path.startsWith('/agent/'))return agent(req,e,path);
    return response({},404);
  },
  async scheduled(_event:unknown,e:Env){const admitted=await pollAll(e,true);await deliver(e);if(admitted)await rankNotices(e);}
};
