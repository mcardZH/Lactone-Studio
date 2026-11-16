import { CoordinateTransformation, type Atom, type Ketcher } from 'ketcher-core';

function chargeText(value:number) { return `${Math.abs(value) === 1 ? '' : Math.abs(value)}${value < 0 ? '–' : '+'}`; }

/** Ketcher renders each superscript as its own Raphael text object on the
 * owning ReAtom. Read the actual glyph, including two-character charge. */
export function renderedTwoDChargeGlyph(editor:Ketcher,id:number):SVGTextElement|undefined {
  const rendered=editor.editor.render.ctab.atoms.get(id), charge=rendered?.a.charge;
  if(!rendered||!charge)return;
  return rendered.visel.paths.map(path=>path.node as SVGTextElement|undefined)
    .find(node=>node?.localName==='text'&&node.isConnected&&node.textContent?.trim()===chargeText(charge));
}

export function renderedTwoDChargeAt(editor:Ketcher,x:number,y:number):number|undefined {
  // The event target is usually the real SVG text/tspan. Check its rendered
  // box too, so the spaces between a digit and its sign belong to one target.
  let hit:number|undefined, nearest=Infinity;
  editor.editor.render.ctab.atoms.forEach((atom,id)=>{
    if(!atom.a.charge)return;
    const glyph=renderedTwoDChargeGlyph(editor,id), rect=glyph?.getBoundingClientRect();
    if(!rect||rect.width<=0||rect.height<=0||x<rect.left-1||x>rect.right+1||y<rect.top-1||y>rect.bottom+1)return;
    const distance=Math.hypot(x-(rect.left+rect.right)/2,y-(rect.top+rect.bottom)/2);
    if(distance<nearest){hit=id;nearest=distance;}
  });
  return hit;
}

interface ScreenBounds {left:number;top:number;right:number;bottom:number}
export const TWO_D_VALENCE_WARNING_SIZE = 17;

/** The badges are separate controls above the paper. Lay them out against
 * the actual SVG charge boxes so they cannot steal a charge's pointer event. */
export function renderedTwoDChargeBounds(editor:Ketcher): ScreenBounds[] {
  const bounds: ScreenBounds[] = [];
  editor.editor.render.ctab.atoms.forEach(({a},id) => {
    if (!a.charge) return;
    const box = renderedTwoDChargeGlyph(editor,id)?.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0) bounds.push(box);
  });
  return bounds;
}

export function twoDValenceWarningPosition(preferred:{x:number;y:number}, board:ScreenBounds, charges:readonly ScreenBounds[]) {
  const size = TWO_D_VALENCE_WARNING_SIZE;
  const gap = 3;
  const clamp = (value:number, start:number, end:number) => Math.max(start, Math.min(end - size, value));
  const nearest = { x:clamp(preferred.x,board.left,board.right), y:clamp(preferred.y,board.top,board.bottom) };
  const overlaps = ({x,y}:{x:number;y:number}, box:ScreenBounds) =>
    x < box.right + gap && x + size > box.left - gap && y < box.bottom + gap && y + size > box.top - gap;
  const obstructing = charges.filter(box => overlaps(nearest,box));
  if (!obstructing.length) return nearest;

  const local = obstructing.reduce((bounds,box) => ({
    left: Math.min(bounds.left,box.left), top: Math.min(bounds.top,box.top),
    right: Math.max(bounds.right,box.right), bottom: Math.max(bounds.bottom,box.bottom)
  }));
  // Only try the immediate sides and corners of the local charge envelope.
  const xs = [nearest.x,clamp(local.left-size-gap,board.left,board.right),clamp(local.right+gap,board.left,board.right)];
  const ys = [nearest.y,clamp(local.top-size-gap,board.top,board.bottom),clamp(local.bottom+gap,board.top,board.bottom)];
  const distance = ({x,y}:{x:number;y:number}) => (x-nearest.x) ** 2 + (y-nearest.y) ** 2;
  const nearby = xs.flatMap(x => ys.map(y => ({x,y}))).sort((a,b) => distance(a)-distance(b));
  const best = nearby.find(position => !charges.some(box => overlaps(position,box)));
  // The left toolbar gutter remains outside the clipped drawing plane if
  // every position on a very dense drawing would cover a charge.
  return best ?? { x:board.left-size-gap, y:nearest.y };
}

