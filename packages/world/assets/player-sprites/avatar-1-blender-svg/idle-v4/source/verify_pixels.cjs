/** Check actual SVG-derived runtime pixels against the explicit colour-region design. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{const gp=path.join(__dirname,'artist-grid.json'),g=JSON.parse(fs.readFileSync(gp)),rgb=g.palette.map(p=>[1,3,5].map(i=>parseInt(p.hex.slice(i,i+2),16))),views={};
for(const [d,v]of Object.entries(g.views)){
 const bytes=fs.readFileSync(path.join(root,'frames',d,'idle.png'));
 const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 if(info.width!==64||info.height!==64)throw Error(d+' dimensions');
 let opaque=0,lowest=-1;const used=new Set();const pixels=[];
 for(let y=0;y<64;y++)for(let x=0;x<64;x++){
  const k=v.rows[y][x],want=k<0?[0,0,0,0]:[...rgb[k],255],i=(y*64+x)*4;
  if(want.some((n,ch)=>n!==data[i+ch]))throw Error(`${d}: grid versus native SVG-derived PNG differs at ${x},${y}: expected ${want}, got ${[...data.subarray(i,i+4)]}`);
  if(k>=0){opaque++;lowest=Math.max(y,lowest);used.add(k);pixels.push([x,y]);if(x===0||x===63||y===0||y===63)throw Error(d+' clipped border');}
 }
 if(lowest!==55)throw Error(d+' baseline moved');
 if(used.size>24)throw Error(d+' palette overflow');
 views[d]={rgbaParity:true,pngSha256:sha(bytes),rgbaSha256:sha(data),opaquePixels:opaque,colors:used.size,lastOpaqueRow:lowest};
}
const report={status:'pass',scope:'Exact artist colour grid versus PNG derived from native Blender SVG; technical only',artistGridSha256:sha(fs.readFileSync(gp)),views,artisticQa:'separate visual inspection required'};
fs.writeFileSync(path.join(root,'review/pixel-parity.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})();
