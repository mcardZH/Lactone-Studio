// Generated from src/core/structure-library-provenance.ts; SHA256 83facaa1eb96e456c357f55dd089b32880b18ac8f5f025ad24a212152848128b
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateStructureLibraryProvenance = validateStructureLibraryProvenance;
const categories = new Set(['metals', 'nonmetals', 'metal-oxides', 'nonmetal-oxides', 'semiconductors', 'two-dimensional', 'layered-crystals', 'mof', 'cof', 'catalysts', 'ceramics', 'glasses', 'minerals', 'molecular-crystals', 'nanotubes', 'organics', 'polymers', 'repeat-units', 'zeolites']);
const sourceKeys = ['name', 'recordId', 'url', 'license', 'licenseUrl', 'structureKind', 'citation', 'doi', 'version', 'conditions', 'retrievedAt'];
function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
        throw new Error('结构库来源含无效或未支持的字段。');
    return value;
}
function text(value, max = 16384) {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new Error('结构库来源文字缺失或超出范围。');
}
function web(value) {
    text(value, 4096);
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
            throw new Error();
    }
    catch {
        throw new Error('结构库来源链接无效。');
    }
}
/** Validate on persistence/IPC boundaries; never interpret provenance as live science. */
function validateStructureLibraryProvenance(value) {
    const row = object(value, ['entryId', 'category', 'name', 'formula', 'phase', 'source', 'normalization']);
    text(row.entryId, 256);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row.entryId) || !categories.has(String(row.category)))
        throw new Error('结构库来源标识或分类无效。');
    for (const key of ['name', 'formula', 'phase'])
        text(row[key], 1024);
    const source = object(row.source, sourceKeys);
    for (const key of ['name', 'recordId', 'license', 'structureKind'])
        text(source[key], 1024);
    if (!['experimental', 'computed', 'curated', 'derived'].includes(String(source.structureKind)))
        throw new Error('结构库来源类型无效。');
    web(source.url);
    web(source.licenseUrl);
    for (const key of ['citation', 'doi', 'version', 'conditions', 'retrievedAt'])
        if (source[key] !== undefined)
            text(source[key]);
    const normalization = object(row.normalization, ['method', 'details']);
    text(normalization.method);
    if (normalization.details !== undefined) {
        if (!Array.isArray(normalization.details) || normalization.details.length > 128)
            throw new Error('结构库规范化步骤无效。');
        for (const item of normalization.details)
            text(item);
    }
}
