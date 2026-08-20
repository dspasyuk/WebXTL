// Copyright (c) 2026 Denis Spasyuk. MIT License.
// xrdspace — a JavaScript XPREP-style space-group determination tool.
//
// Main entry point: loads the space-group dictionary, parses HKL files
// (XDS_ASCII, SHELX), and runs the full space-group analysis.
// Works both as a Node module (for the WebXTL server/UI) and from the CLI
// (see xrdspace.js).

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHkl } from './hkl-parser.js';
import { buildLaueGroups, sgLaueClass } from './laue.js';
import { analyzeSpaceGroup, crystalSystemFromCell, scoreSpaceGroup, isCentrosymmetric, laueClassOfSg } from './analyze.js';
import { mergeReflections, computeMergeStatistics, writeShelxHkl, writeXdsAscii, buildMergingReport, dSpacing } from './merge.js';
import { parseOperation } from './op-math.js';

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

// Generate a SHELX instruction (.ins) file for structure-solution programs
// (SHELXT / SHELXD / SHELXS) using the determined/forced space group and the
// unit cell. `options.sfac` (element symbols) and `options.unit` (counts per
// element) can override the generic scattering-factor list.
export function writeShelxIns(usedSG, cell, options = {}) {
    const wl = options.wavelength || 0.71073;
    const title = (options.title || 'xrdspace').replace(/\s+/g, ' ');
    const out = [];
    out.push(`TITL ${title}`);
    out.push(`CELL ${wl.toFixed(5)} ${cell.a} ${cell.b} ${cell.c} ${cell.alpha} ${cell.beta} ${cell.gamma}`);
    out.push('ZERR 1 0.001 0.001 0.001 0.001 0.001 0.001');
    const lattNum = { P: 1, A: 2, B: 3, C: 4, I: 5, F: 6, R: 7 }[centeringOf(usedSG)] || 1;
    const centrosymmetric = isCentrosymmetric(usedSG);
    const sign = centrosymmetric ? -1 : 1;
    out.push(`LATT ${sign * lattNum}`);
    // Generating symmetry operations in SHELX convention (fraction first).
    // For centrosymmetric space groups (LATT < 0) SHELX generates the
    // inversion partners, so only one op from each inversion pair is written.
    for (const op of shelxSymmOps(usedSG.s, centrosymmetric)) {
        out.push(`SYMM ${op}`);
    }
    const defaultSfac = ['C', 'H', 'N', 'O', 'F', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'K', 'Ca', 'Fe', 'Ni', 'Cu', 'Zn', 'Br', 'I'];
    const sfac = options.sfac && options.sfac.length ? options.sfac : defaultSfac;
    let unit = options.unit && options.unit.length === sfac.length ? options.unit : null;
    if (!unit) {
        unit = [];
        for (let i = 0; i < sfac.length; i++) unit.push(20);
    }
    out.push('SFAC ' + sfac.join(' '));
    out.push('UNIT ' + unit.join(' '));
    out.push('HKLF 4');
    out.push('TREF 50');
    out.push('END');
    return out.join('\n') + '\n';
}

// Format a fraction for SHELX (e.g. 1/2, 1/4, -1/2).
function fmtFrac(v) {
    const denoms = [1, 2, 3, 4, 6, 8, 12];
    for (const d of denoms) {
        const n = Math.round(v * d);
        if (Math.abs(n - v * d) < 1e-9) {
            return `${n}/${d}`;
        }
    }
    return String(v);
}

// Format a symmetry component like "-x, 1/2+y, 1/2-z" (SHELX convention).
function fmtComponent(cx, cy, cz, t) {
    const out = [];
    if (Math.abs(t) > 1e-9) {
        out.push((t < 0 ? '-' : '') + fmtFrac(Math.abs(t)));
    }
    const vars = [['X', cx], ['Y', cy], ['Z', cz]];
    for (const [name, coeff] of vars) {
        if (Math.abs(coeff) < 1e-9) continue;
        const sign = coeff < 0 ? '-' : (out.length ? '+' : '');
        const mag = Math.abs(coeff);
        out.push(sign + (Math.abs(mag - 1) < 1e-9 ? name : fmtFrac(mag) + name));
    }
    return out.join('') || '0';
}

function matIs(m, ref) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if (Math.abs(m[i][j] - ref[i][j]) > 1e-9) return false;
    }
    return true;
}

function vecIs(t, v) {
    return t.every(x => Math.abs(x - v) < 1e-9);
}

function matKey(m) {
    let out = '';
    for (let i = 0; i < m.length; i++) {
        if (i) out += '|';
        for (let j = 0; j < m[i].length; j++) {
            if (j) out += ',';
            out += m[i][j];
        }
    }
    return out;
}

function negVec(t) {
    const out = [];
    for (let i = 0; i < t.length; i++) out.push(-t[i]);
    return out;
}

// Serialize a vector of values rounded to 6 decimals (for set membership keys).
function vecKey(t) {
    let out = '';
    for (let i = 0; i < t.length; i++) {
        if (i) out += ',';
        out += Math.round(t[i] * 1e6) / 1e6;
    }
    return out;
}

// Reduce the full list of general positions to the generating operations
// expected in a SHELX .ins (identity omitted; for centrosymmetric groups only
// one op per inversion pair).
function shelxSymmOps(ops, centrosymmetric) {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const mI = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    const out = [];
    const seen = new Set();
    for (const opStr of ops) {
        const p = parseOperation(opStr);
        if (!p) continue;
        if (matIs(p.R, I) && vecIs(p.t, 0)) continue;           // identity
        if (centrosymmetric && matIs(p.R, mI) && vecIs(p.t, 0)) continue; // pure inversion
        if (centrosymmetric) {
            // Inversion partner matrix: -R, and -t.
            const negR = [[-p.R[0][0], -p.R[0][1], -p.R[0][2]], [-p.R[1][0], -p.R[1][1], -p.R[1][2]], [-p.R[2][0], -p.R[2][1], -p.R[2][2]]];
            const partner = matKey(negR) + '|' + vecKey(negVec(p.t));
            if (seen.has(partner)) continue;
            seen.add(matKey(p.R) + '|' + vecKey(p.t));
        }
        const parts = [];
        for (let i = 0; i < 3; i++) {
            parts.push(fmtComponent(p.R[i][0], p.R[i][1], p.R[i][2], p.t[i]));
        }
        out.push(parts.join(', '));
    }
    return out;
}

/**
 * Run the full xrdspace analysis on HKL file text.
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
        const filtered = [];
        const dmin = options.resolution.dmin, dmax = options.resolution.dmax;
        for (const r of reflections) {
            const d = dSpacing(r.h, r.k, r.l, cell);
            if (Number.isFinite(d) && d >= dmin - 1e-6 && d <= dmax + 1e-6) filtered.push(r);
        }
        reflections = filtered;
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
        const fl = laueClassOfSg(forcedSG, laueGroups);
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
            merge.shelxIns = writeShelxIns(fullSG, cell, {
                wavelength: parsed.wavelength,
                title: parsed.title || fullSG.hm,
                sfac: options.sfac,
                unit: options.unit,
            });
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
