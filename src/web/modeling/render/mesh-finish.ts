import { meshFinishKey, normalizeMeshFinish, type MeshFinishSettings } from '../../../results/mesh-appearance';
import { isNativeStructureFinish, type StructureLighting } from '../../../modeling/appearance-presets';

/** Local finish for owned scientific addCustom meshes only. Never register a
 * ShaderLib entry or change a material/shape prototype. Locked renderer clones
 * the original material for depth/AO passes; each clone owns fresh uniforms.
 */
export const MESH_FINISH_VERTEX_SHADER = `
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 localLight;
attribute vec3 position;
attribute vec3 normal;
attribute vec3 color;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vLight;
varying vec4 mvPosition;
void main(){
  vNormal=normalMatrix*normal;
  vColor=color;
  vLight=(viewMatrix*vec4(localLight,0.0)).xyz;
  mvPosition=modelViewMatrix*vec4(position,1.0);
  gl_Position=projectionMatrix*mvPosition;
}`;
export const MESH_FINISH_FRAGMENT_SHADER = `
uniform mat4 projectionMatrix;
uniform float opacity;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float localAmbient;
uniform float localDiffuse;
uniform float localSpecular;
uniform float localExponent;
uniform float localOutline;
uniform float localOutlineWidth;
#ifdef SHADED
uniform highp sampler2D shading;
#endif
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vLight;
varying vec4 mvPosition;
//DEFINEFRAGCOLOR
vec3 unitOr(vec3 v,vec3 fallback){float n=length(v);return n>0.0?v/n:fallback;}
void main(){
  vec3 n=unitOr(vNormal,vec3(0.0,0.0,1.0));
  if(!gl_FrontFacing)n=-n;
  vec3 l=unitOr(vLight,vec3(0.0,0.0,1.0));
  // Orthographic rays are parallel; perspective rays point from the fragment
  // to the eye in view space. Do not use the diagnostic's fixed view for both.
  vec3 eye=abs(projectionMatrix[3][3])>0.5?vec3(0.0,0.0,1.0):unitOr(-mvPosition.xyz,vec3(0.0,0.0,1.0));
  vec3 h=unitOr(l+eye,vec3(0.0,0.0,1.0));
  float ndl=max(dot(n,l),0.0);
  float highlight=ndl>0.0?pow(max(dot(n,h),0.0),localExponent):0.0;
  vec3 rgb=vColor;
#ifndef WIREFRAME
  rgb=rgb*(localAmbient+localDiffuse*ndl)+vec3(localSpecular*highlight);
  // A material-local contour keeps unrelated scientific surfaces untouched.
  float facing=abs(dot(n,eye));
  // Keep the legacy branch exact. The optional gallery contour reaches the
  // visible normals of low-poly spheres/rods, not only mathematical tangency.
  float edge=localOutlineWidth>0.0
    ?1.0-smoothstep(max(0.0,localOutlineWidth-0.06),localOutlineWidth,facing)
    :1.0-smoothstep(0.0,0.24,facing);
  rgb*=1.0-localOutline*edge;
#endif
#ifdef SHADED
  ivec2 dim=textureSize(shading,0);
  rgb*=texture2D(shading,vec2(gl_FragCoord.x/float(dim.x),gl_FragCoord.y/float(dim.y))).r;
#endif
  // Preserve locked Lambert alpha (including its opacity squared).
  gl_FragColor=vec4(rgb,opacity*opacity);
  if(fogNear!=fogFar){float f=smoothstep(fogNear,fogFar,-mvPosition.z);gl_FragColor=mix(gl_FragColor,vec4(fogColor,gl_FragColor.a),f);}
}`;
const decorated = Symbol('sciyueOwnedMeshFinish');
/** Only explicitly opted-in structural meshes use these camera-space lights. */
export const STRUCTURE_GALLERY_FRAGMENT_SHADER=MESH_FINISH_FRAGMENT_SHADER
  .replace('uniform float localOutlineWidth;', 'uniform float localOutlineWidth;\nuniform float structureLightingMode;')
  .replace('  rgb=rgb*(localAmbient+localDiffuse*ndl)+vec3(localSpecular*highlight);', `
  vec3 key=normalize(vec3(-0.4,0.45,1.0));
  vec3 fill=normalize(vec3(0.65,0.15,1.0));
  vec3 rim=normalize(vec3(-0.2,-0.75,0.65));
  float a=max(dot(n,key),0.0),b=max(dot(n,fill),0.0),c=max(dot(n,rim),0.0);
  if(structureLightingMode<2.5){
    float illumination=localAmbient+localDiffuse*(0.72*a+0.18*b+0.10*c);
    float shine=pow(max(dot(n,normalize(key+eye)),0.0),localExponent)
      +0.30*pow(max(dot(n,normalize(fill+eye)),0.0),localExponent)
      +0.15*pow(max(dot(n,normalize(rim+eye)),0.0),localExponent);
    rgb=rgb*min(illumination,1.1)+vec3(localSpecular*0.55*shine);
  }else{
    vec3 v0=normalize(vec3(-0.1,0.1,1.0)),v1=normalize(vec3(1.0,2.0,0.5)),v3=normalize(vec3(-1.0,-1.0,0.0));
    float shine=pow(max(dot(reflect(-v0,n),eye),0.0),localExponent)
      +pow(max(dot(reflect(-v1,n),eye),0.0),localExponent)
      +pow(max(dot(reflect(-v3,n),eye),0.0),localExponent);
    rgb=rgb*(localAmbient+localDiffuse*(max(dot(n,v0),0.0)+max(dot(n,v1),0.0)+max(dot(n,v3),0.0)))+vec3(localSpecular*shine);
  }`);
