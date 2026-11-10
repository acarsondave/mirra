import { BrowserLane } from '../cli/browser.js';
const log = { info: m => console.log(m), warn: m => console.log(m), debug () {} };
const b=new BrowserLane({log});
await b.withPage(async p=>{
  await p.goto('https://deviceandbrowserinfo.com/are_you_a_bot',{waitUntil:'networkidle'}).catch(()=>{});
  await p.waitForTimeout(4000);
  const t=await p.evaluate(()=>document.body.innerText);
  console.log('deviceandbrowserinfo:', (t.match(/You are (not )?a bot[^\n]*/i)||[t.slice(0,300)])[0]);
  await p.goto('https://bot.sannysoft.com/',{waitUntil:'networkidle'}).catch(()=>{});
  await p.waitForTimeout(3000);
  const fails=await p.evaluate(()=>[...document.querySelectorAll('td.failed, td.warn')].map(td=>td.parentElement.innerText.replace(/\s+/g,' ').slice(0,80)));
  console.log('sannysoft failed/warn:', fails.length, fails.slice(0,8));
  console.log('UA:', b.userAgent);
});
await b.close();
