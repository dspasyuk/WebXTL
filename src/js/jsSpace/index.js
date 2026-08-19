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
import { buildLaueGroups, sgLaueClass } from './laue.js';
import { analyzeSpaceGroup, crystalSystemFromCell, scoreSpaceGroup } from './analyze.js';
import { mergeReflections, computeMergeStatistics, writeShelxHkl, writeXdsAscii, buildMergingReport, dSpacing } from './merge.js';

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

// Resolve a space group specified by number (e.g. 14) or Hermann-Mauguin /
// Hall symbol (e.g. "P 21/c", "P21/c", "-P 2ybc"). Returns the first matching
// dictionary entry or null.
export function resolveSpaceGroup(sgData, spec) {
    if (spec === undefined || spec === null || spec === '') return null;
    if (typeof spec === 'number' && Number.isFinite(spec)) {
        return sgData.find(g => g.id === spec) || null;
    }
    const str = String(spec).trim();
    if (/^\d+$/.test(str)) {
        return sgData.find(g => g.id === parseInt(str, 10)) || null;
    }
    const norm = str.replace(/\s+/g, ' ');
    let g = sgData.find(x => x.hm === norm || x.hs === norm);
    if (g) return g;
    const ns = norm.replace(/\s+/g, '');
    g = sgData.find(x => x.hm.replace(/\s+/g, '') === ns || x.hs.replace(/\s+/g, '') === ns);
    if (g) return g;
    // Try interpreting "P21/c" style without any spaces at all.
    g = sgData.find(x => x.hm.replace(/[\s]*/g, '') === spec.replace(/[\s]*/g, ''));
    if (g) return g;
    return null;
}

// Centering letter (P/A/B/C/I/F/R) from a space group entry.
function centeringOf(sg) {
    return (sg.hm || ' ')[0].toUpperCase();
}

