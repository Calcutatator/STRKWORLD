const fs=require('node:fs'),path=require('node:path');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..');
(async()=>{const g=JSON.parse(fs.readFileSync(path.join(__dirname,'artist-grid.json'))),rgb=g.palette.map(p=>[1,3,5].map(i=>parseInt(p.hex.slice(i,i+2),16)));const layers=[];let i=0;
for(const [d,v]of Object.entries(g.views)){
 const buf=Buffer.alloc(16384);v.rows.forEach((r,y)=>r.forEach((k,x)=>{if(k>=0)buf.set([...rgb[k],255],(y*64+x)*4)}));
 await sharp(buf,{raw:{width:64,height:64,channels:4}}).png().toFile(path.join(root,'studies',d+'-grid.png'));
 for(const [scale,top]of [[6,72],[2,484],[1,640]])layers.push({input:await sharp(buf,{raw:{width:64,height:64,channels:4}}).resize(64*scale,64*scale,{kernel:'nearest'}).png().toBuffer(),left:24+i*408+(384-64*scale)/2,top});i++;
}
let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1656" height="744"><rect width="100%" height="100%" fill="#D9DDD8"/><g font-family="Arial" font-size="18" fill="#263B33"><text x="24" y="32">Internal vector construction — no approval requested</text>`;
Object.keys(g.views).forEach((d,i)=>svg+=`<text x="${24+i*408}" y="60">${d}</text>`);svg+='</g></svg>';
await sharp(Buffer.from(svg)).composite(layers).png().toFile(path.join(root,'studies/all-grid-review.png'));
})();
