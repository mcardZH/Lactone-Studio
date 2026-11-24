import type {MeshVertexColor} from './mesh-geometry';
import {nativeMeshChunk,type PackedChunk} from './surface-mesh-transfer';

type MeshStyle={color:string;opacity:number;clickable:false;hoverable:false};

/** The locked 3Dmol public helper retains input point objects in stylespec
 * and copies them into Float32. For its actual owned GLShape, make the identical
 * geometry group directly and keep only its exact-size native buffers. */
export function addPackedNativeMesh(viewer:any,mol:any,chunk:PackedChunk,style:MeshStyle,colors?:readonly MeshVertexColor[]) {
  const native=typeof mol.GLViewer==='function'&&viewer instanceof mol.GLViewer&&typeof viewer.addShape==='function'&&typeof mol.CC?.color==='function';
  if(native){
    const shape=viewer.addShape(style);
    try {
      const group=shape.geo?.addGeoGroup?.();
      if(group&&typeof group.setLineIndices==='function'&&typeof shape.finalize==='function'){
        group.vertices=chunk.vertices.length/3;group.faceidx=chunk.faces.length;
        group.vertexArray=Float32Array.from(chunk.vertices);group.normalArray=Float32Array.from(chunk.normals);
        group.faceArray=chunk.faces instanceof Uint16Array?chunk.faces:Uint16Array.from(chunk.faces);
        group.colorArray=new Float32Array(chunk.vertices.length);
        const solid=mol.CC.color(style.color);
        for(let i=0;i<group.vertices;i++){
          const color=colors?.[i]??solid,j=i*3;
          group.colorArray[j]=color.r;group.colorArray[j+1]=color.g;group.colorArray[j+2]=color.b;
        }
        group.setLineIndices();group.lineidx=group.lineArray.length;
        shape.finalize();return shape;
      }
    }catch(error){viewer.removeShape(shape);throw error;}
    viewer.removeShape(shape);
  }
  const spec={...nativeMeshChunk(chunk),...style,...(colors?{colorArr:colors}:{})};
  const shape=viewer.addCustom(spec);
  if(shape?.stylespec===spec){const styles=shape.stylespec;delete styles.vertexArr;delete styles.faceArr;delete styles.normalArr;delete styles.colorArr;}
  return shape;
}
