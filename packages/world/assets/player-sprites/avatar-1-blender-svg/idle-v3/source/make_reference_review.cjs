const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..');
const dirs=['down','left','right','up'];
async function main(){
  const concept=path.resolve(root,'../concept/avatar-1-concept-v2.png');
  const approved=JSON.parse(await fs.readFile(path.resolve(root,'../concept/approval.json')));
  if(approved.status!=='approved')throw Error('Concept must be approved');
  const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
  if(hash(await fs.readFile(concept))!==approved.sha256)throw Error('Concept changed');
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1056"><rect width="2048" height="1056" fill="#f8f5ee"/><g fill="#253d3b" font-family="Arial,sans-serif"><text x="32" y="50" font-size="28" font-weight="700">Avatar 1 — approved concept and idle draft</text><text x="32" y="86" font-size="18">Approved character design</text><text x="1232" y="86" font-size="18">Actual 64 × 64 game cells, enlarged 6×</text><text x="32" y="933" font-size="22">Concept approved · idle-v3 is a draft for separate approval</text><text x="32" y="970" font-size="18">Blender Grease Pencil → native SVG → PNG. Animation and live game acceptance remain pending.</text><text x="32" y="1008" font-size="17">Compare identity, proportions, scarf, harness and pouch ownership. See idle-approval.png for native 1× and 2× views.</text></g>`;
  const layers=[{input:await sharp(concept).resize(1152,768).png().toBuffer(),left:32,top:108}];
  const placements=[];
  for(let i=0;i<4;i++){
    const x=1232+(i%2)*400,y=128+Math.floor(i/2)*408;
    svg+=`<rect x="${x}" y="${y}" width="384" height="384" fill="#e8e4da"/><text x="${x+192}" y="${y-8}" text-anchor="middle" font-family="Arial" font-size="16" fill="#253d3b">${dirs[i].toUpperCase()}</text>`;
    const frame=path.join(root,'frames',dirs[i],'idle.png');
    layers.push({input:await sharp(frame).resize(384,384,{kernel:'nearest'}).png().toBuffer(),left:x,top:y});
    placements.push({direction:dirs[i],x,y,scale:6,pngSha256:hash(await fs.readFile(frame))});
  }
  svg+='</svg>';
  const board=await sharp(Buffer.from(svg)).composite(layers).png().toBuffer();
  await fs.writeFile(path.join(root,'review/reference-comparison.png'),board);
  await fs.writeFile(path.join(root,'review/reference-comparison.json'),JSON.stringify({concept:'../concept/avatar-1-concept-v2.png',conceptSha256:approved.sha256,reviewSha256:hash(board),placements,scope:'Reference comparison only. Exact native/game-scale pixel proof in qa.json.'},null,2)+'\n');
  const vectors=[];
  for(let i=0;i<4;i++)vectors.push({input:await sharp(path.join(root,'svg',dirs[i],'idle.svg'),{density:288}).png().toBuffer(),left:i*256,top:0});
  await sharp({create:{width:1024,height:256,channels:4,background:'#f3efe4'}}).composite(vectors).png().toFile(path.join(root,'review/vector-source.png'));
  console.log('Wrote reference comparison and native-vector source preview.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
