const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(JSON.parse(fs.readFileSync(path.join(__dirname,'../review/user-decisions.json'))).status!=='internal-refinement')throw Error('Preserve the frozen review; this revision is not open for refinement');
const file=path.join(__dirname,'artist-grid.json'),patch=path.join(__dirname,'head-refinement.json');
const g=JSON.parse(fs.readFileSync(file)),p=JSON.parse(fs.readFileSync(patch));
const baseHash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(baseHash!==p.baseGridSha256)throw Error('Head patch base changed; rebuild and review the base before applying');
const hash=crypto.createHash('sha256').update(fs.readFileSync(patch)).digest('hex');
for(const[d,edits]of Object.entries(p.views)){
 if(!g.views[d])throw Error('Unknown direction '+d);
 for(const e of edits){
  if(!Number.isInteger(e.x)||!Number.isInteger(e.y)||e.x<0||e.x>63||e.y<0||e.y>19)throw Error('Head patch outside head');
  const k=e.color===null?-1:g.palette.findIndex(c=>c.name===e.color);
  if(k<0&&e.color!==null)throw Error('Unknown palette '+e.color);
  const before=g.views[d].rows[e.y][e.x];
  if(before!==k)g.views[d].edits.push({...e,before,after:k,source:'head-refinement.json'});
  g.views[d].rows[e.y][e.x]=k;
 }
}
g.provenance.headRefinement={file:'source/head-refinement.json',sha256:hash};
fs.writeFileSync(file,JSON.stringify(g,null,2)+'\n');
