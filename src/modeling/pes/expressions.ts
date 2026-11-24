import type { Structure } from '../../core/types';
import { confirmCoordinateSelection } from '../application/coordinate-selection';
import type { PesAxis, PesCard, PesCoordinate, PesExpressionDraft } from './contracts';

const namePattern = /^[\p{L}_][\p{L}\p{N}_]*$/u;
export function pesCoordinateNameIssue(name: string, used: { has(name: string): boolean }) {
  if (!namePattern.test(name)) return 'invalid-name';
  if (used.has(name)) return 'duplicate-name';
}
const tokenPattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?|([\p{L}_][\p{L}\p{N}_]*)|([+\-*/()×÷−]))/uy;
const operator = (token: string) => ({ '×': '*', '÷': '/', '−': '-' } as Record<string, string>)[token] ?? token;

export function nextCoordinateName(type: PesCoordinate['type'], coordinates: readonly PesCoordinate[]): string {
  const names = new Set(coordinates.map(coordinate => coordinate.name));
  let index = 1;
  while (names.has(`${type}${index}`)) index += 1;
  return `${type}${index}`;
}

/** Names are editable labels. Compilation maps them to IDs and never sends labels as code. */
export function renameCoordinate(draft: PesExpressionDraft, id: string, nextName: string): PesExpressionDraft {
  const original = draft.coordinates.find(coordinate => coordinate.id === id);
  if (!original) return draft;
  const unique = namePattern.test(nextName) && !draft.coordinates.some(row => row.id !== id && row.name === nextName);
  if (!unique) throw Error('内坐标名称须以文字或下划线开头，仅含文字、数字和下划线，且不可重复。');
  const expression = draft.expression.replace(/\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}_]*/gu, match => match === original.name ? nextName : match);
  return { expression, coordinates: draft.coordinates.map(coordinate => coordinate.id === id ? { ...coordinate, name: nextName, nameDraft: undefined } : coordinate) };
}

/** Normalize only the card being edited. Legacy axes can own different B1
 * definitions; retain their IDs/expressions while disambiguating labels. */
export function sharedScanCard(card: PesCard): PesCard {
  if (card.scanCoordinates !== undefined && (card.scanCoordinates.length || card.axes.every(axis => !axis.definition.coordinates.length))) return card;
  const coordinates: PesExpressionDraft['coordinates'] = [];
  const axes = card.axes.map(axis => {
    let definition = axis.definition;
    for (const original of axis.definition.coordinates) {
      const known = coordinates.find(row => row.id === original.id);
      if (known) continue;
      let coordinate = original;
      if (coordinates.some(row => row.name === original.name)) {
        const name = nextCoordinateName(original.type, coordinates);
        definition = renameCoordinate(definition, original.id, name);
        coordinate = { ...original, name };
      }
      coordinates.push(coordinate);
    }
    return { ...axis, definition };
  }) as PesCard['axes'];
  return { ...card, scanCoordinates: coordinates, axes: axes.map(axis => ({ ...axis, definition: { ...axis.definition, coordinates } })) as PesCard['axes'] };
}

export function scanAxisDefinition(card: PesCard, axis: PesAxis): PesExpressionDraft {
  const coordinates = card.scanCoordinates;
  return coordinates !== undefined && (coordinates.length || !axis.definition.coordinates.length) ? { ...axis.definition, coordinates } : axis.definition;
}

export function updateScanCoordinates(card: PesCard, coordinates: PesExpressionDraft['coordinates']): PesCard {
  return { ...card, scanCoordinates: coordinates, axes: card.axes.map(axis => ({ ...axis, definition: { ...axis.definition, coordinates } })) as PesCard['axes'] };
}

export function renameScanCoordinate(card: PesCard, id: string, nextName: string): PesCard {
  const current = sharedScanCard(card);
  const axes = current.axes.map(axis => ({ ...axis, definition: renameCoordinate(scanAxisDefinition(current, axis), id, nextName) })) as PesCard['axes'];
  return { ...current, axes, scanCoordinates: axes[0].definition.coordinates };
}

/** New readers are needed for shared rows and a manually cleared start. */
export function scanRequiresFormat11(card: PesCard): boolean {
  return card.kind === 'scan' && (card.scanCoordinates !== undefined || card.scanCoordinateDrafts !== undefined || card.scanCoordinateOrder !== undefined
    || card.scanConvergencePreset !== undefined || card.axes.some(axis => axis.lowerMode !== undefined));
}

