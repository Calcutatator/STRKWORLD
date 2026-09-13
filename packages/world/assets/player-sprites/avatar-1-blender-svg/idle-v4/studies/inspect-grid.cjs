const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const {data}=await sharp(path.join(__dirname,'front-sampled-24.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const colors=[...new Set([...Array(4096)].filter((_,i)=>data[i*4+3]).map((_,i)=>i))];
 const palette=[...new Set(Array.from({length:4096},(_,i)=>data[i*4+3]?'#'+data.subarray(i*4,i*4+3).toString('hex'):null).filter(Boolean))].sort();
 const rows=Array.from({length:64},(_,y)=>Array.from({length:64},(_,x)=>{let i=(y*64+x)*4;return data[i+3]?palette.indexOf('#'+data.subarray(i,i+3).toString('hex')):-1}));
 fs.writeFileSync(path.join(__dirname,'front-sampling-grid.json'),JSON.stringify({palette,rows},null,2)+'\n');
 for(let y=4;y<23;y++)console.log(String(y).padStart(2)+' '+rows[y].slice(21,43).map(x=>x<0?'.':String.fromCharCode(65+x)).join(''));
 console.log(palette.map((x,i)=>String.fromCharCode(65+i)+' '+x).join('\n'));
 const w=704,h=608,over=[];
 const raw=await sharp(data,{raw:{width:64,height:64,channels:4}}).extract({left:21,top:4,width:22,height:19}).resize(w,h,{kernel:'nearest'}).png().toBuffer();
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g font-family="Arial" font-size="10" fill="#ffffff" opacity=".75">`;
 for(let y=0;y<19;y++)for(let x=0;x<22;x++)svg+=`<text x="${x*32+2}" y="${y*32+12}">${x+21},${y+4}</text>`;
 svg+='</g></svg>';
 await sharp({create:{width:w,height:h,channels:4,background:'#74837c'}}).composite([{input:raw},{input:Buffer.from(svg)}]).png().toFile(path.join(__dirname,'front-head-grid.png'));
})();
