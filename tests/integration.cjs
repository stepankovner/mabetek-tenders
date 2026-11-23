/* Uses the real worker with SQLite. Only network providers are replaced. */
const assert=require('node:assert/strict');
const test=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tender-worker-'));
const localTsc=path.join(root,'node_modules','.bin','tsc');
execFileSync(process.env.TSC||(fs.existsSync(localTsc)?localTsc:'tsc'),['--outDir',tmp,'--target','ES2022','--module','commonjs','--allowJs','--skipLibCheck','src/worker.ts'],{cwd:root});
const worker=require(path.join(tmp,'worker.js')).default;
process.on('exit',()=>fs.rmSync(tmp,{recursive:true,force:true}));

function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const name of fs.readdirSync('migrations').sort())db.exec(fs.readFileSync('migrations/'+name,'utf8'));
  const wrap=(s,params=[])=>({
    bind:(...p)=>wrap(s,p),
    first:async()=>db.prepare(s).get(...params),
    all:async()=>({results:db.prepare(s).all(...params)}),
    run:async()=>db.prepare(s).run(...params)
  });
  return {db,env:{BOT_TOKEN:'fixture',WEBHOOK_SECRET:'test-webhook',AGENT_KEY:'test-Mac',DB:{
    prepare:wrap,batch:async(q)=>{db.exec('BEGIN');try{const results=[];for(const st of q)results.push({meta:await st.run()});db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}
  }}};
}
test('Telegram, D1, очередь Mac и возврат PDF; повтор, изменение, приватность',async()=>{
 const {db,env}=fixture();
 const sent=[],docs=[];
 const card='https://rzd.rts-tender.ru/TenderInterests/LogViewAndRedirect?tenderId=24233643&tenderStatus=RTS_Notification';
 let location='Место указано в техническом задании';
 const original=global.fetch;
 global.fetch=async(url,opts)=>{
   if(String(url)===card){
     const fields={'Наименование':'Погрузка и выгрузка грузов','Заказчик':'Учебный заказчик','Место поставки':location,'Регион':'Хабаровский край','Площадка':'РТС-тендер','Статус на площадке':'Прием заявок','Дата окончания подачи заявок':'24.11.2099 02:00 МСК'};
     return new Response('<a href="/Tenders/Apply?tenderId=24233643&amp;registrationNumber=32616584495">Подать</a><table>'+Object.entries(fields).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'<tr><td><a href="https://223.rts-tender.ru/files/FileDownloadHandler.ashx?FileGuid=364e6c01-2acd-4dd3-b3fa-18140140ffb7">Извещение.doc</a></td></tr></table>');
   }
   if(String(url).endsWith('/sendMessage')){sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:sent.length}});}
   if(String(url).endsWith('/sendDocument')){docs.push(opts.body);return Response.json({ok:true,result:{message_id:128}});}
   throw Error('unexpected provider');
 };
 let seq=0;
 const call=(path,body,headers)=>worker.fetch(new Request('https://test.invalid'+path,{method:'POST',headers,body:typeof body==='string'||body instanceof Buffer?body:JSON.stringify(body)}),env);
 const talk=async(text,user=1,update=++seq)=>call('/telegram',{update_id:update,message:{chat:{type:'private',id:user},from:{id:user},text}},{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET});
 const agent=async(path,body)=> (await call('/agent/'+path,body,{Authorization:'Bearer '+env.AGENT_KEY})).json();
 try{
   assert.equal((await call('/telegram',{},{})).status,403);
   assert.equal((await call('/agent/claim',{},{})).status,403);
   db.prepare('INSERT INTO pairing VALUES(?,unixepoch()+300)').run(crypto.createHash('sha256').update('fixture-pairing').digest('hex'));
   await talk('/start fixture-pairing');
   await talk('/start fixture-pairing',2);
   assert.equal(sent.length,1);
   await talk('/sources',2);
   assert.equal(sent.length,1);
   await talk('/sources');
   const sources=sent.at(-1);
   assert.match(sources.text,/Хабаровский край/);
   assert.match(sources.text,/\/watch/);
   const sourceLinks=sources.reply_markup.inline_keyboard.flat();
   assert.equal(sourceLinks.length,16);
   assert.ok(sourceLinks.every(({url})=>new URL(url).protocol==='https:'));
   assert.ok(sourceLinks.some(({url})=>url==='https://www.rts-tender.ru/poisk/'));
   await talk('/watch '+card);const n=sent.length;await talk('/watch '+card,1,seq);assert.equal(sent.length,n);
   const liveCard=sent.at(-1);
   const docsButton=liveCard.reply_markup.inline_keyboard.flat().find(b=>b.text==='Документы');
   assert.ok(docsButton);
   await talk(docsButton.callback_data);
   assert.match(sent.at(-1).text,/приложени/i);
   assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE op='analysis'").get().n,1);
   await talk('/analyze 1 1');await talk('/analyze 1 1');
   const job=await agent('claim',{});assert.equal(job.op,'analysis');assert.equal(await agent('claim',{}),null);
   await talk('/analyze 1 1');assert.match(sent.at(-1).text,/обрабатывает/i);
   await agent('result',{id:job.id,lease:job.lease,text:'результат'});
   await talk('/analyze 1 1');assert.match(sent.at(-1).text,/готов/i);
   await talk('/terms 1 1');
   for(const input of ['Выгрузка','1.5','т','3.33','20%' ,'1 декабря','после акта','25 ноября','1'])await talk(input);
   const approval=sent.at(-1);assert.match(approval.text,/5.00 ₽/);assert.match(approval.text,/32616584495\/1/);
   await talk(approval.reply_markup.inline_keyboard[1][0].callback_data);
   assert.match(sent.at(-1).text,/Значения для переноса/);
   assert.match(sent.at(-1).text,/20%/);
   const word = sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
   await talk(word);
   assert.equal(docs[0].get('document').name,'RZD-32616584495-lot-1.docx');
   assert.match(docs[0].get('caption'),/НДС перенесена/);
   await talk(word);
   assert.equal(docs.length,1);
   await talk(approval.reply_markup.inline_keyboard[0][0].callback_data);
   const pdfJob=await agent('claim',{});assert.match(pdfJob.op,/^pdf\//);
   const pdf=Buffer.from('%PDF-1.7\nfixture');
   const headers={Authorization:'Bearer '+env.AGENT_KEY,'x-job':String(pdfJob.id),'x-lease':pdfJob.lease};
   const transport=global.fetch;
   global.fetch=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:35}},{status:429});
   assert.equal((await call('/agent/pdf',pdf,headers)).status,202);
   assert.equal(await agent('claim',{}),null);
   db.exec("UPDATE jobs SET until_ts=0 WHERE state='queued'; UPDATE telegram_cooldown SET until_ts=0");
   global.fetch=transport;
   const retried=await agent('claim',{});
   assert.equal(retried.id,pdfJob.id);
   headers['x-lease']=retried.lease;
   await agent('result',{id:retried.id,lease:retried.lease,text:'не результат разбора'});
   assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(retried.id).state,'running');
   global.fetch=async()=>Response.json({ok:false,error_code:400},{status:400});
   assert.equal((await call('/agent/pdf',pdf,headers)).status,502);
   assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(retried.id).state,'failed');
   global.fetch=transport;
   await talk(approval.reply_markup.inline_keyboard[0][0].callback_data);
   const confirmedAgain=await agent('claim',{});
   headers['x-lease']=confirmedAgain.lease;
   assert.equal((await call('/agent/pdf',pdf,headers)).status,200);
   assert.equal(docs.length,2);
   assert.equal((await call('/agent/pdf',pdf,headers)).status,409);
   await talk('/testword');
   const testDocument=docs.at(-1).get('document');
   assert.equal(testDocument.name,'Mabetek-delivery-test.docx');
   assert.match(await testDocument.text(),/ТЕСТ ДОСТАВКИ/);
   await talk('/terms 1 1');location='Другая площадка';await talk('/watch '+card);
   await talk('ответ старой версии');assert.match(sent.at(-1).text,/обновился/);
   assert.equal(db.prepare('select state from offers').get().state,'устарело');
 }finally{global.fetch=original;db.close();}
});
test('Registration accepts same-site form with opaque Origin but requires the agent key',async()=>{
  const {env,db}=fixture();
  try{
    const make=(origin,site)=>new Request('https://test.invalid/setup',{method:'POST',headers:{origin,'sec-fetch-site':site},body:new URLSearchParams({key:'wrong'})});
    assert.equal(await (await worker.fetch(make('null','same-origin'),env)).text(),'Доступ запрещён');
    assert.equal(await (await worker.fetch(make('https://other.invalid','cross-site'),env)).text(),'Недоступно');
  }finally{db.close();}
});
test('B2B stores one notice from a tracked catalogue URL and honors Retry-After',async()=>{
  const {db,env}=fixture();
  db.exec("INSERT INTO owner(id) VALUES('1')");
  const monitor=require(path.join(tmp,'monitor.js'));
  const previous=global.fetch;
  const slug='/market/pogruzka-vagonov/tender-1234567/';
  const unrelated='/market/dostavka-kantstovarov/tender-2345678/';
  let limited=true;
  global.fetch=async url=>{
    if(limited)return new Response(null,{status:429,headers:{'Retry-After':'2400'}});
    if(String(url).includes('market-search'))return new Response('<a href="'+slug+'#btid=2"></a><a href="'+slug+'">№ 1234567</a><a href="'+unrelated+'">№ 2345678</a>');
    if(url==='https://www.b2b-center.ru'+unrelated)return new Response('<title>Доставка канцелярских товаров — Тендер № 2345678 — B2B-Center</title>');
    assert.equal(url,'https://www.b2b-center.ru'+slug);
    return new Response('<title>Погрузка вагонов в Хабаровске — Тендер № 1234567 — B2B-Center</title>');
  };
  try{
    await monitor.b2b(env);
    assert.ok(db.prepare("SELECT next_at-unixepoch() AS delay FROM sources WHERE id='b2b'").get().delay>=2399);
    limited=false;
    for(let i=0;i<2;i++){
      db.exec("UPDATE sources SET next_at=0 WHERE id='b2b'");
      await monitor.b2b(env);
    }
    assert.deepEqual(db.prepare('SELECT title FROM notices ORDER BY title').all().map(r=>r.title),['Доставка канцелярских товаров','Погрузка вагонов в Хабаровске']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,1);
    assert.equal(db.prepare('SELECT dedupe FROM outbox').get().dedupe,'b2b/1234567');
    assert.equal(db.prepare("SELECT last_error FROM sources WHERE id='b2b'").get().last_error,null);
  }finally{global.fetch=previous;db.close();}
});
test('B2B retains verified notices when original cards fail or hit a limit',async()=>{
 const {db,env}=fixture(),previous=global.fetch;
 const monitor=require(path.join(tmp,'monitor.js'));
 let rateLimit=false;
 const seen=[];
 global.fetch=async url=>{
   if(String(url).includes('market-search'))return new Response([1111,2222,3333].map(id=>'<a href="/market/card/tender-'+id+'/">'+id+'</a>').join(''));
   const id=String(url).match(/tender-(\d+)/)[1];
   seen.push(id);
   if(id==='2222')return rateLimit
     ?new Response(null,{status:429,headers:{'Retry-After':'2400'}})
     :new Response(null,{status:404});
   return new Response('<title>Погрузка вагонов — Тендер № '+id+' — B2B-Center</title>');
 };
 try{
   db.exec("INSERT INTO owner(id) VALUES('1')");
   await monitor.b2b(env);
   assert.deepEqual(seen,['1111','2222','3333']);
   assert.equal(db.prepare('SELECT count(*) AS n FROM notices').get().n,2);
   const partial=db.prepare("SELECT cursor,last_ok,last_error FROM sources WHERE id='b2b'").get();
   assert.equal(partial.last_ok,null);
   assert.match(partial.last_error,/Частичный обход/);
   rateLimit=true;
   db.exec("DELETE FROM notices WHERE url LIKE '%3333%'; UPDATE sources SET next_at=0");
   await monitor.b2b(env);
   assert.deepEqual(seen,['1111','2222','3333','2222']);
   const limited=db.prepare("SELECT cursor,last_error,next_at-unixepoch() AS delay FROM sources WHERE id='b2b'").get();
   assert.equal(limited.cursor,partial.cursor);
   assert.match(limited.last_error,/HTTP 429/);
   assert.ok(limited.delay>=2399);
 }finally{global.fetch=previous;db.close();}
});
test('Scheduled EIS poll sends a matching notice once and skips unrelated supplies',async()=>{
 const {db,env}=fixture();
 db.exec("INSERT INTO owner(id) VALUES('1')");
 const previous=global.fetch, sent=[];
 const published=new Date(Date.now()-600000).toUTCString();
 const items=['Услуги по выгрузке вагонов в Хабаровске','Поставка железнодорожных колёс в Хабаровск','Выгрузка вагонов в Беркаките','Разгрузка вагонов'];
 global.fetch=async(url,opts)=>{
   if(String(url).startsWith('https://zakupki.gov.ru/')) return new Response('<rss><channel>'+items.map((title,i)=>'<item><link>https://zakupki.gov.ru/'+i+'</link><title>'+title+'</title><pubDate>'+published+'</pubDate></item>').join('')+'</channel></rss>');
   if(String(url).endsWith('/sendMessage')){sent.push(JSON.parse(opts.body).text);return Response.json({ok:true,result:{message_id:55,date:Math.floor(Date.now()/1000)}});}
   return new Response('',{status:503});
 };
 try{
   for(let i=0;i<2;i++){db.exec("UPDATE sources SET next_at=0");await worker.scheduled({},env);}
   assert.equal(sent.length,1);
   const delivery=db.prepare('SELECT sent-published AS seconds FROM delivery_observations').get();
   assert.ok(delivery.seconds>=600 && delivery.seconds<=605);
   assert.match(sent[0],/выгрузке вагонов/);
   assert.equal(db.prepare('SELECT count(*) n FROM notices').get().n,4);
 }finally{global.fetch=previous;db.close();}
});
test('Semantic queue survives quota errors, caches profile and updates edited notices',async()=>{
 const {db,env}=fixture();
 const {rankNotices}=require(path.join(tmp,'semantic.js'));
 db.prepare("INSERT INTO notices(url,title,updated) VALUES(?,?,1)").run('https://zakupki.gov.ru/a','Приём гружёных вагонов');
 const calls=[];
 let down=true;
 env.AI={run:async(model,args)=>{calls.push(args.text);if(down)throw Error('quota');return {data:args.text.map((s,i)=>[1,1+i])};}};
 try{
   await rankNotices(env);assert.equal(db.prepare('SELECT count(*) AS n FROM semantic_results').get().n,0);
   down=false;
   await rankNotices(env);assert.equal(db.prepare('SELECT count(*) AS n FROM semantic_results').get().n,1);
   const n=calls.length;
   await rankNotices(env);assert.equal(calls.length,n);
   db.exec("UPDATE notices SET updated=2,title='Уточнённый предмет'");
   await rankNotices(env);
   assert.equal(calls.length,n+1);assert.equal(calls.at(-1).length,1);
   assert.equal(db.prepare('SELECT source_updated FROM semantic_results').get().source_updated,2);
 }finally{db.close();}
});
test('Publish smoke reports its revision and permits live polling only to the Mac owner',async()=>{
 const {db,env}=fixture();
 env.RELEASE='test-revision';
 const previous=global.fetch;
 global.fetch=async()=>new Response('',{status:503});
 try{
   const health=await worker.fetch(new Request('https://example.test/health'),env);
   assert.equal((await health.json()).release,'test-revision');
   const check=key=>worker.fetch(new Request('https://example.test/agent/check',{method:'POST',headers:{Authorization:'Bearer '+key},body:'{}'}),env);
   assert.equal((await check('wrong')).status,403);
   const now=Math.floor(Date.now()/1000);
   const add=db.prepare('INSERT INTO delivery_observations VALUES(?,?,?,?,?)');
   for(let i=1;i<=20;i++)add.run(i,'catalogue',now-i,now,i===20?null:now-2*i);
   const res=await check(env.AGENT_KEY);
   const status=await res.json();
   assert.deepEqual(status.delivery,{total:20,dated:19,publication_p95_seconds:38,queued:20,queue_p95_seconds:19});
   assert.equal(status.sources.length,13);
   assert.ok(status.sources.some(s=>s.id==='rosneft'));
   assert.ok(status.sources.some(s=>s.id==='tektorgRzd'));
   assert.ok(status.sources.some(s=>s.id==='zakazrf'));
   assert.ok(status.sources.some(s=>s.id==='rad'));
   assert.ok(status.sources.filter(s=>s.id!=='watch/rzd').every(s=>s.last_error&&!s.last_ok));
   const watch=status.sources.find(s=>s.id==='watch/rzd');assert.equal(watch.last_ok,null);assert.equal(watch.last_error,null);
 } finally{db.close();global.fetch=previous;}
});
test('Roseltorg advances its cursor after writing matches and preserves it on a source failure',async()=>{
 const {db,env}=fixture(); const monitor=require(path.join(tmp,'monitor.js'));
 const old=global.fetch;let fail=false;
 try{
  global.fetch=async url=>{
   const u=new URL(url);assert.equal(u.pathname,'/procedures/search_ajax');assert.equal(u.searchParams.get('status[]'),'0');
   if(fail)return new Response('unavailable',{status:503});
   return new Response('<a href="/procedure/B12345678/2" class="search-results__link--description">Услуги по выгрузке вагонов в Хабаровске</a><button class="pagination__btn--next" data-href="?page=1"></button>');
  };
  db.exec("INSERT INTO owner(id) VALUES('1')");
  await monitor.publicPoll(env,'roseltorg');
  const s=db.prepare("SELECT * FROM sources WHERE id='roseltorg'").get();
  assert.ok(s.last_ok);assert.equal(JSON.parse(s.cursor).pages[0],1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
  fail=true;db.exec("UPDATE sources SET next_at=0");
  await monitor.publicPoll(env,'roseltorg');
  assert.equal(db.prepare("SELECT cursor FROM sources WHERE id='roseltorg'").get().cursor,s.cursor);
 }finally{global.fetch=old;db.close();}
});
test('Offer uses the verified Roseltorg lot and requires a named customer',()=>{
 const {offer,questions}=require(path.join(tmp,'dialog.js'));
 const answers=Object.fromEntries(questions.map(([key])=>[key,'1']));
 const card={customer:'Заказчик',lot:'2',procedure:'1234'};
 assert.throws(()=>offer(card,answers),/указан лот 2/);
 answers.verified='2';
 assert.equal(offer(card,answers).data.lot,'1234/2');
 assert.throws(()=>offer({...card,customer:''},answers),/не указан заказчик/);
});
test('Mac catalogue independently reports errors and shares cloud notice deduplication',async()=>{
 const {db,env}=fixture();
 const {macCatalogue}=require(path.join(tmp,'monitor.js'));
 const html='<a href="/procedure/B12345678/2" class="search-results__link--description">Услуги по выгрузке вагонов в Хабаровске</a>';
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  await macCatalogue(env,'roseltorg',html,'');
  await macCatalogue(env,'roseltorg',html,'');
  await macCatalogue(env,'roseltorg','blocked','');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
  const status=db.prepare("SELECT * FROM sources WHERE id='mac/roseltorg'").get();
  assert.ok(status.last_ok);assert.match(status.last_error,/Не распознана/);
 }finally{db.close();}
});
test('Mac upload dispatches a new match before cron and ignores repeated uploads',async()=>{
 const {db,env}=fixture(),original=global.fetch,pending=[];
 const html='<a href="/procedure/B12345678/2" class="search-results__link--description">Услуги по выгрузке вагонов в Хабаровске</a>';
 let sent=0;
 global.fetch=async(url)=>{if(String(url).includes('roseltorg.ru'))return new Response(null,{status:503});assert.ok(String(url).endsWith('/sendMessage'));return Response.json({ok:true,result:{message_id:++sent,date:Math.floor(Date.now()/1000)}});};
 const upload=()=>worker.fetch(new Request('https://test.invalid/agent/catalogue',{method:'POST',headers:{Authorization:'Bearer '+env.AGENT_KEY},body:JSON.stringify({source:'roseltorg',html})}),env,{waitUntil:task=>pending.push(task)});
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  assert.deepEqual(await (await upload()).json(),{count:1,error:null});
  await Promise.all(pending);
  await upload();
  assert.equal(pending.length,1);assert.equal(sent,1);
  assert.equal(db.prepare('SELECT state FROM outbox').get().state,'sent');
 }finally{global.fetch=original;db.close();}
});
test('Changed B2B titles refresh the stored original without a duplicate Telegram notification',async()=>{
 const {db,env}=fixture(), old=global.fetch;
 const monitor=require(path.join(tmp,'monitor.js'));
 let title='Погрузка вагонов в Хабаровске';
 global.fetch=async()=>new Response('<a href="/market/gruz/tender-9999/">Тендер</a><p class="panel-procedure__dscr-main">'+title+'</p>');
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  await monitor.b2b(env);
  const before=db.prepare('SELECT updated FROM notices').get().updated;
  title='Погрузка вагонов на площадке исполнителя в Хабаровске';
  db.exec('UPDATE sources SET next_at=0');
  await monitor.b2b(env);
  const row=db.prepare('SELECT title,updated FROM notices').get();
  assert.equal(row.title,title);assert.ok(row.updated>before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
 }finally{global.fetch=old;db.close();}
});
test('Daily background quota leaves room for a manual scan',async()=>{
 const {db,env}=fixture(), old=global.fetch;
 Object.assign(env,{SCAN_DAILY_LIMIT:'2',SCAN_COMMAND_RESERVE:'1'});
 global.fetch=async()=>new Response('',{status:503});
 const check=()=>worker.fetch(new Request('https://example.test/agent/check',{method:'POST',headers:{Authorization:'Bearer '+env.AGENT_KEY},body:'{}'}),env).then(r=>r.json());
 try{
  await worker.scheduled({},env);await worker.scheduled({},env);
  assert.equal(db.prepare('SELECT total FROM scan_usage').get().total,1);
  assert.equal((await check()).admitted,true);
  assert.equal((await check()).admitted,false);
 }finally{global.fetch=old;db.close();}
});
test('Unreadable Roseltorg card reaches Mac once and returns to the owner chat',async()=>{
 const {db,env}=fixture(),old=global.fetch, messages=[];
 global.fetch=async(url,opts)=>{
  if(String(url).endsWith('/sendMessage')){messages.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:messages.length}});}
  return new Response('',{status:503});
 };
 const agent=(path,data)=>worker.fetch(new Request('https://example.test/agent/'+path,{method:'POST',headers:{Authorization:'Bearer '+env.AGENT_KEY},body:JSON.stringify(data)}),env);
 const url='https://www.roseltorg.ru/procedure/12345678/1';
 async function watch(id){
  await worker.fetch(new Request('https://example.test/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify({update_id:id,message:{chat:{type:'private',id:1},from:{id:1},text:'/watch '+url}})}),env);
 }
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  await watch(1);await watch(2);
  assert.match(messages.at(-1).text,/передана на Mac/);
  const task=await (await agent('card-claim',{})).json();
  assert.equal(task.url,url);assert.equal(await (await agent('card-claim',{})).json(),null);
  const html='<div class="lot-page__left-column-lot" data-feature-favorite-lots-procedure-number="12345678" data-feature-favorite-lots-lot-number="1"><h1>Погрузка вагонов</h1></div>';
  assert.equal((await agent('card-result',{...task,html})).status,200);
  assert.equal(messages.at(-1).chat_id,'1');assert.match(messages.at(-1).text,/Погрузка вагонов/);
  assert.equal((await agent('card-result',{...task,html})).status,409);
  assert.equal(db.prepare('SELECT count(*) n FROM lots').get().n,1);
 }finally{global.fetch=old;db.close();}
});

