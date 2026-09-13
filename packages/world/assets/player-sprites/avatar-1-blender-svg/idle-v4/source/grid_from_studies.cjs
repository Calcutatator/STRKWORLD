/** Build an explicit editable colour-index design from new internal construction studies.
 * This is image-assisted vector construction. References are not final sprite exports.
 * Rendering always proceeds artist-grid -> regions -> Blender GP -> native SVG -> PNG.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(JSON.parse(fs.readFileSync(path.join(__dirname,'../review/user-decisions.json'))).status!=='internal-refinement')throw Error('Preserve the frozen review; this revision is not open for refinement');
const sharp=require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..');
const specs={
 down:{file:'studies/front-construction-v2.png',pivotX:585,cropX:[0,1254],top:26,neck:448,bottom:1228},
 left:{file:'studies/coarse-turnaround-construction-v1.png',pivotX:235,cropX:[0,548],top:134,neck:380,bottom:922},
 right:{file:'studies/coarse-turnaround-construction-v1.png',pivotX:818,cropX:[548,1018],top:134,neck:380,bottom:920},
 up:{file:'studies/coarse-turnaround-construction-v1.png',pivotX:1320,cropX:[1018,1536],top:134,neck:374,bottom:912}
};
(async()=>{
 const palette=JSON.parse(fs.readFileSync(path.join(__dirname,'art-palette.json'))).colors;
 const rgb=palette.map(p=>[1,3,5].map(i=>parseInt(p.hex.slice(i,i+2),16)));
 const views={};const images={};
 for(const [direction,s] of Object.entries(specs)){
  if(!images[s.file])images[s.file]=await sharp(path.join(root,s.file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {data,info}=images[s.file],scale=38/(s.bottom-s.neck);
  const rows=Array.from({length:64},()=>Array(64).fill(-1));
  for(let y=4;y<56;y++)for(let x=0;x<64;x++){
   const head=y<18;
   const sx=Math.round(s.pivotX+(x+.5-32)/(scale*(head?.85:1)));
   const sy=Math.round(head?s.top+(y+.5-4)*(s.neck-s.top)/14:s.neck+(y+.5-18)/scale);
   if(sx<s.cropX[0]||sx>=s.cropX[1]||sy<0||sy>=info.height)continue;
   const i=(sy*info.width+sx)*4,v=[...data.subarray(i,i+3)];
   if(Math.min(...v)>232 || (Math.min(...v)>175&&Math.max(...v)-Math.min(...v)<55))continue;
   let dist=Infinity,index=-1;rgb.forEach((c,j)=>{const d=c.reduce((sum,n,ch)=>sum+(n-v[ch])**2,0);if(d<dist){dist=d;index=j}});
   rows[y][x]=index;
  }
  views[direction]={rows,edits:[],registration:{...s,bodyScale:scale,headWidthScale:.85,headTargetY:[4,18],bodyTargetY:[18,56],interpolation:'nearest source sample at target cell centres; explicit artist edits below'}};
 }
 const grid={schemaVersion:1,cell:[64,64],feetPivot:[32,56],palette,views,provenance:{method:'New concept-derived ImageGen low-resolution construction references, deliberately registered as an editable colour-index design and reconstructed into vector regions',conceptSha256:'8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92',constructionReferences:Object.keys(images).map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')})),sampling:'source/grid_from_studies.cjs',palette:'Authored shared 24-colour palette, nearest sRGB source mapping, no dithering',approval:'Internal refinement; studies are not approved concept art or user-approved idles'}};
 fs.writeFileSync(path.join(__dirname,'artist-grid.json'),JSON.stringify(grid,null,2)+'\n');
})();
