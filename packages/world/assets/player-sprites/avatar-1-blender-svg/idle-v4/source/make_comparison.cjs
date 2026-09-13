const fs=require('node:fs'),path=require('node:path');
if(JSON.parse(fs.readFileSync(path.join(__dirname,'../review/user-decisions.json'))).status!=='internal-refinement')throw Error('Preserve the frozen review; this revision is not open for refinement');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..');
(async()=>{
 const layers=[{input:await sharp(path.join(root,'../concept/avatar-1-concept-v2.png')).resize(900,600).png().toBuffer(),left:28,top:100}];
 for(const [i,d] of ['down','left','right','up'].entries()){
  const buf=fs.readFileSync(path.join(root,'frames',d,'idle.png'));
  layers.push({input:await sharp(buf).resize(256,256,{kernel:'nearest'}).png().toBuffer(),left:964+(i%2)*304,top:100+Math.floor(i/2)*298});
 }
 const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1570" height="770"><rect width="100%" height="100%" fill="#F8F6F0"/><g font-family="Arial" fill="#213C35"><text x="28" y="48" font-size="30" font-weight="700">Approved concept and rebuilt game sprite</text><text x="28" y="80" font-size="17">Approved character design</text><text x="964" y="80" font-size="17">Actual SVG-derived cells enlarged 4×</text><text x="28" y="742" font-size="17">Concept approval is preserved. Idle approval, animation and game acceptance remain separate.</text></g></svg>`);
 await sharp(svg).composite(layers).png().toFile(path.join(root,'review/reference-comparison.png'));
})();
