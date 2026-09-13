if(require('node:fs').readFileSync(require('node:path').join(__dirname,'../review/user-decisions.json'),'utf8') && JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,'../review/user-decisions.json'),'utf8')).status!=='internal-refinement')throw Error('Historical study cannot overwrite frozen review sources');
const fs=require('node:fs'),path=require('node:path');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..');
(async()=>{
 const palette=JSON.parse(fs.readFileSync(path.join(root,'studies/rejected-fine-grid.json'))).palette;
 const rgb=palette.map(p=>[1,3,5].map(i=>parseInt(p.hex.slice(i,i+2),16)));
 const sampled=await sharp(path.join(__dirname,'front-construction-v2.png')).resize(60,60,{kernel:'nearest'}).ensureAlpha().raw().toBuffer();
 const src=Array.from({length:60},(_,y)=>Array.from({length:60},(_,x)=>{const i=(y*60+x)*4;if(Math.min(...sampled.subarray(i,i+3))>232)return -1;let d=Infinity,k=-1;rgb.forEach((v,j)=>{const z=v.reduce((s,c,n)=>s+(c-sampled[i+n])**2,0);if(z<d){d=z;k=j}});return k}));
 let rows=Array.from({length:64},()=>Array(64).fill(-1));
 for(let y=4;y<18;y++)for(let x=0;x<64;x++){let sy=1+Math.floor((y-4+.5)*20/14),sx=Math.floor(28+(x-32+.5)/.85);if(sx>=0&&sx<60) rows[y][x]=src[sy][sx];}
 for(let y=18;y<=55;y++)for(let x=0;x<64;x++){const sx=x-4,sy=y+3;if(sx>=0&&sx<60)rows[y][x]=src[sy][sx];}
 const grid={schemaVersion:1,cell:[64,64],feetPivot:[32,56],palette,views:{down:{rows,edits:[],registration:{sourceGrid:[60,60],head:{sourceY:[1,21],targetY:[4,18],scaleX:.85,sourceCenterX:28,targetCenterX:32},body:{sourceY:[21,59],targetY:[18,56],offsetX:4}}}},provenance:{method:'New ImageGen low-resolution construction study, deliberately registered and rebuilt as contiguous editable vector regions',concept:'../concept/avatar-1-concept-v2.png',reference:'studies/front-construction-v2.png',sampling:'studies/sample-coarse.cjs',palette:'Authored 24-colour palette with no dithering; nearest sRGB source mapping',approval:'Internal refinement; construction study not approved concept or user-approved idle'}};
 fs.writeFileSync(path.join(root,'source/artist-grid.json'),JSON.stringify(grid,null,2)+'\n');
 const out=Buffer.alloc(64*64*4);rows.forEach((row,y)=>row.forEach((k,x)=>{if(k>=0)out.set([...rgb[k],255],(y*64+x)*4)}));
 await sharp(out,{raw:{width:64,height:64,channels:4}}).png().toFile(path.join(__dirname,'front-coarse-grid.png'));
 await sharp({create:{width:680,height:520,channels:4,background:'#D9DDD8'}}).composite([{input:await sharp(out,{raw:{width:64,height:64,channels:4}}).resize(384,384,{kernel:'nearest'}).png().toBuffer(),left:20,top:20},{input:await sharp(out,{raw:{width:64,height:64,channels:4}}).resize(128,128,{kernel:'nearest'}).png().toBuffer(),left:440,top:96},{input:await sharp(out,{raw:{width:64,height:64,channels:4}}).png().toBuffer(),left:472,top:256}]).png().toFile(path.join(__dirname,'front-coarse-review.png'));
})();
