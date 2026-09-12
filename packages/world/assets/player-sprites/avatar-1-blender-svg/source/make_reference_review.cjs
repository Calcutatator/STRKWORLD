#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..');
const directions=['down','left','right','up'];
const width=1664,height=1360,items=[],placements=[];
async function main(){
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f7f4eb"/><g font-family="Arial,sans-serif"><text x="40" y="49" font-size="31" font-weight="700" fill="#193c38">Avatar 1 · reference fidelity review</text><text x="40" y="80" font-size="18" fill="#49645f">Approved concept beside the SVG-derived sprite, at the same displayed figure height</text>`;
 for(let i=0;i<4;i++){
  const d=directions[i],x=40+(i%2)*808,y=112+Math.floor(i/2)*592;
  svg+=`<rect x="${x}" y="${y}" width="776" height="570" rx="12" fill="#fffdf7"/><text x="${x+24}" y="${y+33}" font-size="21" font-weight="700" fill="#193c38">${d.toUpperCase()}</text><text x="${x+84}" y="${y+63}" font-size="16" fill="#49645f">Approved concept</text><text x="${x+432}" y="${y+63}" font-size="16" fill="#49645f">SVG export · 6× pixels</text>`;
  const frame=await fs.readFile(path.join(root,`frames/${d}/idle.png`));
  const dec=await sharp(frame).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let minY=64,maxY=-1;
  for(let yy=0;yy<64;yy++)for(let xx=0;xx<64;xx++)if(dec.data[(yy*64+xx)*4+3]){minY=Math.min(minY,yy);maxY=Math.max(maxY,yy);}
  const visibleHeight=maxY-minY+1;
  const source=await sharp(path.join(root,`reference/studies/${d}-raw-concept-crop.png`)).resize({height:visibleHeight*6}).png().toBuffer();
  const info=await sharp(source).metadata();
  const conceptLeft=Math.round(x+190-info.width/2),conceptTop=y+80+minY*6;
  items.push({input:source,left:conceptLeft,top:conceptTop});
  items.push({input:await sharp(frame).resize(384,384,{kernel:'nearest'}).png().toBuffer(),left:x+384,top:y+80});
  svg+=`<rect x="${x+20}" y="${y+469}" width="736" height="84" rx="6" fill="#dfe5d7"/><text x="${x+38}" y="${y+517}" font-size="16" fill="#29453d">Actual 64×64 cell</text><text x="${x+410}" y="${y+517}" font-size="16" fill="#29453d">2×</text>`;
  items.push({input:frame,left:x+226,top:y+479});
  // Keep the 2x cell below the comparison figure and within this panel.
  items.push({input:await sharp(frame).resize(128,128,{kernel:'nearest'}).png().toBuffer(),left:x+468,top:y+444});
  placements.push({direction:d,figureHeight:visibleHeight,concept:{left:conceptLeft,top:conceptTop,width:info.width,height:info.height},export6x:{left:x+384,top:y+80,scale:6},native:{left:x+226,top:y+479,scale:1},game2x:{left:x+468,top:y+444,scale:2}});
 }
 svg+='<text x="40" y="1337" font-size="17" fill="#49645f">Draft v2 · reconstructed from the approved concept · animation starts only after idle approval</text></g></svg>';
 const board=await sharp(Buffer.from(svg)).composite(items).png().toBuffer();
 await fs.writeFile(path.join(root,'review/reference-comparison.png'),board);
 await fs.writeFile(path.join(root,'review/reference-comparison-layout.json'),JSON.stringify({file:'review/reference-comparison.png',sha256:crypto.createHash('sha256').update(board).digest('hex'),size:[width,height],placements,sourceResizedForSideBySideReview:true,exportPixelsChanged:false},null,2)+'\n');
 console.log('Reference comparison board written.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