/**
 * Run the full jsSpace analysis on HKL file text.
 * options: {
 *   cell: {a,b,c,alpha,beta,gamma},        // needed when the file has none
 *   spaceGroup: number | string,           // optionally force a space group
 *   laue: string,                          // optionally force a Laue class (e.g. '2/m', 'mmm')
 *   resolution: { dmin, dmax },            // optionally restrict to a resolution range
 *   sigThreshold: number,                  // significance threshold for absences (default 5)
 *   xdsOutput: string,                     // OUTPUT_FILE name for the merged XDS_ASCII
 * }
 * Returns { ok, error?, summary, best, merge }.
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

    let reflections = parsed.reflections;
    if (!reflections.length) {
        return { ok: false, error: 'No reflections parsed from the HKL file.' };
    }

    // Optionally restrict to a resolution range.
    if (options.resolution && options.resolution.dmin && options.resolution.dmax) {
        reflections = reflections.filter(r => {
            const d = dSpacing(r.h, r.k, r.l, cell);
            return Number.isFinite(d) && d >= options.resolution.dmin - 1e-6 && d <= options.resolution.dmax + 1e-6;
        });
        if (!reflections.length) {
            return { ok: false, error: 'No reflections within the requested resolution range.' };
        }
    }

    const laueGroups = getLaueGroups();
    const sgData = loadSpaceGroups();
    const metric = crystalSystemFromCell(cell);
    const result = analyzeSpaceGroup(sgData, reflections, cell, { laueGroups });

    // Optionally force a specific space group.
    const forcedSG = options.spaceGroup !== undefined
        ? resolveSpaceGroup(sgData, options.spaceGroup)
        : null;
    if (options.spaceGroup !== undefined && options.spaceGroup !== null && options.spaceGroup !== '' && !forcedSG) {
        return { ok: false, error: `Space group not found: ${options.spaceGroup}` };
    }

    // The space group used for merging / output: the forced one if given,
    // otherwise the best determined candidate.
    let usedSG = forcedSG || result.best;
    let usedLaueName = result.laue.name;
    let usedLaueOps = result.laue.ops;

    if (forcedSG) {
        // Use the Laue class of the forced space group for merging.
        const fl = sgLaueClass(forcedSG.s, laueGroups);
        if (fl) {
            const lg = laueGroups.find(g => g.name === fl);
            usedLaueName = fl;
            usedLaueOps = lg ? lg.settings[0].ops : result.laue.ops;
        }
    }

    // Optionally force a Laue class explicitly.
    if (options.laue) {
        const lg = laueGroups.find(g => g.name === options.laue);
        if (!lg) {
            return { ok: false, error: `Laue class not found: ${options.laue}` };
        }
        usedLaueName = lg.name;
        usedLaueOps = lg.settings[0].ops;
    }

    // Merge under the chosen Laue class and generate the corrected HKL output
    // (SHELX format + merged XDS_ASCII) plus a merging report.
    let merge = null;
    if (usedLaueOps) {
        const m = mergeReflections(reflections, usedLaueOps, cell);
        const stats = computeMergeStatistics(reflections, usedLaueOps, cell);
        const usedCentering = forcedSG ? centeringOf(forcedSG) : result.centering;
        const sgInfo = {
            hm: usedSG ? usedSG.hm : '?',
            id: usedSG ? usedSG.id : 0,
            laue: usedLaueName,
            centering: usedCentering,
        };
        merge = {
            nUnique: m.nUnique,
            nObs: m.nObs,
            shelxHkl: writeShelxHkl(m.merged),
            xdsAscii: writeXdsAscii(m.merged, {
                outputFile: options.xdsOutput || 'structure_XDS.HKL',
                cell,
                spaceGroupNumber: usedSG ? usedSG.id : undefined,
                spaceGroupName: usedSG ? usedSG.hm : undefined,
                wavelength: parsed.wavelength,
                dmin: stats.dmin,
                dmax: stats.dmax,
            }),
            statistics: stats,
            report: buildMergingReport(stats, sgInfo, cell),
        };
        // Consistency of the (possibly forced) space group with the data.
        const fullSG = usedSG && usedSG.id ? sgData.find(g => g.id === usedSG.id) : null;
        if (fullSG) {
            const sc = scoreSpaceGroup(fullSG, reflections, options.sigThreshold || 5);
            merge.consistency = {
                violations: sc.violations,
                confirmedOps: sc.confirmedOps,
                confirmedAbsences: sc.confirmedAbsences,
            };
        }
    }

    const summary = {
        format: parsed.format,
        title: parsed.title,
        wavelength: parsed.wavelength,
        nReflections: reflections.length,
        crystalSystem: result.crystalSystem,
        metricSystem: metric.system,
        uniqueAxis: metric.uniqueAxis,
        laueClass: usedLaueName,
        laueRSym: result.laue.rsym,
        centering: forcedSG ? centeringOf(forcedSG) : result.centering,
        centricity: result.centricity.centric ? 'centric' : (result.centricity.acentric ? 'acentric' : 'indeterminate'),
        centricityScore: result.centricity.score,
        forced: !!forcedSG,
        bestSpaceGroup: usedSG ? usedSG.hm : null,
        bestSpaceGroupNumber: usedSG ? usedSG.id : null,
        merged: merge ? {
            nUnique: merge.nUnique,
            nObs: merge.nObs,
            completeness: merge.statistics.completeness,
            rMerge: merge.statistics.rMerge,
            rPim: merge.statistics.rPim,
            meanIsig: merge.statistics.meanIsig,
            meanMultiplicity: merge.statistics.meanMultiplicity,
        } : null,
    };

    return {
        ok: true,
        cell,
        summary,
        laueTable: result.laue.table,
        centeringResults: result.centeringResults,
        candidates: result.candidates.slice(0, 30),
        best: usedSG,
        determined: result.best,
        forced: forcedSG ? { id: forcedSG.id, hm: forcedSG.hm, hs: forcedSG.hs } : null,
        merge,
    };
}

// Convenience: return a compact one-line verdict string.
export function verdict(result) {
    if (!result || !result.ok) return 'n/a';
    const b = result.best;
    return b ? `${b.hm} (No. ${b.id})` : 'indeterminate';
}
