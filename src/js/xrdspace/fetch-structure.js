// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Download structures from the Crystallography Open Database (COD) and the
// RCSB Protein Data Bank (PDB) and write them into WebXTL projects.
//
// The unit-cell search itself lives in cell-search.js; this module turns a
// chosen hit (or a direct database id) into an on-disk project directory so the
// structure can be opened, viewed and refined like any other project:
//
//   projects/COD_1000000/1000000.cif     (COD CIF)
//   projects/COD_1000000/1000000.hkl     (COD reflections, when published)
//   projects/COD_1000000/metadata.json   (cell, space group, provenance)
//   projects/PDB_1CRN/1CRN.pdb           (PDB coordinate file)
//
//   - fetchCodEntry()             download a COD entry (CIF + optional HKL)
//   - fetchPdbEntry()             download a PDB entry (PDB or mmCIF)
//   - fetchStructure()            dispatch on the database name
//   - importStructureToProject()  download and persist into a project folder

import fs from 'node:fs';
import path from 'node:path';

export const COD_BASE = 'https://www.crystallography.net/cod';
export const RCSB_DOWNLOAD = 'https://files.rcsb.org/download';

const DEFAULT_TIMEOUT_MS = 90000;

// --- HTTP helpers ---

async function httpText(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
            const err = new Error(`HTTP ${res.status} for ${url}${detail ? `: ${detail}` : ''}`);
            err.status = res.status;
            throw err;
        }
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// Keep only characters that are safe in a filesystem name / URL path segment.
export function sanitizeStructureId(id) {
    return String(id == null ? '' : id).trim().replace(/[^A-Za-z0-9_-]/g, '');
}

// Canonical WebXTL project name for a database entry: COD_1000000, PDB_1CRN.
export function entryProjectName(database, id) {
    return `${String(database).toUpperCase()}_${sanitizeStructureId(id)}`;
}

// --- light-weight metadata extraction (no full CIF/PDB parser needed) ---

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build a regex for a CIF1 tag that also matches its CIF2/mmCIF spelling
// (the first category separator becomes a dot): _cell_length_a -> _cell.length_a.
function cifTagPattern(tag, valuePattern) {
    const m = tag.match(/^_([^_]+)_(.*)$/);
    const body = m
        ? `_${escapeRegExp(m[1])}[._]${escapeRegExp(m[2])}`
        : escapeRegExp(tag);
    return new RegExp(`^\\s*${body}\\s+(${valuePattern})`, 'm');
}

function cifNumber(text, tag) {
    const m = text.match(cifTagPattern(tag, '\\S+'));
    if (!m) return null;
    const v = parseFloat(m[1].split('(')[0]);
    return Number.isFinite(v) ? v : null;
}

function cifString(text, tags) {
    for (const tag of tags) {
        const m = text.match(cifTagPattern(tag, '.+$'));
        if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
    }
    return null;
}

// Extract cell / space group / title / formula from a CIF (small-molecule or
// mmCIF). Returns null cell when the tags are absent.
export function parseCifMetadata(text) {
    const cell = {
        a: cifNumber(text, '_cell_length_a'),
        b: cifNumber(text, '_cell_length_b'),
        c: cifNumber(text, '_cell_length_c'),
        alpha: cifNumber(text, '_cell_angle_alpha'),
        beta: cifNumber(text, '_cell_angle_beta'),
        gamma: cifNumber(text, '_cell_angle_gamma'),
    };
    const hasCell = [cell.a, cell.b, cell.c, cell.alpha, cell.beta, cell.gamma].every(Number.isFinite);
    return {
        cell: hasCell ? cell : null,
        spaceGroup: cifString(text, ['_symmetry_space_group_name_H-M', '_space_group_name_H-M_alt']),
        title: cifString(text, ['_struct_title', '_chemical_name_systematic', '_chemical_name_common', '_chemical_name_common_name']),
        formula: cifString(text, ['_chemical_formula_sum', '_chemical_formula_moiety']),
    };
}

// Extract cell / space group / title from a legacy PDB file (CRYST1 + TITLE).
export function parsePdbMetadata(text) {
    let cell = null;
    let spaceGroup = null;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('CRYST1')) {
            const a = parseFloat(line.slice(6, 15));
            const b = parseFloat(line.slice(15, 24));
            const c = parseFloat(line.slice(24, 33));
            const alpha = parseFloat(line.slice(33, 40));
            const beta = parseFloat(line.slice(40, 47));
            const gamma = parseFloat(line.slice(47, 54));
            const sg = line.slice(55, 66).trim();
            if ([a, b, c, alpha, beta, gamma].every(Number.isFinite)) {
                cell = { a, b, c, alpha, beta, gamma };
            }
            if (sg) spaceGroup = sg;
            break;
        }
    }
    const title = text.split(/\r?\n/)
        .filter(l => l.startsWith('TITLE '))
        .map(l => l.slice(10).trim())
        .join(' ')
        .trim() || null;
    return { cell, spaceGroup, title, formula: null };
}

// --- database fetchers ---

