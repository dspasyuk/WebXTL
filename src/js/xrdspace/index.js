// Copyright (c) 2026 Denis Spasyuk. MIT License.
// xrdspace — a JavaScript XPREP-style space-group determination tool.
//
// Main entry point: loads the space-group dictionary, parses HKL files
// (XDS_ASCII, SHELX five-column, COD, Bruker P4P, MTZ), and runs the full
// space-group analysis.
// Works both as a Node module (for the WebXTL server/UI) and from the CLI
// (see xrdspace.js).

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHkl } from './hkl-parser.js';
import { parseMtz, writeMtz, getReflections } from './mtz.js';
import { buildLaueGroups, sgLaueClass } from './laue.js';
import { analyzeSpaceGroup, crystalSystemFromCell, scoreSpaceGroup, isCentrosymmetric, laueClassOfSg, isSohncke, cellVolume } from './analyze.js';
import { mergeReflections, computeMergeStatistics, resolutionShellStats, artifactReport, writeShelxHkl, writeShelxHklUnmerged, writeXdsAscii, writeXdsAsciiUnmerged, buildMergingReport, dSpacing } from './merge.js';
import { parseOperation, LATT_CENTERING, shelxSymmGenerators } from './op-math.js';
import { analyzeBeamDamage } from './raddose.js';

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

