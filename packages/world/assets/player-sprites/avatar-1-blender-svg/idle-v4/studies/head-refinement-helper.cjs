if(require('node:fs').readFileSync(require('node:path').join(__dirname,'../review/user-decisions.json'),'utf8') && JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,'../review/user-decisions.json'),'utf8')).status!=='internal-refinement')throw Error('Historical study cannot overwrite frozen review sources');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const base = path.resolve(__dirname, '..');
const original = JSON.parse(fs.readFileSync(path.join(base,'source/artist-grid.json')));
const proposed = structuredClone(original.views);
const names = original.palette.map(p=>p.name);
const named = Object.fromEntries(names.map((name,i)=>[name,i]));
const reasons = {};
function set(d,x,y,color,reason) { if(y>19) throw Error('Outside head boundary'); proposed[d].rows[y][x]=named[color]; reasons[`${d}/${x}/${y}`]=reason; }
const hairNames=['hairDeep','hairShade','hair','hairLight','hairGlint','skinShade','leatherDark','leather','metal','leatherGlint'];
const masks={};
for (const d of Object.keys(original.views)) {
 masks[d]=new Set();
 for(let y=4;y<=16;y++)for(let x=23;x<42;x++){
  const n=original.views[d].rows[y][x];
  const isHair=hairNames.includes(names[n]) && (d==='up'|| y<=14 || (d==='left'&&x>=32)||(d==='right'&&x<31));
  if (isHair) masks[d].add(`${x}/${y}`);
 }
 for(const key of masks[d]) {
  const [x,y]=key.split('/').map(Number);
  const oldName=names[original.views[d].rows[y][x]];
  const consolidate={skinShade:'hair',leatherDark:'hairDeep',leather:'hair',metal:'hairLight',leatherGlint:'hairLight'};
  set(d,x,y,consolidate[oldName]||oldName,'Consolidate inconsistent warm shades into a coherent hair palette while retaining swept lock contours');
 }
}
const lockClusters={
 down:[[27,9,'hairLight'],[28,9,'hairLight'],[28,10,'hair'],[29,10,'hairLight'],[33,8,'hairLight'],[34,8,'hairLight'],[33,9,'hairLight'],[34,9,'hair'],[35,10,'hair'],[36,11,'hairShade']],
 left:[[27,8,'hairLight'],[28,8,'hairLight'],[29,9,'hairLight'],[30,9,'hair'],[33,9,'hairLight'],[34,9,'hairLight'],[34,10,'hairLight'],[35,10,'hair'],[36,11,'hairShade']],
 right:[[30,9,'hairLight'],[31,9,'hairLight'],[31,10,'hair'],[32,10,'hairLight'],[34,9,'hairLight'],[35,10,'hairLight'],[35,11,'hair'],[36,12,'hairShade']],
 up:[[28,9,'hairLight'],[28,10,'hairLight'],[29,11,'hair'],[30,11,'hairLight'],[33,9,'hairLight'],[34,10,'hairLight'],[35,10,'hair'],[35,11,'hairLight'],[32,13,'hair'],[33,13,'hair']]
};
for(const [d,points] of Object.entries(lockClusters))for(const [x,y,color] of points)if(masks[d].has(`${x}/${y}`))set(d,x,y,color,'Join adjacent highlights into readable swept hair locks');
const faceReason='Open the face beneath the fringe and define eyes, cheek, smile and chin as deliberate pixel clusters';
function row(d,y,x,cols){for(const color of cols.split(' ')){set(d,x++,y,color,faceReason);}}
row('down',12,29,'skinShade skinLight skinLight hairShade hair hair hairShade');
row('down',13,29,'skinLight skinShade skinLight skinLight skinLight skinShade skin');
row('down',14,29,'skinLight ink skinLight skinLight skinLight ink skin');
row('down',15,29,'skin skinLight skinLight skin skinShade skinLight skinShade');
row('down',16,29,'tealDark skin skinShade skinShade skinLight skinShade tealDark');
row('down',17,30,'tealDark skin skinLight skinShade tealDark');
row('right',12,33,'hairShade skinShade skinLight hairDeep');
row('right',13,33,'skinShade skinLight skinLight skinLight hairShade');
row('right',14,32,'skinShade skin skinLight ink skinLight skinLight');
row('right',15,31,'skinShade skin skinLight skinLight ink skinLight skin');
row('right',16,32,'tealDark skinShade skinLight skinLight skinShade tealDark');
row('right',17,33,'tealDark skinShade skin tealDark');
const patch={schemaVersion:1,baseGridSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(base,'source/artist-grid.json'))).digest('hex'),scope:'Head pixels only; existing body and registration preserved',views:{}};
for(const d of Object.keys(proposed)) {patch.views[d]=[];for(let y=0;y<64;y++)for(let x=0;x<64;x++)if(proposed[d].rows[y][x]!==original.views[d].rows[y][x])patch.views[d].push({x,y,color:names[proposed[d].rows[y][x]],reason:reasons[`${d}/${x}/${y}`]});}
fs.writeFileSync(path.join(base,'source/head-refinement.json'),JSON.stringify(patch,null,2)+'\n');
function raw(rows){const buf=Buffer.alloc(64*64*4);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const n=rows[y][x];if(n<0)continue;const hex=original.palette[n].hex;const idx=4*(y*64+x); for(let c=0;c<3;c++)buf[idx+c]=parseInt(hex.slice(1+c*2,3+c*2),16);buf[idx+3]=255;}return buf;}
(async()=>{
const composites=[];const dirs=['down','left','right','up'];
for(let j=0;j<2;j++)for(let i=0;i<4;i++){
 const rows=(j?proposed:original.views)[dirs[i]].rows;
 const input=await sharp(raw(rows),{raw:{width:64,height:64,channels:4}}).resize(384,384,{kernel:'nearest'}).png().toBuffer();
 composites.push({input,left:i*384,top:20+j*474});
 const small=await sharp(raw(rows),{raw:{width:64,height:64,channels:4}}).resize(128,128,{kernel:'nearest'}).png().toBuffer();
 composites.push({input:small,left:i*384+230,top:340+j*474});
 const native=await sharp(raw(rows),{raw:{width:64,height:64,channels:4}}).png().toBuffer();
 composites.push({input:native,left:i*384+140,top:400+j*474});
}
await sharp({create:{width:1536,height:958,channels:4,background:'#e8e4db'}}).composite(composites).png().toFile(path.join(base,'studies/head-refinement-v3.png'));
console.log(Object.fromEntries(Object.entries(patch.views).map(([k,v])=>[k,v.length])));
})();
