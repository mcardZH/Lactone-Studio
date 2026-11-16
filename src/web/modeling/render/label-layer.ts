/** Adapter-owned labels only. Locked removeAllLabels drops nodes without
 * disposing textures; removeLabel disposes but shows once per label. */
export function createLabelLayer(viewer:any){
 const labels=new Map<any,any>();
 const context=()=>viewer.getRenderer?.()?.getContext?.()??viewer.getRenderer?.()?._gl;
 function remove(handles:Iterable<any>){
   const owned=new Set([...handles].filter(label=>labels.has(label)));
   if(!owned.size)return;
   // Compatibility with alternate viewers lacking the locked inventory.
   if(!Array.isArray(viewer.labels)||!viewer.modelGroup){
    if(owned.size===labels.size){labels.clear();viewer.removeAllLabels();return;}
    for(const label of owned){viewer.removeLabel(label);labels.delete(label);}return;
   }
   const foreign=viewer.labels.filter((label:any)=>!owned.has(label));
   const sharedMaterials=new Set(foreign.map((label:any)=>label.sprite?.material));
   const sharedMaps=new Set(foreign.map((label:any)=>label.sprite?.material?.map));
   let failure:unknown;
   for(const label of owned){
    const sourceContext=labels.get(label);labels.delete(label);
    try{
     const index=viewer.labels.indexOf(label);if(index>=0)viewer.labels.splice(index,1);
     viewer.modelGroup.remove(label.sprite);
    }catch(error){failure??=error;}
    const material=label.sprite?.material,map=material?.map,current=context();
    if(sourceContext===current&&!current?.isContextLost?.()){
     // Native dispose/regeneration may already have retired this texture.
     try{if(map&&!sharedMaps.has(map)&&map.__webglInit===true)map.dispose();}catch(error){failure??=error;}
     try{if(material&&!sharedMaterials.has(material))material.dispose();}catch(error){failure??=error;}
    }
   }
   if(failure)throw failure;
 }
 return{
  add(...args:any[]){const label=viewer.addLabel(...args);if(label)labels.set(label,context());return label;},
  move(label:any,position:{x:number;y:number;z:number}){if(!labels.has(label)||!label.sprite?.position?.set)return;label.stylespec.position={...position};label.sprite.position.set(position.x,position.y,position.z);},
  remove,
  clear(){if(labels.size)remove(labels.keys());}
 };
}
