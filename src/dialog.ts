export const questions=[
  ['service','Какую конкретную услугу готовы оказать?'],
  ['qty','Укажите количество (до трёх знаков после запятой).'],
  ['unit','Единица измерения?'],
  ['rate','Ваша ставка в рублях за единицу (до копеек).'],
  ['vat','Укажите применимый режим НДС и входит ли налог в ставку.'],
  ['dates','Подтвердите доступные даты работ.'],
  ['terms','Какие условия оплаты согласованы?'],
  ['validity','До какой даты действует предложение?'],
  ['verified','Проверьте актуальное извещение, реальный номер лота, приложения, обязательные формы и место исполнения. Введите подтверждённый номер лота.']
] as const;
export function validate(field:string,input:string){
  const value=input.trim();
  if(!value || value.length>600)throw Error('Ответ должен содержать от 1 до 600 символов.');
  if(field==='qty'||field==='rate'){
    const numeric=value.replace(',','.');
    if(!(field==='qty'?/^\d{1,9}(\.\d{1,3})?$/:/^\d{1,9}(\.\d{1,2})?$/).test(numeric)||Number(numeric)<=0)throw Error('Требуется положительное число допустимой точности.');
    return numeric;
  }
  return value;
}
export function offer(card:any,answers:Record<string,string>){
  for(const [k] of questions)if(!answers[k])throw Error('Заполните обязательные поля');
  const {service,qty,unit,rate,vat,dates,terms,validity,verified}=answers;
  if(!card.customer?.trim())throw Error('В оригинале не указан заказчик. Для КП требуется карточка с подтверждённым заказчиком.');
  if(/^\d+$/.test(card.lot) && verified!==card.lot)throw Error('В оригинале указан лот '+card.lot+'. Проверьте и введите его номер.');
  const decimal=(s:string,n:number)=>{const [a,b='']=s.split('.');return BigInt(a+b.padEnd(n,'0'));};
  const cents=(decimal(qty,3)*decimal(rate,2)+500n)/1000n;
  const total=String(cents/100n)+'.'+String(cents%100n).padStart(2,'0');
  if(card.source==='rzd-rts' && !card.registration)throw Error('Для КП требуется номер извещения ЕИС. Заново откройте оригинал через /watch и проверьте номер.');
  const data={customer:card.customer,lot:(card.registration||card.procedure)+'/'+verified,items:[{service,qty,unit,rate}],vat,dates,terms,validity,currency:'RUB',confirmed:true};
  const summary=[card.customer,'Лот '+data.lot,service,qty+' '+unit+' × '+rate+' ₽ = '+total+' ₽',vat,dates,terms,'Действует: '+validity].join('\n');
  return {data,summary};
}
