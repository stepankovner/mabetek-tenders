/** One-time, locally authenticated setup. No credentials in paths or output. */
export async function setup(request:Request,e:any,verify:(a:string|null,b:string)=>Promise<boolean>,digest:(s:string)=>Promise<string>){
  const page=(body:string,status=200)=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'same-origin','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
  if(request.method==='GET')return page('<html lang="ru"><meta charset="utf-8"><title>Мабетэк · Настройка</title><h1>Привязка Telegram</h1><form method="post"><label>Ключ агента <input type="password" name="key" required autocomplete="off"></label> <button>Подключить Telegram</button></form></html>');
  const url=new URL(request.url);
  const origin=request.headers.get('origin');
  const sameSite=origin===url.origin || ((!origin || origin==='null') && request.headers.get('sec-fetch-site')==='same-origin');
  if(request.method!=='POST'||!sameSite||url.protocol!=='https:')return page('Недоступно',403);
  const form=await request.formData();
  if(!await verify(String(form.get('key')||''),e.AGENT_KEY))return page('Доступ запрещён',403);
  const api='https://api.telegram.org/bot'+e.BOT_TOKEN+'/';
  const me=await fetch(api+'getMe').then(r=>r.json()) as any;
  if(!me.ok||me.result.username!=='mabetek_tenders_bot')return page('Проверьте токен нового бота.',409);
  const hook=await fetch(api+'setWebhook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:url.origin+'/telegram',secret_token:e.WEBHOOK_SECRET,allowed_updates:['message','callback_query'],max_connections:2})}).then(r=>r.json()) as any;
  if(!hook.ok)return page('Telegram отклонил установку webhook.',502);
  const info=await fetch(api+'getWebhookInfo').then(r=>r.json()) as any;
  if(info.result?.url!==url.origin+'/telegram')return page('Адрес webhook требует проверки.',502);
  if(await e.DB.prepare('SELECT 1 FROM owner').first())return page('Webhook подтверждён. Владелец уже привязан.');
  const code=crypto.randomUUID().replaceAll('-','');
  await e.DB.batch([e.DB.prepare('DELETE FROM pairing'),e.DB.prepare('INSERT INTO pairing VALUES(?,unixepoch()+600)').bind(await digest(code))]);
  return page('<html lang="ru"><meta charset="utf-8"><h1>Webhook подтверждён</h1><p>Для привязки отправьте в личный чат @mabetek_tenders_bot в течение 10 минут:</p><code>/start '+code+'</code></html>');
}
