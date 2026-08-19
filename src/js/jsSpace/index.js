// jsSpace — a JavaScript XPREP-style space-group determination tool.
//
// Main entry point: loads the space-group dictionary, parses HKL files
// (XDS_ASCII, SHELX), and runs the full space-group analysis.
// Works both as a Node module (for the WebXTL server/UI) and from the CLI
// (see cli.js).

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHkl } from './hkl-parser.js';
import { buildLaueGroups } from './laue.js';
import { analyzeSpaceGroup, crystalSystemFromCell } from './analyze.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the space-group dictionary. The dictionary is a plain browser script
// (const SpaceGroupsData = [...]) so we evaluate it in a fresh vm context.
let cachedSpaceGroups = null;
export function loadSpaceGroups() {
    if (cachedSpaceGroups) return cachedSpaceGroups;
    const src = fs.readFileSync(path.join(__dirname, 'space-groups.js'), 'utf8');
    const context = {};
    vm.createContext(context);
    // `const SpaceGroupsData` is a lexical binding in the context, not a
    // property of the context object, so capture it explicitly.
    vm.runInContext(src + '\n;__capturedSpaceGroups = SpaceGroupsData;', context);
    if (!Array.isArray(context.__capturedSpaceGroups)) {
        throw new Error('space-groups.js did not define SpaceGroupsData');
    }
    cachedSpaceGroups = context.__capturedSpaceGroups;
    return cachedSpaceGroups;
}

let cachedLaueGroups = null;
export function getLaueGroups() {
    if (cachedLaueGroups) return cachedLaueGroups;
    cachedLaueGroups = buildLaueGroups(loadSpaceGroups());
    return cachedLaueGroups;
}

/**
 * Run the full jsSpace analysis on HKL file text.
 * options: { cell: {a,b,c,alpha,beta,gamma} } — only needed when the file
 * does not carry unit-cell parameters.
 * Returns { ok, error?, summary, spaceGroup }.
 */
export function analyzeHkl(text, options = {}) {
    let parsed;
    try {
        parsed = parseHkl(text);
    } catch (e) {
        return { ok: false, error: e.message };
    }

    let cell = parsed.cell || options.cell || null;
    if (!cell) {
        return {
            ok: false,
            error: 'NO_CELL',
            format: parsed.format,
            reflections: parsed.reflections,
            detail: 'This HKL file does not contain unit-cell parameters. Provide the unit cell.',
        };
    }
    const { a, b, c, alpha, beta, gamma } = cell;
    if (![a, b, c, alpha, beta, gamma].every(v => Number.isFinite(v) && v > 0)) {
        return { ok: false, error: 'Bad unit cell parameters.' };
    }

    const reflections = parsed.reflections;
    if (!reflections.length) {
        return { ok: false, error: 'No reflections parsed from the HKL file.' };
    }

    const laueGroups = getLaueGroups();
    const metric = crystalSystemFromCell(cell);
    const result = analyzeSpaceGroup(loadSpaceGroups(), reflections, cell, { laueGroups });

    const best = result.best;
    const summary = {
        format: parsed.format,
        title: parsed.title,
        wavelength: parsed.wavelength,
        nReflections: reflections.length,
        crystalSystem: result.crystalSystem,
        metricSystem: metric.system,
        uniqueAxis: metric.uniqueAxis,
        laueClass: result.laue.name,
        laueRSym: result.laue.rsym,
        centering: result.centering,
        centricity: result.centricity.centric ? 'centric' : (result.centricity.acentric ? 'acentric' : 'indeterminate'),
        centricityScore: result.centricity.score,
        bestSpaceGroup: best ? best.hm : null,
        bestSpaceGroupNumber: best ? best.id : null,
    };

    return {
        ok: true,
        cell,
        summary,
        laueTable: result.laue.table,
        centeringResults: result.centeringResults,
        candidates: result.candidates.slice(0, 30),
        best: result.best,
    };
}

// Convenience: return a compact one-line verdict string.
export function verdict(result) {
    if (!result || !result.ok) return 'n/a';
    const b = result.best;
    return b ? `${b.hm} (No. ${b.id})` : 'indeterminate';
}