interface Quantity { value: number; length: number; angle: number }
interface ExpressionValue extends Quantity { wire: string; directCoordinate?: PesCoordinate; references: Set<string> }
export interface PesCompiledExpression {
  value: number;
  unit: string;
  wire: string;
  coordinateId?: string;
  periodic: boolean;
  coordinateIds: Set<string>;
}
const superscripts: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const unitPart = (unit: string, power: number) => power ? `${unit}${power === 1 ? '' : String(power).split('').map(digit => superscripts[digit]).join('')}` : '';

export function compilePesExpression(draft: PesExpressionDraft, structure: Structure): PesCompiledExpression {
  if (!draft.expression.trim()) throw Error('请输入内坐标表达式。');
  const coordinates = new Map<string, PesCoordinate>();
  for (const coordinate of draft.coordinates) {
    if (coordinate.nameDraft !== undefined && coordinate.nameDraft !== coordinate.name) throw Error('请确认或修正已编辑的内坐标名称。');
    const issue=pesCoordinateNameIssue(coordinate.name,coordinates);
    if(issue)throw Error(issue==='duplicate-name'?`内坐标名称重复：${coordinate.name}（${coordinate.id}）。`:`内坐标名称无效：${coordinate.name}（${coordinate.id}）。`);
    coordinates.set(coordinate.name, coordinate);
  }
  const tokens: string[] = [];
  const input = draft.expression.trim();
  tokenPattern.lastIndex = 0;
  while (tokenPattern.lastIndex < input.length) {
    const match = tokenPattern.exec(input);
    if (!match) throw Error('表达式含有不支持的字符。');
    tokens.push(match[1] ? match[1] + (match[2] ?? '') : match[3] ?? operator(match[4]));
  }
  let cursor = 0;
  function combine(left: ExpressionValue, op: string, right: ExpressionValue): ExpressionValue {
    const equalUnits = left.length === right.length && left.angle === right.angle;
    if ((op === '+' || op === '-') && !equalUnits) throw Error('加减运算需要相同量纲。');
    if (op === '/' && right.value === 0) throw Error('当前结构下表达式除数为零。');
    const value = op === '+' ? left.value + right.value : op === '-' ? left.value - right.value : op === '*' ? left.value * right.value : left.value / right.value;
    const dimension = op === '*' ? 1 : op === '/' ? -1 : 0;
    return { value, length: left.length + dimension * right.length, angle: left.angle + dimension * right.angle,
      wire: `(${left.wire}${op}${right.wire})`, references: new Set([...left.references, ...right.references]) };
  }
  function atom(): ExpressionValue {
    const token = tokens[cursor++];
    if (!token) throw Error('表达式尚未完成。');
    if (token === '(') {
      const value = sum();
      if (tokens[cursor++] !== ')') throw Error('表达式的括号未配对。');
      return value;
    }
    if (token === '+' || token === '-') {
      const operand = atom();
      if (token === '+') return operand;
      return { ...operand, value: -operand.value, wire: `(-${operand.wire})`, directCoordinate: undefined };
    }
    const coordinate = coordinates.get(token);
    if (coordinate) {
      const geometry = confirmCoordinateSelection(structure, coordinate.atomIds, coordinate.images);
      if (geometry.type !== coordinate.type) throw Error(`${coordinate.name} 的原子与内坐标类型不符。`);
      return { value: geometry.value, length: coordinate.type === 'B' ? 1 : 0, angle: coordinate.type === 'B' ? 0 : 1,
        wire: `{${coordinate.id}}`, directCoordinate: coordinate, references: new Set([coordinate.id]) };
    }
    if (namePattern.test(token)) throw Error(`表达式引用的内坐标“${token}”缺失。`);
    if (!Number.isFinite(Number(token))) throw Error('表达式需要数值、内坐标或括号。');
    return { value: Number(token), length: 0, angle: 0, wire: String(Number(token)), references: new Set() };
  }
  function product() {
    let value = atom();
    while (tokens[cursor] === '*' || tokens[cursor] === '/') value = combine(value, tokens[cursor++], atom());
    return value;
  }
  function sum() {
    let value = product();
    while (tokens[cursor] === '+' || tokens[cursor] === '-') value = combine(value, tokens[cursor++], product());
    return value;
  }
  const value = sum();
  if (cursor !== tokens.length) throw Error('表达式缺少运算符或括号不匹配。');
  if (!value.references.size) throw Error('请在表达式中引用至少一个内坐标。');
  if (!Number.isFinite(value.value)) throw Error('表达式在当前结构下无法得到有限值。');
  return { value: value.value, unit: [unitPart('Å', value.length), unitPart('°', value.angle)].filter(Boolean).join('·') || '无量纲',
    wire: value.wire, coordinateId: value.directCoordinate?.id, periodic: value.directCoordinate?.type === 'D', coordinateIds: value.references };
}