export interface TwoDCipLabel { x:number;y:number;element:string;charge:number;isotope:number;value:'R'|'S' }
interface CipSourceAtom {label:string;location:number[];charge?:number;isotope?:number;mapping?:number;cip?:string}
interface CipSourceEdge {type:number;atoms:number[];stereo?:number;cip?:string}
interface CipNode {type:string;atoms:CipSourceAtom[];bonds?:CipSourceEdge[]}

/** Preserve the original KET representation and verify the returned graph
 * via temporary atom maps. The maps and calculated CIP never enter Ketcher
 * history or the editable KET. A problematic fragment does not suppress the
 * labels of a separate, unambiguous molecule. */
export async function deriveTwoDCip(ket:string,calculate:(input:string,signal?:AbortSignal)=>Promise<string>,signal?:AbortSignal):Promise<TwoDCipLabel[]> {
  const original=JSON.parse(ket), result:TwoDCipLabel[]=[];
  for(const ref of original.root?.nodes??[]) {
    signal?.throwIfAborted();
    const source=original[ref.$ref] as CipNode|undefined;
    if(source?.type!=='molecule'||!source.bonds?.length)continue;
    const explicit=new Set(source.bonds.filter(b=>b.type===1&&[1,6].includes(b.stereo??0)).map(b=>b.atoms[0]));
    if(!explicit.size)continue;
    const node=structuredClone(source);
    node.atoms.forEach((atom,index)=>{delete atom.cip;atom.mapping=index+1;});
    node.bonds?.forEach(bond=>delete bond.cip);
    try {
      const output=JSON.parse(await calculate(JSON.stringify({root:{nodes:[{$ref:'mol0'}]},mol0:node}),signal));
      signal?.throwIfAborted();
      const mapped=new Set<number>(), edges:string[]=[], labels:TwoDCipLabel[]=[];
      const edgeKey=(a:number,b:number,type:number)=>`${Math.min(a,b)}:${Math.max(a,b)}:${type}`;
      let valid=true;
      for(const ref of output.root.nodes) {
        const molecule=output[ref.$ref] as CipNode;
        if(molecule?.type!=='molecule'||!Array.isArray(molecule.atoms)){valid=false;break;}
        const indices:number[]=[];
        for(const atom of molecule.atoms) {
          const index=(atom.mapping??0)-1,before=source.atoms[index];
          if(!Number.isInteger(index)||!before||mapped.has(index)||before.label!==atom.label||
            (before.charge??0)!==(atom.charge??0)||(before.isotope??0)!==(atom.isotope??0)||
            !Array.isArray(atom.location)||![0,1].every(i=>Number.isFinite(atom.location[i])&&Math.abs(atom.location[i]-before.location[i])<=Math.max(1,Math.abs(before.location[i]))*1e-6)) {
            valid=false;break;
          }
          indices.push(index);mapped.add(index);
          if(explicit.has(index)&&(atom.cip==='R'||atom.cip==='S'))labels.push({x:before.location[0],y:before.location[1],element:before.label,charge:before.charge??0,isotope:before.isotope??0,value:atom.cip});
        }
        if(!valid)break;
        for(const bond of molecule.bonds??[]) {
          if(bond.atoms.length!==2||bond.atoms.some(i=>indices[i]===undefined)){valid=false;break;}
          edges.push(edgeKey(indices[bond.atoms[0]],indices[bond.atoms[1]],bond.type));
        }
      }
      const expected=source.bonds.map(b=>edgeKey(b.atoms[0],b.atoms[1],b.type)).sort();
      if(valid&&mapped.size===source.atoms.length&&JSON.stringify(expected)===JSON.stringify(edges.sort()))result.push(...labels);
    } catch (error) { if(signal?.aborted) throw error; }
  }
  return result;
}