type FinishState = { value: MeshFinishSettings; lighting?:StructureLighting };
const shapeFinishes = new WeakMap<object, FinishState>();
function decorate(material: any, state: FinishState): any {
  if (material[decorated]) {
    if (material[decorated] !== state) throw new Error('科学网格材质归属冲突。');
    return material;
  }
  const shaderID = material.shaderID;
  if (shaderID !== 'lambert' && shaderID !== 'lambertdouble' || typeof material.clone !== 'function') throw new Error('科学网格缺少已确认的局部材质接口。');
  const clone = material.clone;
  material.shaderID = '';
  material.vertexShader = MESH_FINISH_VERTEX_SHADER;
  material.fragmentShader = state.lighting?STRUCTURE_GALLERY_FRAGMENT_SHADER:MESH_FINISH_FRAGMENT_SHADER;
  material.uniforms = {
    opacity: { type:'f', value:material.opacity }, fogColor: { type:'c', value:{ r:1,g:1,b:1 } },
    fogNear: { type:'f',value:1 }, fogFar: { type:'f',value:2000 }, localLight: { type:'fv',value:[.2,.2,1] },
    localAmbient: { type:'f',get value(){return state.value.ambient??.1;} }, localDiffuse: { type:'f',get value(){return state.value.diffuse??.9;} },
    localOutline: { type:'f',get value(){return state.value.outline??0;} },
    localOutlineWidth: { type:'f',get value(){return state.value.outlineWidth??0;} },
    ...(state.lighting?{structureLightingMode:{type:'f',get value(){return state.lighting==='vmd'?3:state.lighting==='pymol-cpk'?2:1;}}}:{}),
    // Each material/clone owns its uniform wrappers. Only these two values
    // resolve from the handle's bounded Local state, so existing depth/shaded
    // clones and future globj materials update without retaining clone lists,
    // recompiling shader variants or touching geometry/normal/scalar buffers.
    localSpecular: { type:'f',get value(){return state.value.specular;} },
    localExponent: { type:'f',get value(){return state.value.exponent;} },
    // initMaterial skips makeShaded for custom shaderID, so predeclare the
    // locked shading-texture slot for its opaqueShaded clone as well.
    shading: { type:'i',value:3 },
  };
  material[decorated] = state; material.needsUpdate = true;
  material.clone = function(this: any, target?: any) {
    const copy = clone.call(this,target);
    copy.shaderID = shaderID;
    return decorate(copy,state);
  };
  return material;
}

/** The owned GLShape recreates child materials on explicit viewer.render.
 * Decorate each new child before the existing resource owner observes it. */
export function attachLocalMeshFinish<T>(shape: T, finish?: MeshFinishSettings, lighting?:StructureLighting): T {
  const owned = shape as any, globj = owned?.globj;
  if (!owned || typeof owned !== 'object') return shape;
  const previous = shapeFinishes.get(owned);
  if (previous) { previous.value=normalizeMeshFinish(finish); previous.lighting=lighting; return shape; }
  const state: FinishState = { value:normalizeMeshFinish(finish),lighting }; shapeFinishes.set(owned,state);
  // Renderer-independent test doubles need not manufacture native materials.
  if (typeof globj !== 'function') return shape;
  owned.globj = function(this: any, group: any) {
    const result = globj.call(this,group), root = this.renderedShapeObj;
    if (!root) return result; // Hidden/frame-filtered shapes retain no material.
    for (const child of root.children ?? []) if (child.geometry && child.material) decorate(child.material,state);
    return result;
  };
  return shape;
}

/** Updates numerical uniforms of current and future material/clone instances.
 * A renderer redraw remains the caller's normal presentation operation. */
export function updateLocalMeshFinish(shape: any, finish?: MeshFinishSettings): boolean {
  const state=shapeFinishes.get(shape), value=normalizeMeshFinish(finish);
  if (!state) { attachLocalMeshFinish(shape,value); return true; }
  if (meshFinishKey(state.value)===meshFinishKey(value)) return false;
  state.value=value; return true;
}

const modelFinishes=new WeakMap<object,FinishState>();
/** Keep each owned structural model on the locked renderer's regular mesh
 * path so it can receive the same bounded material as structural rods.
 * No native prototype, renderer capability or scientific mesh is changed. */
export function attachStructureModelFinish<T>(model:T,finish?:MeshFinishSettings,lighting?:StructureLighting):T{
  const owned=model as any;if(!owned||typeof owned!=='object'||typeof owned.globj!=='function'||!lighting&&isNativeStructureFinish(finish))return model;
  const previous=modelFinishes.get(owned);if(previous){previous.value=normalizeMeshFinish(finish);previous.lighting=lighting;return model;}
  const state:FinishState={value:normalizeMeshFinish(finish),lighting},globj=owned.globj;modelFinishes.set(owned,state);
  owned.globj=function(this:any,group:any,options:any){const result=globj.call(this,group,{...options,supportsImposters:false,supportsAIA:false});
    const visit=(node:any)=>{if(node?.geometry&&node.material)decorate(node.material,state);for(const child of node?.children??[])visit(child);};
    visit(this.renderedMolObj);return result;
  };return model;
}
/** Native-equivalent custom controls must not change structural tessellation
 * or replace native rod lighting merely by entering the custom editor. */
export function attachStructureShapeFinish<T>(shape:T,finish?:MeshFinishSettings,lighting?:StructureLighting):T{return !lighting&&isNativeStructureFinish(finish)?shape:attachLocalMeshFinish(shape,finish,lighting);}