test('Черновик РЖД открывается как DOCX и переносит только однозначную ставку',async()=>{
 const {draftWord}=require(path.join(tmp,'rzd-form.js'));
 for(const [vat,filled] of [['22% в том числе',true],['без НДС',false],['0%',true],['не 20%',false],['5% или 7%',false]]){
   const draft=draftWord('1',vat);
   assert.equal(draft.filled,filled);
   const doc=Buffer.from(await draft.file.arrayBuffer());
   const content=execFileSync('python3',['-c',`import sys,io,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
print(''.join(E.fromstring(z.read('word/document.xml')).itertext()))`],{input:doc}).toString();
   assert.match(content,/Черновик.*32616584495, лот 1/);
   assert.ok(content.includes('составляет '+(filled?vat.split('%')[0]:'____')+' процентов'));
 }
 assert.throws(()=>draftWord('<2','0%'));
});

test('EAT sends a matching original only to the owner, rejects invalid URLs and deduplicates retries',async()=>{
 const {db,env}=fixture(),original=global.fetch,pending=[],sent=[];
 const card={procedure:'100000000000000001',title:'Услуги по выгрузке вагонов в Хабаровске',url:'https://agregatoreat.ru/purchases/announcement/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/'};
 const upload=(data)=>worker.fetch(new Request('https://test.invalid/agent/eat-candidate',{method:'POST',headers:{Authorization:'Bearer '+env.AGENT_KEY},body:JSON.stringify(data)}),env,{waitUntil:task=>pending.push(task)});
 global.fetch=async(url,opts)=>{assert.ok(String(url).endsWith('/sendMessage'));sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:1,date:Math.floor(Date.now()/1000)}});};
 try{
  assert.equal((await upload(card)).status,503);
  db.exec("INSERT INTO owner(id) VALUES('1')");
  assert.equal((await upload({...card,url:'https://example.com/'})).status,400);
  assert.deepEqual(await (await upload({...card,title:'Поставка мебели'})).json(),{status:'filtered'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notices').get().n,0);
  assert.deepEqual(await (await upload(card)).json(),{status:'accepted'});
  await Promise.all(pending);
  await upload(card);
  assert.equal(sent.length,1);
  assert.equal(sent[0].chat_id,'1');
  assert.ok(sent[0].text.includes(card.url));
 }finally{global.fetch=original;db.close();}
});

