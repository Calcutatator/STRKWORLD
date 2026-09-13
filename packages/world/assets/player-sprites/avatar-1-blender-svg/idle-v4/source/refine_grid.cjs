const fs=require('node:fs'),path=require('node:path');
if(JSON.parse(fs.readFileSync(path.join(__dirname,'../review/user-decisions.json'))).status!=='internal-refinement')throw Error('Preserve the frozen review; this revision is not open for refinement');
const p=path.join(__dirname,'artist-grid.json'),g=JSON.parse(fs.readFileSync(p));
function set(d,x,y,color,reason){const v=g.views[d],k=g.palette.findIndex(p=>p.name===color);if(k<0)throw Error(color);v.edits.push({x,y,before:v.rows[y][x],after:k,reason});v.rows[y][x]=k;}
// Draw facial expression at the final pixel scale. Keep the two one-pixel eyes
// at x30/x34,y14; strengthen cheeks and add a soft asymmetric smile underneath.
for(const [y,x,colors] of [[15,29,['skin','skinLight','skinLight','skin','skinLight','skinLight','skinShade']],[16,30,['skin','skin','skinShade','skin','skinShade']]])colors.forEach((c,i)=>set('down',x+i,y,c,'Readable warm cheeks and subtle smile at native scale'));
fs.writeFileSync(p,JSON.stringify(g,null,2)+'\n');