// Centering letter (P/A/B/C/I/F/R) from a space group entry. The Hall symbol's
// lattice letter is authoritative for non-standard settings (e.g. the
// primitive-rhombohedral "P 3*" setting of R 3, which is P, not R).
export function centeringOf(sg) {
    const fromHs = ((sg.hs || '').replace(/^-\s*/, '')[0] || '').toUpperCase();
    if (fromHs && 'PABCIFR'.includes(fromHs)) return fromHs;
    return ((sg.hm || 'P')[0] || 'P').toUpperCase();
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
    const centering = centeringOf(usedSG);
    const lattType = LATT_CENTERING[centering] || 1;
    const centrosymmetric = isCentrosymmetric(usedSG);
    // SHELX: negative LATT means NON-centrosymmetric. Centrosymmetric groups use
    // a positive LATT and SHELX generates the inversion partners itself.
    const sign = centrosymmetric ? 1 : -1;
    out.push(`LATT ${sign * lattType}`);
    // Generating symmetry operations in SHELX convention (fraction first).
    // Lattice centering is carried by LATT, so SYMM lists only one op per
    // centering coset; for centrosymmetric groups only one op per inversion pair.
    for (const op of shelxSymmOps(usedSG.s, centrosymmetric, lattType)) {
        out.push(`SYMM ${op}`);
    }
    // SHELXD/SHELXS only accept up to 13 scattering-factor types (a longer
    // SFAC line makes them abort with "** WRONG NUMBER OF PARAMETERS **"), so
    // the default list must stay at or below that. Users with other elements
    // should pass their expected formula via `options.sfac`/`options.unit`.
    const defaultSfac = ['C', 'H', 'N', 'O', 'F', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'K'];
    const sfac = options.sfac && options.sfac.length ? options.sfac.slice(0, 13) : defaultSfac;
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

// Reduce the full list of general positions to the generating operations
// expected in a SHELX .ins (identity omitted; for centrosymmetric groups only
// one op per inversion pair; for centered lattices one op per centering coset).
function shelxSymmOps(ops, centrosymmetric, lattType = 1) {
    const parsed = ops.map(parseOperation).filter(Boolean);
    const gens = shelxSymmGenerators(parsed, { centrosymmetric, latt: lattType });
    return gens.map(p => {
        const parts = [];
        for (let i = 0; i < 3; i++) {
            parts.push(fmtComponent(p.R[i][0], p.R[i][1], p.R[i][2], p.t[i]));
        }
        return parts.join(', ');
    });
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
 *   chiral: boolean,                       // restrict candidates to the 65 chiral
 *                                          // (Sohncke) space groups. Default: true
 *                                          // for macromolecular cells (volume >
 *                                          // 64000 A^3, ~40x40x40), false otherwise.
 *   quality: boolean,                      // per-shell table + artifact flags
 *   rad: boolean,                          // RADDOSE-style beam-damage analysis
 *                                          // (needs unmerged XDS_ASCII with PSI,
 *                                          //  or Bruker P4P whose omega is PSI)
 *   radMinIsig: number,                    // I/sigma threshold for the fit (2)
 *   radEarlyFrac: number,                  // fraction of rotation = "early" (0.25)
 *   radLateFrac: number,                   // fraction of rotation = "late"  (0.25)
 *   radShells: number,                     // number of resolution shells (10)
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
    return analyzeParsed(parsed, options);
}

// Core space-group analysis over a normalized parsed-HKL object
// ({ format, title, cell, reflections, wavelength, merge, friedelsLaw }).
// Shared by the text-based (analyzeHkl) and MTZ-based (analyzeMtz) entry points.
export function analyzeParsed(parsed, options = {}) {
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

    // Observations that data reduction rejected (XDS marks them with a negative
    // sigma) are outliers (overloaded, bad-profile, etc.). They must not enter
    // the merge, the merging statistics, or the space-group analysis: keeping
    // them inflates R(merge) (13% -> 148% on the MDCoH set) and degrades the
    // solution. They are retained only in the unmerged XDS_ASCII output, where
    // their negative sigma is preserved so downstream programs (e.g. Phenix)
    // can see and handle the flag. This matches XPREP and Pointless, which both
    // drop the rejected observations from the analysis.
    const allReflections = reflections;
    reflections = reflections.filter(r => !r.rejected);
    if (!reflections.length) {
        return { ok: false, error: 'No reflections parsed from the HKL file.' };
    }

    const laueGroups = getLaueGroups();
    const sgData = loadSpaceGroups();
    const metric = crystalSystemFromCell(cell);
    const result = analyzeSpaceGroup(sgData, reflections, cell, { laueGroups, chiral: options.chiral });

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
        const usedCentering = forcedSG ? centeringOf(forcedSG) : result.centering;
        const m = mergeReflections(reflections, usedLaueOps, cell);
        const stats = computeMergeStatistics(reflections, usedLaueOps, cell, { centering: usedCentering, quality: options.quality });
        const sgInfo = {
            hm: usedSG ? usedSG.hm : '?',
            id: usedSG ? usedSG.id : 0,
            laue: usedLaueName,
            centering: usedCentering,
        };
        merge = {
            nUnique: m.nUnique,
            nObs: m.nObs,
            // All observations (including rejected ones, whose negative sigma
            // is preserved), kept unmerged and labelled as such for programs
            // (e.g. Phenix) that prefer the redundant measurements.
            unmergedXdsAscii: writeXdsAsciiUnmerged(allReflections, {
                outputFile: options.unmergedOutput || 'structure_unmerged.hkl',
                cell,
                spaceGroupNumber: usedSG ? usedSG.id : undefined,
                spaceGroupName: usedSG ? usedSG.hm : undefined,
                wavelength: parsed.wavelength,
                dmin: stats.dmin,
                dmax: stats.dmax,
                friedelsLaw: parsed.friedelsLaw,
            }),
            inputWasMerged: parsed.merge,
            // Default SHELX output: UNMERGED. SHELXL (HKLF 4) does its own
            // symmetry averaging and scaling, so it must receive the raw
            // observations; a pre-merged file would double-merge the data.
            shelxHkl: writeShelxHklUnmerged(reflections),
            // Merged SHELX five-column text, kept for programs that expect a
            // pre-merged dataset (e.g. SHELXD/SHELXT in some workflows).
            shelxHklMerged: writeShelxHkl(m.merged),
            xdsAscii: writeXdsAscii(m.merged, {
                outputFile: options.xdsOutput || 'structure_xds.hkl',
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
        // Diagnostic quality tables for the report (per-resolution shells and
        // artifact/twinning flags). Computed on request because they add a few
        // full passes over the reflections.
        if (options.quality) {
            merge.shells = resolutionShellStats(reflections, usedLaueOps, cell, { centering: usedCentering });
            merge.artifacts = artifactReport(reflections, usedLaueOps, cell);
        }
        // RADDOSE-style beam-damage analysis: per-observation rotation angle
        // (PSI) is the dose coordinate. Needs unmerged XDS_ASCII input (or P4P,
        // whose omega is used as PSI); on other input it reports why it is not
        // usable.
        if (options.rad) {
            merge.beamDamage = analyzeBeamDamage(reflections, cell, parsed.geometry, {
                minIsig: options.radMinIsig,
                earlyFrac: options.radEarlyFrac,
                lateFrac: options.radLateFrac,
                shells: options.radShells,
            });
        }
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
        chiral: result.chiral,
        forced: !!forcedSG,
        bestSpaceGroup: usedSG ? usedSG.hm : null,
        bestSpaceGroupNumber: usedSG ? usedSG.id : null,
        merged: merge ? {
            nUnique: merge.nUnique,
            nObs: merge.nObs,
            completeness: merge.statistics.completeness,
            dIsig1: merge.statistics.dIsig1,
            completenessIsig1: merge.statistics.completenessIsig1,
            dCC30: merge.statistics.dCC30,
            completenessCC30: merge.statistics.completenessCC30,
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

/**
 * Read an MTZ reflection file (Buffer/ArrayBuffer/Uint8Array) and run the full
 * xrdspace space-group analysis on it.
 * options: same as analyzeHkl, plus:
 *   intensity: string,  // MTZ column for I (default IMEAN, else F)
 *   sigma: string,      // MTZ column for sigma(I) (default SIGIMEAN, else SIGF)
 */
export function analyzeMtz(buffer, options = {}) {
    let mtz;
    try {
        mtz = parseMtz(buffer);
    } catch (e) {
        return { ok: false, error: e.message };
    }
    let reflections;
    try {
        reflections = getReflections(mtz, options);
    } catch (e) {
        return { ok: false, error: e.message };
    }
    // Resolve wavelength from the dataset records (prefer a non-zero one).
    const datasets = mtz.datasets || [];
    const wls = datasets.map(d => d.wavelength).filter(w => Number.isFinite(w) && w > 0);
    const wavelength = wls.length ? wls[wls.length - 1] : null;
    const parsed = {
        format: 'mtz',
        title: mtz.title || '',
        cell: mtz.cell,
        reflections,
        wavelength,
        merge: true,
        friedelsLaw: null,
        spaceGroupNumber: mtz.spaceGroupNumber,
        spaceGroupName: mtz.spaceGroupName,
    };
    const result = analyzeParsed(parsed, options);
    if (result.ok) {
        result.mtz = {
            ncols: mtz.ncols,
            nreflections: mtz.nreflections,
            columns: mtz.columns.map(c => c.label + ':' + c.type),
            spaceGroupNumber: mtz.spaceGroupNumber,
            spaceGroupName: mtz.spaceGroupName,
            byteOrder: mtz.byteOrder,
        };
    }
    return result;
}

// Read an MTZ file into a structured object (no analysis).
export function readMtz(buffer, options = {}) {
    return parseMtz(buffer, options);
}

// Re-serialize a parsed MTZ object to file bytes.
export function writeMtzFile(mtz) {
    return writeMtz(mtz);
}

// Convenience: return a compact one-line verdict string.
export function verdict(result) {
    if (!result || !result.ok) return 'n/a';
    const b = result.best;
    return b ? `${b.hm} (No. ${b.id})` : 'indeterminate';
}

export { isSohncke, cellVolume };

// Unit-cell database search (COD + PDB).
export {
    niggliReduce,
    cellSettings,
    transformCell,
    cellSimilarity,
    cellToleranceWindows,
    searchCodByCell,
    searchPdbByCell,
    searchByCell,
} from './cell-search.js';

// Offline PDB space-group validation (data/pdb-cells.json).
export {
    buildPdbLookupTable,
    loadPdbLookup,
    searchPdbLookup,
    validateSpaceGroupAgainstPdb,
} from './pdb-lookup.js';

// RADDOSE-style beam-damage analysis (--rad).
export { analyzeBeamDamage, kPer100 } from './raddose.js';