test('Regional RZD marketplace accepts its own original and places it in the owner queue', async()=>{
 const {db,env}=fixture(),pending=[],original=global.fetch;
 const upload=(url,published)=>worker.fetch(new Request('https://test.invalid/agent/comita-candidate',{method:'POST',headers:{Authorization:'Bearer '+env.AGENT_KEY},body:JSON.stringify({title:'Услуги по выгрузке вагонов в Хабаровске',procedure:'241937',url,published})}),env,{waitUntil:task=>pending.push(task)});
 global.fetch=async()=>Response.json({ok:true,result:{message_id:2,date:Math.floor(Date.now()/1000)}});
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  assert.equal((await upload('https://example.org/')).status,400);
  const url='https://eshoprzd.ru/purchases/4ee4b3eb-028e-4967-867b-19cfcdd06fba';
  const published=new Date(Date.now()-60000).toISOString();
  assert.equal((await upload(url,'2020-02-31T00:00:00.000Z')).status,400);
  assert.equal((await upload(url,new Date(Date.now()+3600000).toISOString())).status,400);
  assert.deepEqual(await (await upload(url,published)).json(),{status:'accepted'});
  await Promise.all(pending);
  assert.equal(db.prepare('SELECT published FROM notices WHERE url=?').get(url).published,published);
  assert.equal(db.prepare('SELECT published FROM delivery_observations').get().published,Math.floor(Date.parse(published)/1000));
  assert.match(db.prepare('SELECT description FROM notices WHERE url=?').get(url).description,/КОМИТА РЖД/);
  assert.equal(db.prepare('SELECT state FROM outbox WHERE dedupe=?').get(url).state,'sent');
 }finally{db.close();global.fetch=original}
});