const svgNS='http://www.w3.org/2000/svg';
export function isOrdinaryIsolatedMethane(a:Atom):boolean {
  // The locked Ketcher creates an object whose query fields are all null
  // even for an ordinary carbon. The fields, not the container, are evidence.
  return a.label==='C'&&!a.charge&&!a.radical&&!a.isotope&&!a.alias&&!a.atomList&&!a.rglabel&&
    !Object.values(a.queryProperties??{}).some(value=>value!==null&&value!==undefined&&value!=='')&&
    (a.implicitHCount===null||a.implicitHCount===undefined)&&a.implicitH===4&&a.neighbors.length===0&&a.explicitValence<0;
}
/** Renderer-only labels on the actual paper, so the copied SVG and the live
 * board see precisely the same annotations. Native R/S imported with a file
 * remains in the source graph but never substitutes for current derived CIP. */
export function paintTwoDBoardLabels(editor:Ketcher,labels:readonly TwoDCipLabel[]) {
  const render=editor.editor.render, svg=render.paper.canvas;
  if(!svg?.isConnected)return;
  let layer=svg.querySelector<SVGGElement>(':scope > g[data-two-d-derived-labels]');
  if(!layer){layer=svg.ownerDocument.createElementNS(svgNS,'g');layer.setAttribute('data-two-d-derived-labels','');layer.setAttribute('pointer-events','none');svg.append(layer);}
  const children:SVGTextElement[]=[];
  const createText=(x:number,y:number,text:string,kind:'cip'|'implicit-h',fontSize:number,align:string,fill:string)=>{
    const node=svg.ownerDocument.createElementNS(svgNS,'text');
    node.setAttribute('x',String(x));node.setAttribute('y',String(y));node.setAttribute('text-anchor',align);
    node.setAttribute('dominant-baseline','central');node.setAttribute('font-size',String(fontSize));
    node.setAttribute('font-family','Arial, sans-serif');node.setAttribute('fill',fill);
    node.setAttribute('data-two-d-label',kind);node.textContent=text;children.push(node);
  };
  const labelled=new Map<number,TwoDCipLabel>();
  for(const label of labels){
    const ids:number[]=[];
    render.ctab.atoms.forEach(({a},id)=>{
      if(a.label===label.element&&(a.charge??0)===label.charge&&(a.isotope??0)===label.isotope&&Math.hypot(a.pp.x-label.x,a.pp.y+label.y)<1e-5)ids.push(id);
    });
    if(ids.length===1)labelled.set(ids[0],label);
  }
  render.ctab.atoms.forEach((atom,id)=>{
    const nativeText=atom.cip?.text?.node as SVGTextElement|undefined;
    if(nativeText&&/^\([RS]\)$/.test(nativeText.textContent?.trim()??'')){
      nativeText.setAttribute('display','none');atom.cip?.rectangle?.node?.setAttribute('display','none');
    }
    const a=atom.a, canvas=CoordinateTransformation.viewToCanvas(CoordinateTransformation.modelToView(a.pp,render),render);
    const size=render.options.fontszInPx;
    if(isOrdinaryIsolatedMethane(a)) {
      const c=atom.label?.rbb;
      createText(canvas.x+(c?.width??size*.7)/2+1,canvas.y,'H₄','implicit-h',size,'start',atom.color);
    }
    const label=labelled.get(id);
    if(label){
      const d=atom.bisectLargestSector(render.ctab.molecule), distance=size*1.25;
      createText(canvas.x+d.x*distance,canvas.y+d.y*distance,`(${label.value})`,'cip',size*.8,'middle','#243c34');
      const text=children.at(-1)!;text.setAttribute('paint-order','stroke');text.setAttribute('stroke','white');text.setAttribute('stroke-width','2');text.setAttribute('stroke-linejoin','round');
    }
  });
  layer.replaceChildren(...children);
}
