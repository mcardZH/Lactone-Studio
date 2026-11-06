// Shared pure JSON contract: used by renderer/domain and the host store. No
// filesystem, task metadata, model initialization or chemistry operation.
export const PERSONAL_FRAGMENT_LIMITS = Object.freeze({ bytes: Number.MAX_SAFE_INTEGER, fragments: Number.MAX_SAFE_INTEGER, atoms: Number.MAX_SAFE_INTEGER, totalAtoms: Number.MAX_SAFE_INTEGER, bonds: Number.MAX_SAFE_INTEGER, ports: Number.MAX_SAFE_INTEGER });
const elements = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' '));
const fail = message => { throw new Error('个人片段：' + message); };
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('字段必须是普通对象。');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) || required.some(key => !Object.hasOwn(value, key))) fail('含未知、缺失或恶意字段。');
}
function array(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || (limit !== undefined && value.length > limit) || Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).length !== value.length || Object.keys(value).some((key, i) => key !== String(i) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('数组无效或超出预算。');
}
function text(value, maximum) { if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail('名称或分类无效。'); }
function flag(value) { if (typeof value !== 'boolean') fail('标记必须为布尔值。'); }
function presetIdentity(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,199}$/.test(value)) fail('几何预设或槽位身份无效。'); }
function vector(value) { array(value, 3); if (value.length !== 3 || value.some(x => typeof x !== 'number' || !Number.isFinite(x))) fail('方向必须为三个有限数。'); }
export function validatePersonalFragmentTemplate(value) {
  object(value, ['id', 'name', 'category', 'activeIndex', 'atoms', 'bonds', 'ports']);
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id)) fail('模板ID无效。');
  text(value.name, 80); text(value.category, 40);
  array(value.atoms); array(value.bonds); array(value.ports);
  if (!value.atoms.length || !Number.isSafeInteger(value.activeIndex) || value.activeIndex < 0 || value.activeIndex >= value.atoms.length) fail('真实原子或接入位无效。');
  const atomIds = new Set(), canonicalIds = new Set(value.atoms.map((_, i) => 'a' + i));
  value.atoms.forEach(atom => {
    object(atom, ['id', 'element', 'x', 'y', 'z', 'formalCharge', 'stereoParity', 'hydrogenMode', 'aromaticHydrogen', 'geometryPresetId'], ['id', 'element', 'x', 'y', 'z']);
    if (!canonicalIds.has(atom.id) || atomIds.has(atom.id) || !elements.has(atom.element) || ![atom.x, atom.y, atom.z].every(x => typeof x === 'number' && Number.isFinite(x))) fail('原子ID/元素/有限坐标无效。');
    atomIds.add(atom.id);
    if (Object.hasOwn(atom, 'formalCharge') && !Number.isSafeInteger(atom.formalCharge)) fail('形式电荷必须为安全整数。');
    if (Object.hasOwn(atom, 'stereoParity') && ![-1, 0, 1].includes(atom.stereoParity)) fail('构型标记无效。');
    if (Object.hasOwn(atom, 'hydrogenMode') && !['auto', 'explicit'].includes(atom.hydrogenMode)) fail('H策略标记无效。');
    if (Object.hasOwn(atom, 'aromaticHydrogen')) flag(atom.aromaticHydrogen);
    if (Object.hasOwn(atom, 'geometryPresetId')) { presetIdentity(atom.geometryPresetId); if (!atom.geometryPresetId.startsWith(atom.element.toLowerCase() + '-')) fail('几何预设与元素不一致。'); }
  });
  const edges = new Set();
  value.bonds.forEach(bond => {
    object(bond, ['a', 'b', 'order', 'aromatic', 'stereo', 'kind', 'fractional', 'perception', 'mbo'], ['a', 'b', 'order']);
    if (![bond.a, bond.b].every(i => Number.isSafeInteger(i) && i >= 0 && i < value.atoms.length) || bond.a === bond.b || ![0.5, 1, 1.5, 2, 3, 4].includes(bond.order)) fail('键端点/键级无效。');
    const key = [bond.a, bond.b].sort((a, b) => a - b).join(':'); if (edges.has(key)) fail('重复键。'); edges.add(key);
    if (Object.hasOwn(bond, 'aromatic')) flag(bond.aromatic);
    if (Object.hasOwn(bond, 'fractional')) flag(bond.fractional);
    if (Object.hasOwn(bond, 'kind') && !['covalent', 'coordination'].includes(bond.kind)) fail('键类型无效。');
    if (Object.hasOwn(bond, 'stereo') && (!Number.isSafeInteger(bond.stereo) || bond.stereo < 0 || bond.stereo > 6)) fail('键构型无效。');
    if (bond.fractional && (![0.5, 1.5].includes(bond.order) || bond.aromatic) || bond.order === 0.5 && bond.fractional !== true) fail('分数键标记不一致。');
    if (bond.perception !== undefined && !['gfn2-mbo', 'metal-distance'].includes(bond.perception)) fail('键识别来源无效。');
    if (bond.mbo !== undefined && (!Number.isFinite(bond.mbo) || bond.mbo <= .1 || bond.perception === undefined)) fail('原始MBO数值/来源无效。');
    if (bond.perception === 'gfn2-mbo') {
      const raw = bond.mbo, order = raw <= .25 ? 0 : raw <= .75 ? .5 : raw <= 1.25 ? 1 : raw <= 1.75 ? 1.5 : raw <= 2.5 ? 2 : 3;
      if (!Number.isFinite(raw) || raw <= .25 || order !== bond.order || bond.aromatic || bond.kind === 'coordination' || Boolean(bond.fractional) !== [0.5, 1.5].includes(order)) fail('GFN2 MBO与量化键级不一致。');
    }
    if (bond.perception === 'metal-distance' && (bond.kind !== 'coordination' || bond.order !== 1 || bond.fractional === true || bond.aromatic || bond.mbo !== undefined && bond.mbo > .25)) fail('金属距离辅助配位接触无效。');
  });
  const namedSlots = new Set(), atomsById=new Map(value.atoms.map(atom=>[atom.id,atom]));
  value.ports.forEach((port, index) => {
    object(port, ['id', 'hostAtomId', 'direction', 'order', 'displayLength', 'presetId', 'slotId'], ['id', 'hostAtomId', 'direction', 'order', 'displayLength']);
    if (port.id !== 'p' + index || !atomsById.has(port.hostAtomId) || ![1, 1.5, 2, 3].includes(port.order) || typeof port.displayLength !== 'number' || !Number.isFinite(port.displayLength) || port.displayLength <= 0 || port.displayLength > 10) fail('连接端口无效。');
    vector(port.direction); if (Math.abs(Math.hypot(...port.direction) - 1) > 1e-6) fail('端口方向必须为单位向量。');
    const hasPreset = Object.hasOwn(port, 'presetId'), hasSlot = Object.hasOwn(port, 'slotId');
    if (hasPreset !== hasSlot) fail('命名端口需同时保存预设与槽位身份。');
    if (hasPreset) {
      presetIdentity(port.presetId); presetIdentity(port.slotId);
      const host = atomsById.get(port.hostAtomId);
      if (host.geometryPresetId !== port.presetId || !port.slotId.startsWith(port.presetId + '-slot-') || !/^[1-9]\d*$/.test(port.slotId.slice((port.presetId + '-slot-').length))) fail('端口预设或槽位与宿主不一致。');
      const key = JSON.stringify([port.hostAtomId, port.slotId]); if (namedSlots.has(key)) fail('命名槽位重复。'); namedSlots.add(key);
    }
  });
  return structuredClone(value);
}
export function validatePersonalFragmentLibrary(value) {
  object(value, ['schema', 'version', 'fragments', 'categories'], ['schema', 'version', 'fragments']);
  if (value.schema !== 'sciyue-personal-fragments' || value.version !== 1) fail('损坏或未来版本不支持，原数据需保留。');
  array(value.fragments);
  const ids = new Set();
  const fragments = value.fragments.map(item => { const template = validatePersonalFragmentTemplate(item); if (ids.has(template.id)) fail('模板ID重复。'); ids.add(template.id); return template; });
  let categories;
  if (Object.hasOwn(value, 'categories')) {
    array(value.categories);
    categories = value.categories.map(category => { text(category, 40); return category; });
    if (new Set(categories).size !== categories.length) fail('分类重复。');
  }
  const result = { schema: 'sciyue-personal-fragments', version: 1, fragments, ...(categories ? { categories } : {}) };
  return result;
}
export const emptyPersonalFragmentLibrary = () => ({ schema: 'sciyue-personal-fragments', version: 1, fragments: [] });
/** JSON permits -0, but ordinary JSON.stringify discards its sign. Keep exact
 * numerical Cartesian components without tagged/hidden metadata fields. */
export function serializePersonalFragmentLibrary(value) {
  const library = validatePersonalFragmentLibrary(value);
  const encode = item => {
    if (typeof item === 'number' && Object.is(item, -0)) return '-0';
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    if (item && typeof item === 'object') return '{' + Object.keys(item).map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    return JSON.stringify(item);
  };
  return encode(library) + '\n';
}