test('Mac reports a real source scan independently of matching lots and preserves the last success on failure',async()=>{
 const {db,env}=fixture();
 const post=(path,body)=>worker.fetch(new Request('https://test.invalid/agent/'+path,{method:'POST',headers:{Authorization:'Bearer '+env.AGENT_KEY},body:JSON.stringify(body)}),env);
 try{
  for(const ok of [true,false])assert.equal((await post('scan-report',{source:'rts-rzd-search',ok})).status,200);
  const row=db.prepare("SELECT last_ok,last_error FROM sources WHERE id='mac/rts-rzd-search'").get();
  assert.ok(row.last_ok);assert.ok(row.last_error);
  await post('scan-report',{source:'rts-rzd-search',ok:false,reason:'rts_public_search_unavailable'});
  assert.match(db.prepare("SELECT last_error FROM sources WHERE id='mac/rts-rzd-search'").get().last_error,/503.*Anti-DDoS/);
  await post('scan-report',{source:'rts-rzd-search',ok:true});
  assert.equal(db.prepare("SELECT last_error FROM sources WHERE id='mac/rts-rzd-search'").get().last_error,null);
  assert.equal((await post('scan-report',{source:'anything',ok:true})).status,400);
  const regional={title:'Поставка мебели',procedure:'123',url:'https://etp.otc.ru/tender/123'};
  const eisCard={url:'https://zakupki.gov.ru/epz/pricereq/card/common-info.html?reestrNumber=0332200065926000089',procedure:'0332200065926000089',title:'Поставка медицинских изделий'};
  await post('scan-report',{source:'eis-price_requests',ok:false,partial:true,reason:'eis_pagination_404'});
  const partial=db.prepare("SELECT last_ok,last_error FROM sources WHERE id='mac/eis-price_requests'").get();
  assert.equal(partial.last_ok,null);
  assert.match(partial.last_error,/Частичный обход.*HTTP 404/);
  assert.equal((await post('scan-report',{source:'eis-price_requests',ok:true})).status,200);
  assert.equal(db.prepare("SELECT last_error FROM sources WHERE id='mac/eis-price_requests'").get().last_error,null);
  assert.equal((await post('eis-candidate',{...eisCard,procedure:'0332200065926000081'})).status,400);
  assert.deepEqual(await (await post('eis-candidate',eisCard)).json(),{status:'filtered'});
  db.exec("INSERT INTO owner(id) VALUES('1')");
  assert.deepEqual(await (await post('eis-candidate',{...eisCard,review:true})).json(),{status:'filtered'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notices WHERE url=?').get(eisCard.url).n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,0);
  const order223={url:'https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616574907',procedure:'32616574907',title:'Поставка медицинских изделий'};
  assert.deepEqual(await (await post('eis-candidate',order223)).json(),{status:'filtered'});
  assert.equal((await post('eis-candidate',{...order223,procedure:'32616574908'})).status,400);
  assert.equal((await post('scan-report',{source:'otc-khab',ok:true})).status,200);
  assert.deepEqual(await (await post('otc-region-candidate',regional)).json(),{status:'filtered'});
  assert.equal((await post('otc-region-candidate',{...regional,procedure:'12'})).status,400);
  const card={title:'Поставка мебели',procedure:'4112329',url:'https://223.rts-tender.ru/supplier/auction/Trade/View.aspx?Id=4112329#1'};
  assert.deepEqual(await (await post('rts-candidate',card)).json(),{status:'filtered'});
  assert.equal((await post('rts-candidate',{...card,procedure:'123'})).status,400);
 }finally{db.close()}
});

test('EIS 223 redirects and legacy URLs deliver one alert for the same procurement',async()=>{
 const {db,env}=fixture(),pending=[],sent=[],original=global.fetch;
 const base='https://zakupki.gov.ru';
 const procedure='32616574907';
 const legacy=base+'/epz/order/notice/notice223/common-info.html?regNumber='+procedure;
 const current=base+'/223/purchase/public/purchase/info/common-info.html?regNumber='+procedure;
 const upload=url=>worker.fetch(new Request('https://test.invalid/agent/eis-candidate',{
   method:'POST',headers:{Authorization:'Bearer '+env.AGENT_KEY},
   body:JSON.stringify({url,procedure,title:'Услуги по выгрузке вагонов в Хабаровске'})
 }),env,{waitUntil:task=>pending.push(task)});
 global.fetch=async(url,options)=>{
   assert.ok(String(url).endsWith('/sendMessage'));
   sent.push(JSON.parse(options.body));
   return Response.json({ok:true,result:{message_id:sent.length,date:Math.floor(Date.now()/1000)}});
 };
 try{
   db.exec("INSERT INTO owner(id) VALUES('1')");
   // An older deployment may already have sent a message under either exact URL.
   db.prepare("INSERT INTO outbox(dedupe,owner,payload,state) VALUES(?,'1','{}','sent')").run('eis/'+current);
   assert.equal((await upload(legacy)).status,200);
   await Promise.all(pending);
   assert.equal(sent.length,0);
   db.exec('DELETE FROM outbox');
   assert.equal((await upload(legacy)).status,200);
   await Promise.all(pending);
   assert.equal((await upload(current)).status,200);
   await Promise.all(pending);
   assert.equal(sent.length,1);
   assert.match(sent[0].text,/notice223/);
 }finally{db.close();global.fetch=original;}
});

test('Telegram opens EIS through Mac and requires a freshly verified original before PDF delivery',async()=>{
 const {db,env}=fixture(),sent=[],documents=[],pending=[],original=global.fetch;
 const procedure='0322200001326000255';
 const url='https://zakupki.gov.ru/epz/order/notice/zk20/view/common-info.html?regNumber='+procedure;
 const title='Выгрузка вагонов в Хабаровске';
 const html='<span class="cardMainInfo__purchaseLink">№ '+procedure+'</span>'+
   '<span class="cardMainInfo__state">Подача заявок</span>'+
   '<span class="cardMainInfo__title">Объект закупки</span><span class="cardMainInfo__content">'+title+'</span>'+
   '<span class="cardMainInfo__title">Заказчик</span><span class="cardMainInfo__content">Заказчик из оригинала</span>'+
   '<span class="section__title">Дата и время окончания срока подачи заявок</span><span class="section__info">07.12.2099 11:00 (МСК+7)</span>';
 const post=(path,body,headers)=>worker.fetch(new Request('https://test.invalid'+path,{
   method:'POST',headers,body:body instanceof FormData||body instanceof Buffer?body:JSON.stringify(body)
 }),env,{waitUntil:task=>pending.push(task)});
 const agent=(path,body,extra={})=>post('/agent/'+path,body,{Authorization:'Bearer '+env.AGENT_KEY,...extra});
 let update=0;
 const talk=text=>post('/telegram',{update_id:++update,message:{chat:{type:'private',id:1},from:{id:1},text}},{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET});
 global.fetch=async(link,options)=>{
   if(String(link)===url)return new Response(null,{status:503});
   if(String(link).endsWith('/sendMessage'))sent.push(JSON.parse(options.body));
   else if(String(link).endsWith('/sendDocument'))documents.push(options.body);
   else throw Error('Unexpected network request');
   return Response.json({ok:true,result:{message_id:sent.length+documents.length,date:Math.floor(Date.now()/1000)}});
 };
 try{
   db.exec("INSERT INTO owner(id) VALUES('1')");
   assert.equal((await agent('eis-candidate',{url,procedure,title})).status,200);
   await Promise.all(pending);
   const button=sent.at(-1).reply_markup.inline_keyboard[0][0];
   assert.match(button.callback_data,/^\/notice \d+$/);
   await talk(button.callback_data);
   assert.match(sent.at(-1).text,/передана на Mac/);
   const task=await (await agent('card-claim',{})).json();
   assert.equal(task.url,url);
   assert.equal((await agent('card-result',{...task,html,resolved_url:url.replace(procedure,'0322200001326000256')})).status,400);
   assert.equal((await agent('card-result',{...task,html})).status,200);
   assert.match(sent.at(-1).text,/Заказчик из оригинала/);
   const terms=sent.at(-1).reply_markup.inline_keyboard.flat().find(item=>item.text==='Уточнить условия');
   await talk(terms.callback_data);
   for(const input of [title,'1','вагон','100','Без НДС','8 декабря','После акта','1 декабря','1'])await talk(input);
   const confirm=sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
   await talk(confirm);
   const job=await (await agent('claim',{})).json();
   const pdf=Buffer.from('%PDF-1.7\nfixture');
   const headers={'x-job':String(job.id),'x-lease':job.lease};
   assert.equal((await agent('pdf',pdf,headers)).status,400);
   const files=content=>{
     const form=new FormData();
     form.set('pdf',new Blob([pdf],{type:'application/pdf'}),'KP.pdf');
     form.set('original',content);
     return form;
   };
   assert.equal((await agent('pdf',files(html.replace('Подача заявок','Работа комиссии')),headers)).status,409);
   await Promise.all(pending);
   assert.equal(documents.length,0);
   assert.match(sent.at(-1).text,/КП не отправлено/);
   await talk(confirm);
   const retry=await (await agent('claim',{})).json();
   assert.equal((await agent('pdf',files(html),{'x-job':String(retry.id),'x-lease':retry.lease})).status,200);
   assert.equal(documents.length,1);
 }finally{db.close();global.fetch=original;}
});


test('Очередь соблюдает retry_after и не повторяет неоднозначную отправку',async()=>{
 const {db,env}=fixture(),original=global.fetch;
 let calls=0;
 const talk=id=>worker.fetch(new Request('https://test.invalid/telegram',{method:'POST',
   headers:{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},
   body:JSON.stringify({update_id:id,message:{chat:{id:1,type:'private'},from:{id:1},text:'/settings'}})}),env);
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  global.fetch=async()=>{calls++;return Response.json({ok:false,error_code:429,parameters:{retry_after:35}},{status:429})};
  await talk(101); await talk(102);
  assert.equal(calls,1);
  assert.equal(db.prepare("SELECT count(*) n FROM outbox WHERE state='ready'").get().n,2);
  assert.ok(db.prepare('SELECT until_ts-unixepoch() remaining FROM telegram_cooldown').get().remaining>=34);
  db.exec('UPDATE telegram_cooldown SET until_ts=0');
  global.fetch=async()=>{
    calls++;
    if(calls===2)throw new Error('network disconnected');
    if(calls===3)return Response.json({ok:false,error_code:400},{status:400});
    return Response.json({ok:true,result:{message_id:calls}});
  };
  await talk(103);await talk(104);
  assert.equal(db.prepare("SELECT state FROM outbox WHERE dedupe='update/101'").get().state,'uncertain');
  assert.equal(db.prepare("SELECT state FROM outbox WHERE dedupe='update/102'").get().state,'failed');
  assert.equal(db.prepare("SELECT count(*) n FROM outbox WHERE state='sent'").get().n,2);
 }finally{db.close();global.fetch=original}
});


test('Фоновая сверка РЖД сохраняет историю, пропускает сбой и один раз сообщает изменение',async()=>{
 const {db,env}=fixture(),original=global.fetch;
 const url='https://rzd.rts-tender.ru/TenderInterests/LogViewAndRedirect?tenderId=24233643&tenderStatus=RTS_Notification';
 let state='Приём заявок',down=false,deliveries=[];
 const run=async()=>{
  db.exec("UPDATE sources SET next_at=0 WHERE id='watch/rzd'");
  await worker.scheduled({},env);
 };
 global.fetch=async(target,options)=>{
  if(String(target)===url){
   if(down)return new Response(null,{status:503});
   return new Response('<table>'+Object.entries({'Наименование':'Погрузка вагонов','Заказчик':'РЖД','Площадка':'РТС','Статус на площадке':state}).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table>');
  }
  if(String(target).endsWith('/sendMessage')){deliveries.push(JSON.parse(options.body));return Response.json({ok:true,result:{message_id:deliveries.length}})}
  return new Response(null,{status:503});
 };
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  await worker.fetch(new Request('https://test.invalid/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify({update_id:1,message:{chat:{id:1,type:'private'},from:{id:1},text:'/watch '+url}})}),env);
  await run();down=true;await run();
  assert.equal(db.prepare('SELECT max(revision) n FROM versions').get().n,1);
  assert.ok(db.prepare("SELECT last_error FROM sources WHERE id='watch/rzd'").get().last_error);
  down=false;state='Отменена';await run();await run();
  assert.equal(db.prepare('SELECT max(revision) n FROM versions').get().n,2);
  const messages=deliveries.filter(m=>m.text.includes('Изменение в отслеживаемой'));
  assert.equal(messages.length,1);assert.equal(messages[0].chat_id,'1');
  assert.match(messages[0].text,/Приём заявок → Отменена/);
  assert.equal(db.prepare("SELECT last_error FROM sources WHERE id='watch/rzd'").get().last_error,null);
 }finally{global.fetch=original;db.close()}
});

test('Only explicit work geography triggers a catalogue alert and the original address wins',async()=>{
 const {db,env}=fixture(),original=global.fetch;
 const {noticeStatements,confirmLocation}=require(path.join(tmp,'monitor.js'));
 const {khabarovskLocation}=require(path.join(tmp,'core.mjs'));
 const url='https://www.roseltorg.ru/procedure/B12345678/2';
 const title='Выгрузка вагонов';
 const originalCard=place=>'<div class="lot-page__left-column-lot" data-feature-favorite-lots-procedure-number="B12345678" data-feature-favorite-lots-lot-number="2"><h1>'+title+'</h1><div class="lot-delivery__text"><div>'+place+'</div></div></div>';
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  for(const where of ['', 'в Беркаките', 'в Хабаровском крае', 'из Хабаровска', 'для нужд филиала в Хабаровске']){
   assert.equal(khabarovskLocation(title+' '+where),'');
  }
  global.fetch=async()=>new Response(originalCard('Хабаровский край, г. Хабаровск, ул. Пушкина, 46'));
  const location=await confirmLocation({title,url});
  assert.match(location,/оригинале.*Пушкина/);
  global.fetch=async()=>new Response(originalCard('Якутия, Беркакит'));
  assert.equal(await confirmLocation({title:title+' в Хабаровске',url}),'');
  const {statements}=noticeStatements(env,'roseltorg',[
   {title:title+' в Беркаките',url:url.replace('/2','/3')},
   {title,url:url.replace('/2','/4')},
   {title,url,location}
  ]);
  await env.DB.batch(statements);
  assert.equal(db.prepare('SELECT count(*) AS n FROM notices').get().n,3);
  assert.match(JSON.parse(db.prepare('SELECT payload FROM outbox').get().payload).text,/Пушкина/);
 }finally{global.fetch=original;db.close();}
});

test('Legacy national alerts are suppressed while Telegram commands still reply',async()=>{
 const {db,env}=fixture(),original=global.fetch,sent=[];
 const update={update_id:1,message:{chat:{type:'private',id:1},from:{id:1},text:'/inbox'}};
 global.fetch=async(url,opts)=>{
  assert.ok(String(url).endsWith('/sendMessage'));
  sent.push(JSON.parse(opts.body));
  return Response.json({ok:true,result:{message_id:sent.length}});
 };
 try{
  db.exec("INSERT INTO owner(id) VALUES('1')");
  db.prepare("INSERT INTO outbox(dedupe,owner,payload) VALUES('b2b/1234','1',?)").run(JSON.stringify({text:'Выгрузка вагонов в Беркаките'}));
  db.prepare("INSERT INTO outbox(dedupe,owner,payload) VALUES('b2b/1235','1',?)").run(JSON.stringify({text:'Выгрузка вагонов в Хабаровске',location:'Хабаровск'}));
  await worker.fetch(new Request('https://test.invalid/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(update)}),env);
  assert.equal(db.prepare("SELECT state FROM outbox WHERE dedupe='b2b/1234'").get().state,'suppressed');
  assert.equal(sent.length,2);
  assert.ok(sent.every(message=>message.text==='Выгрузка вагонов в Хабаровске' && !Object.hasOwn(message,'location')));
 }finally{global.fetch=original;db.close();}
});

test('Mac outage is reported once, recovery resumes and long status keeps all source diagnostics',async()=>{
  const {db,env}=fixture();
  env.SCAN_DAILY_LIMIT='0';
  db.prepare('INSERT INTO owner(id) VALUES(?)').run('1');
  const lastSeen=Math.floor(Date.now()/1000)-3600;
  db.prepare('UPDATE agent_state SET seen=? WHERE id=1').run(lastSeen);
  const original=global.fetch,sent=[];
  global.fetch=async(url,options)=>{
    assert.ok(String(url).endsWith('/sendMessage'));
    const body=JSON.parse(options.body);
    assert.ok(body.text.length<=4096);
    sent.push(body);
    return Response.json({ok:true,result:{message_id:sent.length,date:Math.floor(Date.now()/1000)}});
  };
  const post=(path,body,headers)=>worker.fetch(new Request('https://test.invalid'+path,{method:'POST',body:JSON.stringify(body),headers}),env);
  try{
    await worker.scheduled({},env);
    await worker.scheduled({},env);
    assert.equal(sent.length,1);
    assert.match(sent[0].text,/Mac не выходит на связь/);
    const health={release:'abcdef0123456789',pending:7,oldest:lastSeen,unreadable:0,backup_at:lastSeen};
    await post('/agent/heartbeat',{free_bytes:123,local:health},{Authorization:'Bearer '+env.AGENT_KEY});
    await worker.scheduled({},env);
    assert.equal(sent.length,2);
    assert.match(sent[1].text,/Mac снова на связи/);
    const status=await (await post('/agent/status',{}, {Authorization:'Bearer '+env.AGENT_KEY})).json();
    assert.deepEqual(status.local,health);
    for(let i=0;i<80;i++)db.prepare('INSERT INTO sources(id,url,last_error) VALUES(?,?,?)').run('source-'+i,'https://example.org/','Недоступен. '.repeat(8));
    const update={update_id:7777,message:{chat:{type:'private',id:1},from:{id:1},text:'/status'}};
    await post('/telegram',update,{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET});
    const diagnostics=sent.slice(2).map(m=>m.text).join('\n');
    for(let i=0;i<80;i++)assert.ok(diagnostics.includes('source-'+i+':'));
    assert.match(diagnostics,/Находок в локальной очереди: 7/);
    assert.match(diagnostics,/Последняя резервная копия:/);
    const count=sent.length;
    await post('/telegram',update,{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET});
    assert.equal(sent.length,count);
    db.exec('UPDATE agent_state SET paused=1,seen=1');
    await worker.scheduled({},env);
    assert.equal(sent.length,count);
  }finally{global.fetch=original;db.close();}
});
