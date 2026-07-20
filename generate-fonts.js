const fs=require('fs');
const URL='https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Golos+Text:wght@400;500;600;700&display=swap';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const keep=new Set(['cyrillic','cyrillic-ext','latin','latin-ext']);
(async()=>{
  const css=await (await fetch(URL,{headers:{'user-agent':UA}})).text();
  fs.mkdirSync('fonts',{recursive:true});
  const re=/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  let m,out=[],n=0;
  while((m=re.exec(css))){
    const subset=m[1]; if(!keep.has(subset)) continue;
    let block=m[2];
    const fam=(block.match(/font-family:\s*'([^']+)'/)||[])[1]||'font';
    const wght=(block.match(/font-weight:\s*(\d+)/)||[])[1]||'400';
    const url=(block.match(/src:\s*url\(([^)]+)\)/)||[])[1]; if(!url) continue;
    const name=fam.replace(/\s+/g,'')+'-'+wght+'-'+subset+'.woff2';
    const buf=Buffer.from(await (await fetch(url)).arrayBuffer());
    fs.writeFileSync('fonts/'+name,buf); n++;
    block=block.replace(/src:\s*url\([^)]+\)\s*format\('woff2'\);/, "src:url('/fonts/"+name+"') format('woff2');");
    out.push(block.replace(/\s+/g,' ').trim());
  }
  fs.writeFileSync('fonts.css',out.join('\n'));
  console.log('woff2 files:',n);
})();