// Download a COD entry. The CIF is required; the companion .hkl reflection
// file is optional (many COD entries do not publish one). Returns
//   { database, id, files: [{ name, content }], structureFile, metadata }
export async function fetchCodEntry(id, { includeHkl = true, timeoutMs } = {}) {
    const clean = sanitizeStructureId(id);
    if (!clean) throw new Error('A COD id is required.');
    // Files are named after the project so server-side runs (SHELXL/PLATON)
    // find <project>.ins/.hkl and the generic project loader can open it.
    const project = entryProjectName('COD', clean);

    const cifText = await httpText(`${COD_BASE}/${clean}.cif`, { timeoutMs });
    const files = [{ name: `${project}.cif`, content: cifText }];

    let hklName = null;
    if (includeHkl) {
        try {
            const hklText = await httpText(`${COD_BASE}/${clean}.hkl`, { timeoutMs });
            if (hklText && hklText.trim()) {
                hklName = `${project}.hkl`;
                files.push({ name: hklName, content: hklText });
            }
        } catch (e) {
            // 404 simply means no reflection file was published - not an error.
            if (e.status !== 404) console.warn(`fetchCodEntry ${clean}: hkl unavailable (${e.message})`);
        }
    }

    const meta = parseCifMetadata(cifText);
    return {
        database: 'COD',
        id: clean,
        files,
        structureFile: `${project}.cif`,
        hklFile: hklName,
        metadata: {
            ...meta,
            source: `${COD_BASE}/${clean}.cif`,
            hklSource: hklName ? `${COD_BASE}/${clean}.hkl` : null,
        },
    };
}

// Download a PDB entry. `format` is 'pdb' (legacy, default) or 'cif' (mmCIF).
export async function fetchPdbEntry(id, { format = 'pdb', timeoutMs } = {}) {
    const clean = sanitizeStructureId(id).toUpperCase();
    if (!clean) throw new Error('A PDB id is required.');
    const ext = format === 'cif' ? 'cif' : 'pdb';
    const project = entryProjectName('PDB', clean);

    const text = await httpText(`${RCSB_DOWNLOAD}/${clean}.${ext}`, { timeoutMs });
    const meta = format === 'cif' ? parseCifMetadata(text) : parsePdbMetadata(text);

    return {
        database: 'PDB',
        id: clean,
        files: [{ name: `${project}.${ext}`, content: text }],
        structureFile: `${project}.${ext}`,
        hklFile: null,
        metadata: {
            ...meta,
            source: `${RCSB_DOWNLOAD}/${clean}.${ext}`,
            hklSource: null,
        },
    };
}

// Dispatch on the database name ('COD' | 'PDB').
export async function fetchStructure(database, id, options = {}) {
    const db = String(database).toUpperCase();
    if (db === 'COD') return fetchCodEntry(id, options);
    if (db === 'PDB') return fetchPdbEntry(id, options);
    throw new Error(`Unknown database '${database}' (expected COD or PDB).`);
}

// --- project persistence ---

// Find the primary structure file of a fetched project.
function findStructureFile(projectDir, project) {
    for (const ext of ['cif', 'pdb', 'res', 'ins']) {
        const p = path.join(projectDir, `${project}.${ext}`);
        if (fs.existsSync(p)) return `${project}.${ext}`;
    }
    try {
        const hit = fs.readdirSync(projectDir)
            .find(f => /\.(cif|pdb|res|ins)$/i.test(f));
        return hit || null;
    } catch (e) {
        return null;
    }
}

// Download a database entry and persist it as projects/<DB>_<id>/. Returns a
// description of the project (files, structure file, metadata). When the
// project already exists and `overwrite` is false the existing files are kept.
export async function importStructureToProject(baseDir, database, id, options = {}) {
    const db = String(database).toUpperCase();
    // PDB ids are case-insensitive; canonicalise to upper case so the project
    // folder and the coordinate file share the same basename.
    const clean = db === 'PDB' ? sanitizeStructureId(id).toUpperCase() : sanitizeStructureId(id);
    if (!clean) throw new Error('A structure id is required.');
    if (db !== 'COD' && db !== 'PDB') throw new Error(`Unknown database '${database}'.`);

    const project = entryProjectName(db, clean);
    const projectDir = path.join(baseDir, project);

    if (!options.overwrite) {
        const existing = findStructureFile(projectDir, project);
        if (existing) {
            let meta = {};
            const metaPath = path.join(projectDir, 'metadata.json');
            if (fs.existsSync(metaPath)) {
                try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { /* ignore */ }
            }
            return {
                project,
                database: db,
                id: clean,
                files: fs.readdirSync(projectDir),
                structureFile: existing,
                reused: true,
                cell: meta.cell || null,
                spaceGroup: meta.spaceGroup || null,
                title: meta.title || null,
                formula: meta.formula || null,
                source: meta.source || null,
            };
        }
    }

    const fetched = await fetchStructure(db, clean, {
        includeHkl: options.includeHkl,
        format: options.format,
        timeoutMs: options.timeoutMs,
    });

    fs.mkdirSync(projectDir, { recursive: true });
    for (const f of fetched.files) {
        fs.writeFileSync(path.join(projectDir, f.name), f.content, 'utf8');
    }

    const record = {
        database: db,
        id: clean,
        fetchedAt: new Date().toISOString(),
        ...fetched.metadata,
        structureFile: fetched.structureFile,
        hklFile: fetched.hklFile,
    };
    fs.writeFileSync(path.join(projectDir, 'metadata.json'), JSON.stringify(record, null, 2), 'utf8');

    return {
        project,
        database: db,
        id: clean,
        files: fetched.files.map(f => f.name).concat('metadata.json'),
        structureFile: fetched.structureFile,
        hklFile: fetched.hklFile,
        reused: false,
        cell: fetched.metadata.cell,
        spaceGroup: fetched.metadata.spaceGroup,
        title: fetched.metadata.title,
        formula: fetched.metadata.formula,
        source: fetched.metadata.source,
    };
}
