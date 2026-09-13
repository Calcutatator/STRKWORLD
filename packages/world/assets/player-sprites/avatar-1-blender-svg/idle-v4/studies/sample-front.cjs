const fs=require('node:fs');
const path=require('node:path');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=__dirname;
(async()=>{
 const input=await sharp(path.join(root,'front-construction-v1.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const {width,height}=input.info;
 for(let i=0;i<input.data.length;i+=4) if(Math.min(...input.data.subarray(i,i+3))>232){input.data.fill(0,i,i+4)}
 const image=sharp(input.data,{raw:{width,height,channels:4}}).extract({left:0,top:69,width,height:1105});
 const small=await image.resize(59,52,{kernel:'lanczos3'}).ensureAlpha().raw().toBuffer();
 for(let i=0;i<small.length;i+=4){if(small[i+3]<128)small.fill(0,i,i+4);else small[i+3]=255;}
 const cell=await sharp({create:{width:64,height:64,channels:4,background:'#00000000'}}).composite([{input:await sharp(small,{raw:{width:59,height:52,channels:4}}).png().toBuffer(),left:4,top:4}]).png().toBuffer();
 await sharp(cell).toFile(path.join(root,'front-sampled-raw.png'));
 const quant=await sharp(cell).png({palette:true,colours:24,dither:0,effort:10}).toBuffer();
 await sharp(quant).png({palette:false}).toFile(path.join(root,'front-sampled-24.png'));
 const placements=[];
 for(const [i,buf] of [cell,quant].entries())for(const [j,scale] of [6,2,1].entries())placements.push({input:await sharp(buf).resize(64*scale,64*scale,{kernel:'nearest'}).png().toBuffer(),left:24+i*424,top:[64,472,624][j]});
 const board=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="872" height="728"><rect width="100%" height="100%" fill="#D9DDD8"/><g font-family="Arial" font-size="18" fill="#263B33"><text x="24" y="32">Unquantized internal sampling</text><text x="448" y="32">24-colour internal sampling</text></g></svg>`);
 await sharp(board).composite(placements).png().toFile(path.join(root,'front-sampling-review.png'));
 console.log(JSON.stringify({width,height,outputs:'Internal sampling studies, not a Blender export or approval candidate'}));
})();
