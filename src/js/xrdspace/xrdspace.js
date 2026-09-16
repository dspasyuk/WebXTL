#!/usr/bin/env node
// Copyright (c) 2026 Denis Spasyuk. MIT License.
// xrdspace command-line interface — POINTLESS-style arguments.
//
// Usage:
//   node src/xrdspace.js --hklin <file.hkl> [options]
//   node src/xrdspace.js hklin <file.hkl> hklout <file.hkl> spacegroup C2 ...
//
// If the HKL file does not carry unit-cell parameters, xrdspace prompts for
// them interactively. Pass --cell "a b c alpha beta gamma" to skip the prompt.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { analyzeHkl, cellVolume } from './index.js';
import { parseHkl } from './hkl-parser.js';
import { searchByCell } from './cell-search.js';
import { loadPdbLookup, validateSpaceGroupAgainstPdb } from './pdb-lookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = '1.0.0';

const HELP = `
xrdspace — space-group determination and reflection merging (POINTLESS-style CLI)

Usage:
  node src/xrdspace.js --hklin <file.hkl> [options]
  node src/xrdspace.js --codsearch|--pdbsearch|--search --cell "a b c alpha beta gamma" [options]

Input / output:
  --hklin <file>      Input HKL file (XDS_ASCII or SHELX five-column format)
  --hklout <file>     Output merged HKL file, SHELX format (default: <input>_merged.hkl)
  --xdsout <file>     Output merged HKL file, XDS_ASCII format (default: <input>_xds.hkl)
  --unmergedout <file>  Output UNMERGED HKL file, XDS_ASCII format (MERGE=FALSE),
                        keeping all observations (default: <input>_unmerged.hkl)
  --log <file>        Write the formatted report to <file>
                      (default: xrdspace.log next to the input file)

Unit-cell database search (no HKL file needed):
  --search            Search BOTH the Crystallography Open Database (COD) and the
                      RCSB Protein Data Bank (PDB) for structures with a unit cell
                      matching the given --cell. Needs --cell "a b c alpha beta gamma".
  --codsearch         Search only the COD.
  --pdbsearch         Search only the PDB.
  --tol <pct>         Relative length tolerance in % for the cell match (default 1.0).
                      Real crystals vary by fractions of an Angstrom, so a few % is
                      usually appropriate. PDB does not store esds on the cell, so a
                      slightly wider tolerance helps there.
  --tol-angle <deg>   Angle tolerance in degrees (default 1.5).
  --limit <n>         Maximum number of matches to report (default 20).

Space group:
  --spacegroup <sg>   Force a specific space group (number or Hermann-Mauguin
                      symbol, e.g. 14, "P 21/c", "P-1")
  --laue <group>      Force a Laue class for merging (e.g. -1, 2/m, mmm, 4/mmm)

Data:
  --cell "a b c alpha beta gamma"   Unit cell (used when the file has none)
  --resolution "lo hi"              Restrict analysis to a resolution range (A)
  --sigthreshold <n>                I/sigma threshold for systematic absences (default 5)
  --sfac "C H N O"                  Expected elements (or formula, e.g. "C12 H16 N2 O4")
                                    used for the SHELXT .ins SFAC/UNIT lines

Space-group selection:
  --chiral                          Restrict candidates to the 65 chiral (Sohncke)
                                    space groups. This is the DEFAULT for
                                    macromolecular cells (volume > 64000 A^3,
                                    about 40x40x40 A); use --no-chiral to allow
                                    non-chiral groups anyway.
  --no-chiral                       Allow non-chiral (centrosymmetric / mirror)
                                    space groups even for large cells.

PDB space-group validation:
  --valid                           Validate the determined space group against an
                                    offline PDB unit-cell / space-group lookup
                                    table. No network access at validation time:
                                    reports VERIFIED / MISMATCH / AMBIGUOUS
                                    (enantiomorph) / INDETERMINATE, with the space
                                    groups the PDB assigns to cells matching
                                    --cell. Uses --tol / --tol-angle for the match.
  --pdb-table <file>                Path to the PDB lookup table (default:
                                    data/pdb-cells.json). Build it once with:
                                      node scripts/build-pdb-table.js

Misc:
  --help, -h          Show this help
  --version, -v       Show version

Bare POINTLESS-style keywords (hklin, hklout, spacegroup, cell, ...) are also
accepted. Without --hklout/--xdsout/--unmergedout the output files are written
next to the input file.
`;

const REPORT_WIDTH = 78;

function fmtFixed(v, d, width) {
    return (Number.isFinite(v) ? v.toFixed(d) : '?').padStart(width);
}

function reportSection(title) {
    const bar = '-'.repeat(REPORT_WIDTH);
    return [bar, `  ${title}`, bar];
}

function reportKv(label, value) {
    return `  ${String(label).padEnd(20)}: ${value}`;
}

// Fixed-width table of per-resolution-shell statistics.
function fmtShellTable(shells) {
    const cols = [
        ['d range (A)', 13, 'l'], ['#obs', 7, 'r'], ['#uniq', 7, 'r'],
        ['Compl', 7, 'r'], ['Mult', 6, 'r'], ['Rmerge', 8, 'r'], ['Rmeas', 8, 'r'],
        ['Rpim', 7, 'r'], ['<I/σ>', 7, 'r'], ['CC(1/2)', 8, 'r'], ['%neg', 6, 'r'],
    ];
    const cell = (v, w, a) => (a === 'l' ? String(v).padEnd(w) : String(v).padStart(w));
    const pct = (v) => (v == null ? '-' : (v * 100).toFixed(1) + '%');
    const out = ['  ' + cols.map(c => cell(c[0], c[1], c[2])).join(' ')];
    for (const s of shells) {
        const vals = [
            `${s.dHi.toFixed(2)}-${s.dLo.toFixed(2)}`,
            String(s.nObs), String(s.nUnique), pct(s.completeness),
            s.multiplicity.toFixed(1), pct(s.rMerge), pct(s.rMeas), pct(s.rPim),
            s.meanIsig.toFixed(1), s.ccHalf == null ? '-' : s.ccHalf.toFixed(3),
            (s.negFrac * 100).toFixed(0) + '%',
        ];
        out.push('  ' + vals.map((v, i) => cell(v, cols[i][1], cols[i][2])).join(' '));
    }
    return out;
}

// Artifact / quality-flag block (outliers, ice rings, anisotropy).
function fmtArtifacts(a) {
    const L = [];
    const o = a.outliers;
    L.push(reportKv('Outliers |ΔI|/σ>10', `${o.count} / ${o.checked} (${(o.frac * 100).toFixed(2)}%)`));
    if (o.top && o.top.length) {
        L.push('     h    k    l      d(A)         I    sigma   |ΔI|/σ     n');
        for (const x of o.top) {
            L.push('   ' + String(x.h).padStart(4) + String(x.k).padStart(5) + String(x.l).padStart(5)
                + x.d.toFixed(2).padStart(9) + x.I.toFixed(2).padStart(11) + x.sig.toFixed(2).padStart(9)
                + x.dev.toFixed(1).padStart(8) + String(x.n).padStart(6));
        }
    }
    L.push('');
    L.push('  Ice-ring scan (mean |I| in a 0.05 A band vs local background):');
    if (!a.iceRings.some(r => r.flagged)) L.push('    none detected');
    for (const r of a.iceRings) {
        L.push(`    ${r.d.toFixed(2)} A   n=${String(r.n).padStart(6)}   ratio ${r.ratio.toFixed(2)}${r.flagged ? '   <-- possible ice ring' : ''}`);
    }
    L.push('');
    L.push('  Anisotropy (resolution at I/σ=2 by reciprocal axis):');
    for (const ax of a.anisotropy) {
        L.push(`    ${ax.axis.padEnd(3)}  ${ax.d != null ? ax.d.toFixed(2) + ' A' : '  -   '}   (n=${ax.n})`);
    }
    if (a.anisoRatio != null) {
        L.push(`    max/min = ${a.anisoRatio.toFixed(2)}${a.anisotropic ? '   <-- anisotropic' : '   (isotropic)'}`);
    }
    return L;
}

// Build the consolidated, formatted analysis report. `opts` may provide:
//   inputPath      - path of the input HKL file
//   outputFiles    - [{ path, note }] files written by this run
//   validationText - pre-formatted PDB validation block (--valid)
//   notes          - extra single-line notes
export function buildReport(result, opts = {}) {
    const s = result.summary;
    const L = [];
    const bar = '='.repeat(REPORT_WIDTH);
    L.push(bar);
    L.push('  xrdspace  —  space-group determination and reflection merging');
    L.push(bar);
    L.push('');
    if (opts.inputPath) L.push(reportKv('Input file', opts.inputPath));
    L.push(reportKv('Format', s.format));
    if (s.title) L.push(reportKv('Title', s.title));
    if (s.wavelength) L.push(reportKv('Wavelength', `${s.wavelength} A`));
    L.push(reportKv('Reflections', String(s.nReflections)));
    L.push('');

    L.push(...reportSection('UNIT CELL'));
    L.push('           a         b         c     alpha      beta     gamma');
    L.push('  ' + [
        fmtFixed(result.cell.a, 3, 9),
        fmtFixed(result.cell.b, 3, 9),
        fmtFixed(result.cell.c, 3, 9),
        fmtFixed(result.cell.alpha, 3, 9),
        fmtFixed(result.cell.beta, 3, 9),
        fmtFixed(result.cell.gamma, 3, 9),
    ].join(' '));
    L.push(reportKv('Volume', `${Math.round(cellVolume(result.cell))} A^3`));
    L.push(reportKv('Crystal system', `${s.crystalSystem}${s.uniqueAxis ? ' (unique ' + s.uniqueAxis + ')' : ''}`));
    L.push(reportKv('Lattice centering', s.centering));
    L.push('');

    L.push(...reportSection('SPACE-GROUP DETERMINATION'));
    if (result.best) {
        L.push(reportKv('Best space group', `${result.best.hm}  (No. ${result.best.id})${s.forced ? '  [forced]' : ''}`));
        if (s.forced && result.determined && result.determined.id !== result.best.id) {
            L.push(reportKv('Determined', `${result.determined.hm}  (No. ${result.determined.id})`));
        }
    } else {
        L.push(reportKv('Best space group', 'indeterminate'));
    }
    L.push(reportKv('Laue class', `${s.laueClass}   R(sym) = ${(s.laueRSym * 100).toFixed(2)} %`));
    L.push(reportKv('Centrosymmetric', `${s.centricity}   (<|E^2-1|> = ${s.centricityScore.toFixed(3)})`));
    if (s.chiral) L.push(reportKv('Chiral restriction', 'on (Sohncke space groups only)'));
    if (result.merge && result.merge.consistency) {
        const c = result.merge.consistency;
        L.push(reportKv('Data consistency', c.violations === 0 ? 'consistent with data' : `INCONSISTENT (${c.violations} violation(s))`));
    }
    L.push('');
    L.push('  R(sym) by Laue class:');
    for (const row of result.laueTable) {
        const mark = row.chosen ? '  <-- chosen' : '';
        L.push(`    ${row.name.padEnd(7)} order ${String(row.order).padStart(2)}   R(sym) = ${(row.rsym * 100).toFixed(2).padStart(6)} %${mark}`);
    }
    L.push('');
    L.push('  Space-group candidates (systematic absences):');
    if (!result.candidates.length) {
        L.push('    (none)');
    } else {
        L.push('    No.  HM                          violations');
        for (const c of result.candidates.slice(0, 12)) {
            const mark = result.best && c.id === result.best.id ? '  <-- best' : '';
            L.push(`    ${String(c.id).padStart(3)}  ${c.hm.padEnd(28)} ${String(c.violations).padStart(4)}${mark}`);
        }
    }
    L.push('');

    if (result.merge) {
        const st = result.merge.statistics;
        L.push(...reportSection('MERGING STATISTICS'));
        L.push(reportKv('Resolution range', `${st.dmax.toFixed(2)} - ${st.dmin.toFixed(2)} A`));
        if (st.dIsig1 != null) {
            L.push(reportKv('Resolution (I/σ=1)', `${st.dIsig1.toFixed(2)} A`));
        }
        if (st.dCC30 != null) {
            L.push(reportKv('Resolution (CC1/2)', `${st.dCC30.toFixed(2)} A   (CC1/2 = 0.30)`));
        }
        L.push(reportKv('Observations', String(st.nObs)));
        L.push(reportKv('Unique reflections', String(st.nUnique)));
        L.push(reportKv('Mean multiplicity', st.meanMultiplicity.toFixed(1)));
        L.push(reportKv('Completeness', `${(st.completeness * 100).toFixed(1)} %`));
        if (st.completenessIsig1 != null) {
            L.push(reportKv('Completeness (I/σ=1)', `${(st.completenessIsig1 * 100).toFixed(1)} %`));
        }
        if (st.completenessCC30 != null) {
            L.push(reportKv('Completeness (CC1/2)', `${(st.completenessCC30 * 100).toFixed(1)} %`));
        }
        L.push(reportKv('R(merge)', `${(st.rMerge * 100).toFixed(2)} %`));
        L.push(reportKv('R(meas)', `${(st.rMeas * 100).toFixed(2)} %`));
        L.push(reportKv('R(pim)', `${(st.rPim * 100).toFixed(2)} %`));
        L.push(reportKv('Mean I/sigma(I)', `${st.meanIsig.toFixed(1)}${st.dCC30 != null ? '   (to CC1/2 = 0.30)' : ''}`));
        L.push('');
    }

    if (result.merge && result.merge.shells && result.merge.shells.length) {
        L.push(...reportSection('RESOLUTION SHELLS'));
        L.push(...fmtShellTable(result.merge.shells));
        L.push('');
    }

    if (result.merge && result.merge.artifacts) {
        L.push(...reportSection('QUALITY FLAGS / ARTIFACTS'));
        L.push(...fmtArtifacts(result.merge.artifacts));
        L.push('');
    }

    if (opts.validationText) {
        L.push(...reportSection('PDB SPACE-GROUP VALIDATION'));
        L.push(opts.validationText);
        L.push('');
    }

    if (opts.outputFiles && opts.outputFiles.length) {
        L.push(...reportSection('OUTPUT FILES'));
        for (const f of opts.outputFiles) {
            L.push(`  ${f.path}${f.note ? '  ' + f.note : ''}`);
        }
        if (opts.notes) for (const n of opts.notes) L.push(`  note: ${n}`);
        L.push('');
    }

    L.push(bar);
    return L.join('\n') + '\n';
}

// Print an analysis failure and stop. Kept separate from the report so the
// NO_CELL hint is shown before the process exits.
function abortAnalysis(result) {
    console.error(`xrdspace: ${result.error}`);
    if (result.error === 'NO_CELL') {
        console.error('  The HKL file does not contain unit-cell parameters.');
        console.error('  Run again with --cell "a b c alpha beta gamma" or provide them at the prompt.');
    }
    process.exit(1);
}

async function promptCell() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(res => rl.question(q, res));
    const a = await ask('Unit cell a b c alpha beta gamma (e.g. 10.5 10.5 14.0 90 90 90): ');
    rl.close();
    return parseCellInput(a);
}

// Number of values consumed by each bare keyword / option.
    const N_VALUES = {
        hklin: 1, hklout: 1, xdsout: 1, unmergedout: 1, spacegroup: 1, sg: 1, laue: 1, sigthreshold: 1,
        sfac: 1, formula: 1, log: 1, tol: 1, 'tol-angle': 1, limit: 1, 'pdb-table': 1,
        cell: 6, resolution: 2,
        chiral: 0, 'no-chiral': 0, nochiral: 0, valid: 0,
        search: 0, codsearch: 0, pdbsearch: 0,
    };

// Split a string on whitespace with a single pass.
function splitWs(s) {
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 32 || c === 9) {
            if (cur) { out.push(cur); cur = ''; }
        } else cur += s[i];
    }
    if (cur) out.push(cur);
    return out;
}

function parseCellInput(s) {
    const toks = splitWs(String(s));
    if (toks.length !== 6) throw new Error('cell expects six numbers: a b c alpha beta gamma');
    const v = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) {
        v[i] = parseFloat(toks[i]);
        if (!Number.isFinite(v[i])) throw new Error('cell expects six numbers: a b c alpha beta gamma');
    }
    return { a: v[0], b: v[1], c: v[2], alpha: v[3], beta: v[4], gamma: v[5] };
}

// Parse an element/formula input like "C H N O" or "C12 H16 N2 O4" into
// { sfac: [symbols], unit: [counts] }.
function parseSfacInput(input) {
    const elements = [];
    const counts = [];
    const order = [];
    const map = new Map();
    const re = /([A-Z][a-z]?)(\d*)/g;
    let m;
    while ((m = re.exec(input)) !== null) {
        const el = m[1];
        const count = m[2] ? parseInt(m[2], 10) : 0;
        if (!map.has(el)) { map.set(el, 0); order.push(el); }
        map.set(el, map.get(el) + count);
    }
    if (!order.length) throw new Error(`Could not parse elements from: ${input}`);
    for (const el of order) {
        elements.push(el);
        counts.push(map.get(el) || 20);
    }
    return { sfac: elements, unit: counts };
}

function parseArgs(argv) {
    const args = { hklin: null, hklout: null, xdsout: null, unmergedOut: null, cell: null, spaceGroup: null, laue: null, resolution: null, sigThreshold: 5, sfac: null, log: null, chiral: null, help: false, version: false, search: null, codsearch: false, pdbsearch: false, tol: 1.0, tolAngle: 1.5, limit: 20, valid: false, pdbTable: null };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { args.help = true; i++; continue; }
        if (a === '--version' || a === '-v') { args.version = true; i++; continue; }

        // --flag value / bare keyword
        let key = null;
        let n = null;
        if (a.startsWith('--')) {
            key = a.slice(2).toLowerCase();
            if (key === 'space-group') key = 'spacegroup';
            if (key === 'sg') key = 'spacegroup';
            if (key === 'tolerance' || key === 'tol') key = 'tol';
            if (key === 'tolerance-angle' || key === 'tolangle' || key === 'tolang') key = 'tol-angle';
            n = N_VALUES[key] !== undefined ? N_VALUES[key] : 1;
        } else if (a === 'hklin' || a === 'hklout' || a === 'xdsout' || a === 'unmergedout' || a === 'spacegroup' || a === 'laue'
            || a === 'cell' || a === 'resolution' || a === 'sigthreshold' || a === 'sfac' || a === 'formula' || a === 'log'
            || a === 'chiral' || a === 'no-chiral' || a === 'nochiral'
            || a === 'search' || a === 'codsearch' || a === 'pdbsearch' || a === 'tol' || a === 'tol-angle' || a === 'limit'
            || a === 'valid' || a === 'pdb-table') {
            key = a;
            n = N_VALUES[a];
        } else if (!a.startsWith('-')) {
            // Positional argument: treated as hklin.
            args.hklin = a;
            i++;
            continue;
        } else {
            throw new Error(`Unknown option: ${a}`);
        }

        const vals = [];
        if (n === 1) {
            if (i + 1 >= argv.length) {
                throw new Error(`${a} expects ${n} value(s)`);
            }
            vals.push(argv[++i]);
        } else {
            // Multi-value options accept both "--cell 20 21 22 90 90 90" and a
            // single quoted string "--cell \"20 21 22 90 90 90\"".
            while (vals.length < n && i + 1 < argv.length) {
                const next = argv[++i];
                const parts = splitWs(next);
                for (const p of parts) {
                    vals.push(p);
                    if (vals.length >= n) break;
                }
            }
            if (vals.length < n) {
                throw new Error(`${a} expects ${n} value(s)`);
            }
        }

        if (key === 'hklin') args.hklin = vals[0];
        else if (key === 'hklout') args.hklout = vals[0];
        else if (key === 'xdsout') args.xdsout = vals[0];
        else if (key === 'unmergedout') args.unmergedOut = vals[0];
        else if (key === 'log') args.log = vals[0];
        else if (key === 'valid') args.valid = true;
        else if (key === 'pdb-table') args.pdbTable = vals[0];
        else if (key === 'chiral') args.chiral = true;
        else if (key === 'no-chiral' || key === 'nochiral') args.chiral = false;
        else if (key === 'search') args.search = true;
        else if (key === 'codsearch') args.codsearch = true;
        else if (key === 'pdbsearch') args.pdbsearch = true;
        else if (key === 'tol') {
            const t = parseFloat(vals[0]);
            if (!Number.isFinite(t) || t <= 0) throw new Error('tol expects a positive number (% length tolerance)');
            args.tol = t;
        } else if (key === 'tol-angle') {
            const t = parseFloat(vals[0]);
            if (!Number.isFinite(t) || t <= 0) throw new Error('tol-angle expects a positive number (degrees)');
            args.tolAngle = t;
        } else if (key === 'limit') {
            const n = parseInt(vals[0], 10);
            if (!Number.isFinite(n) || n <= 0) throw new Error('limit expects a positive integer');
            args.limit = n;
        } else if (key === 'spacegroup') args.spaceGroup = vals[0];
        else if (key === 'laue') args.laue = vals[0];
        else if (key === 'sigthreshold') {
            const t = parseFloat(vals[0]);
            if (!Number.isFinite(t)) throw new Error('sigthreshold expects a number');
            args.sigThreshold = t;
        } else if (key === 'sfac' || key === 'formula') {
            args.sfac = vals[0];
        } else if (key === 'cell') {
            args.cell = parseCellInput(vals.join(' '));
        } else if (key === 'resolution') {
            const lo = parseFloat(vals[0]), hi = parseFloat(vals[1]);
            if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0 || lo === hi) {
                throw new Error('resolution expects two positive numbers: low high (A)');
            }
            // "low" = low resolution (large d), "high" = high resolution (small d).
            args.resolution = { dmin: Math.min(lo, hi), dmax: Math.max(lo, hi) };
        }
        i++;
    }
    return args;
}

function fmtCell(cell, decimals = 2) {
    const n = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '?');
    return `${n(cell.a, decimals)} ${n(cell.b, decimals)} ${n(cell.c, decimals)}  ${n(cell.alpha, 1)} ${n(cell.beta, 1)} ${n(cell.gamma, 1)}`;
}

function printCellSearch(queryCell, args) {
    const databases = args.databases && args.databases.length
        ? args.databases
        : (() => {
            const d = [];
            if (args.search || args.codsearch) d.push('COD');
            if (args.search || args.pdbsearch) d.push('PDB');
            return d;
        })();

    console.log('');
    console.log('==============================================');
    console.log('  xrdspace  —  unit-cell database search');
    console.log('==============================================');
    console.log(`  Query cell         : ${fmtCell(queryCell, 3)}`);
    console.log(`  Databases          : ${databases.join(', ')}`);
    console.log(`  Length tolerance   : ${args.tol}%   angle tolerance: ${args.tolAngle} deg`);
    console.log(`  Match score        : 100 - (max rel. length dev % + max angle dev deg)`);
    console.log('----------------------------------------------');
    if (!args.settings) {
        console.log('  No search settings were generated for this cell.');
        console.log('==============================================');
        return;
    }
    console.log(`  Standard settings  : ${args.settings.length}`);
    console.log('----------------------------------------------');

    if (!args.results || !args.results.length) {
        console.log('  No matching structures found in the searched databases.');
        console.log('  (Try a wider --tol / --tol-angle.)');
    } else {
        console.log(`  Rank   Match  DB    ID      Space group      a       b       c    alpha  beta  gamma`);
        console.log(`  ${'-'.repeat(96)}`);
        let rank = 0;
        for (const r of args.results) {
            rank++;
            const sg = r.spaceGroup && r.spaceGroup.hm ? r.spaceGroup.hm : (r.spaceGroup && r.spaceGroup.number ? `#${r.spaceGroup.number}` : '?');
            const cell = r.cell;
            console.log(`  ${String(rank).padStart(4)}  ${r.match.toFixed(1).padStart(5)}%  ${r.database.padEnd(3)}  ${String(r.id).padEnd(7)}  ${sg.padEnd(14)}  ${fmtCell(cell)}`);
            const desc = r.title || r.chemname || r.mineral || r.formula || r.journal || '';
            if (desc) console.log(`       ${desc}`);
            const extra = [];
            if (r.spaceGroup && r.spaceGroup.number) extra.push(`space group #${r.spaceGroup.number}`);
            if (r.formula && !desc) extra.push(`formula ${r.formula}`);
            if (r.journal) extra.push(r.journal);
            if (r.year) extra.push(r.year);
            if (r.esd) {
                const e = r.esd;
                extra.push(`esd(a,b,c) = ${e.a ? e.a.toExponential(1) : '-'} ${e.b ? e.b.toExponential(1) : '-'} ${e.c ? e.c.toExponential(1) : '-'}`);
            }
            if (r.doi) extra.push(r.doi);
            if (extra.length) console.log(`       ${extra.join('  ·  ')}`);
        }
    }
    if (args.total != null && args.total > args.results.length) {
        console.log('----------------------------------------------');
        console.log(`  ${args.total} matching entries found in total; showing top ${args.results.length}.`);
    }
    if (args.errors && args.errors.length) {
        console.log('----------------------------------------------');
        for (const e of args.errors) console.log(`  search error: ${e}`);
    }
    console.log('==============================================');
}

// Format the offline-PDB space-group validation as report body lines.
function formatPdbValidation(v, opts) {
    const L = [];
    L.push(reportKv('Lookup table', `${opts.tablePath} (${opts.tableCount} entries)`));
    L.push(reportKv('Query cell', fmtCell(v.queryCell, 3)));
    L.push(reportKv('Tolerances', `${opts.tol}% lengths, ${opts.tolAngle} deg angles`));
    if (v.total === 0) {
        L.push(reportKv('Matching PDB', 'none'));
        L.push(reportKv('Result', 'INDETERMINATE'));
        L.push('    No PDB structure matches this cell. (widen --tol / --tol-angle,');
        L.push('    or rebuild the table with  node scripts/build-pdb-table.js)');
        return L.join('\n');
    }
    L.push(reportKv('Matching PDB', `${v.total} entr${v.total === 1 ? 'y' : 'ies'}`));
    L.push(reportKv('PDB space groups', v.sgCounts.map(s => s.hm ? `${s.hm} (No. ${s.sg}) x${s.count}` : `No. ${s.sg} x${s.count}`).join(', ')));
    const shown = v.matches.slice(0, 5);
    if (shown.length) {
        L.push(reportKv('Matches', `${shown.map(m => `${m.id} (No. ${m.sg})`).join(', ')}${v.total > shown.length ? `, +${v.total - shown.length} more` : ''}`));
    }
    const d = opts.determined;
    L.push(reportKv('Determined SG', d ? `${d.hm} (No. ${d.id})` : `No. ${v.determinedSg}`));
    if (opts.forcedHm) L.push(`  (forced for output: ${opts.forcedHm})`);
    if (v.verdict === 'verified') {
        L.push(reportKv('Result', 'VERIFIED'));
        L.push(`    PDB assigns this cell to space group No. ${v.determinedSg}.`);
    } else if (v.verdict === 'enantiomorph') {
        L.push(reportKv('Result', 'AMBIGUOUS (enantiomorph)'));
        L.push(`    PDB assigns this cell to No. ${v.enantiomorphOf}; Nos. ${v.determinedSg} and ${v.enantiomorphOf} are`);
        L.push('    an enantiomorphic pair and cannot be told apart from the diffraction');
        L.push('    pattern alone (only by anomalous scattering).');
    } else if (v.verdict === 'mismatch') {
        L.push(reportKv('Result', 'MISMATCH'));
        L.push(`    PDB structures with this cell are in space group${v.sgNumbers.length === 1 ? '' : 's'} ${v.sgNumbers.join(', ')};`);
        L.push(`    No. ${v.determinedSg} was determined. Check the indexing / space-group assignment.`);
    }
    return L.join('\n');
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`xrdspace: ${e.message}`);
        console.error(HELP);
        process.exit(1);
    }
    if (args.help) { console.log(HELP); process.exit(0); }
    if (args.version) { console.log(`xrdspace version ${VERSION}`); process.exit(0); }

    // Unit-cell database search mode: --search / --codsearch / --pdbsearch.
    if (args.search || args.codsearch || args.pdbsearch) {
        let cell = args.cell;
        if (!cell) {
            console.error('xrdspace: cell search needs a query cell. Use --cell "a b c alpha beta gamma".');
            process.exit(1);
        }
        const databases = [];
        if (args.search) databases.push('COD', 'PDB');
        if (args.codsearch) databases.push('COD');
        if (args.pdbsearch) databases.push('PDB');
        const queryCell = {
            a: cell.a, b: cell.b, c: cell.c,
            alpha: cell.alpha, beta: cell.beta, gamma: cell.gamma,
        };
        try {
            const tol = args.tol / 100;
            const r = await searchByCell(queryCell, {
                databases,
                tolLen: tol,
                tolAng: args.tolAngle,
                limit: args.limit,
            });
            printCellSearch(queryCell, { ...r, tol: args.tol, tolAngle: args.tolAngle, limit: args.limit });
        } catch (e) {
            console.error(`xrdspace: cell search failed: ${e.message}`);
            process.exit(1);
        }
        process.exit(0);
    }

    if (!args.hklin) {
        console.error('xrdspace: no input HKL file given.');
        console.error(HELP);
        process.exit(1);
    }

    const filePath = path.resolve(args.hklin);
    if (!fs.existsSync(filePath)) {
        console.error(`xrdspace: file not found: ${filePath}`);
        process.exit(1);
    }
    const text = fs.readFileSync(filePath, 'utf8');

    let cell = args.cell;
    if (!cell) {
        const parsed = parseHkl(text);
        if (!parsed.cell) {
            console.log('xrdspace: HKL file has no unit-cell parameters.');
            try {
                cell = await promptCell();
            } catch (e) {
                console.error(`xrdspace: ${e.message}`);
                process.exit(1);
            }
        }
    }

    const sfacOpts = args.sfac ? parseSfacInput(args.sfac) : {};
    const result = analyzeHkl(text, {
        cell,
        spaceGroup: args.spaceGroup,
        laue: args.laue,
        resolution: args.resolution,
        sigThreshold: args.sigThreshold,
        sfac: sfacOpts.sfac,
        unit: sfacOpts.unit,
        chiral: args.chiral,
        quality: true,
    });
    if (!result.ok) abortAnalysis(result);

    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name;
    const outputFiles = [];
    const notes = [];

    // Validate the determined space group against the offline PDB lookup table.
    let validationText = null;
    if (args.valid) {
        const tablePath = path.resolve(args.pdbTable || path.join(__dirname, '..', 'data', 'pdb-cells.json'));
        if (!fs.existsSync(tablePath)) {
            console.error(`xrdspace: PDB lookup table not found: ${tablePath}`);
            console.error(`  Build it once with:  node scripts/build-pdb-table.js`);
            process.exit(1);
        }
        const table = loadPdbLookup(tablePath);
        const determined = result.determined || result.best;
        if (!determined) {
            console.error('xrdspace: no space group determined to validate.');
            process.exit(1);
        }
        const v = validateSpaceGroupAgainstPdb(table, result.cell, determined.id, {
            tolLen: args.tol / 100,
            tolAng: args.tolAngle,
        });
        validationText = formatPdbValidation(v, {
            tablePath,
            tableCount: table.entries.length,
            tol: args.tol,
            tolAngle: args.tolAngle,
            determined,
            forcedHm: result.forced ? `${result.forced.hm} (No. ${result.forced.id})` : null,
        });
    }

    // Write the corrected/merged HKL files.
    if (result.merge) {
        const shelxPath = path.resolve(args.hklout || path.join(dir, base + '_merged.hkl'));
        const xdsPath = path.resolve(args.xdsout || path.join(dir, base + '_xds.hkl'));
        const unmergedPath = path.resolve(args.unmergedOut || path.join(dir, base + '_unmerged.hkl'));
        const insPath = path.resolve(args.hklout ? args.hklout.replace(/\.hkl$/i, '.ins') : path.join(dir, base + '_merged.ins'));
        // Keep the XDS header OUTPUT_FILE consistent with the written file.
        result.merge.xdsAscii = result.merge.xdsAscii.replace(
            /!OUTPUT_FILE=[^\n]*/,
            '!OUTPUT_FILE=' + path.basename(xdsPath));
        result.merge.unmergedXdsAscii = result.merge.unmergedXdsAscii.replace(
            /!OUTPUT_FILE=[^\n]*/,
            '!OUTPUT_FILE=' + path.basename(unmergedPath));
        fs.writeFileSync(shelxPath, result.merge.shelxHkl, 'utf8');
        fs.writeFileSync(xdsPath, result.merge.xdsAscii, 'utf8');
        fs.writeFileSync(unmergedPath, result.merge.unmergedXdsAscii, 'utf8');
        outputFiles.push({ path: shelxPath, note: '(SHELX format, ready for SHELXD/SHELXT)' });
        outputFiles.push({ path: xdsPath, note: '(merged XDS_ASCII)' });
        outputFiles.push({ path: unmergedPath, note: '(UNMERGED XDS_ASCII, all observations)' });
        if (result.merge.inputWasMerged) {
            notes.push('the input was already merged, so the unmerged file has no redundant observations');
        }
        if (result.merge.shelxIns) {
            fs.writeFileSync(insPath, result.merge.shelxIns, 'utf8');
            outputFiles.push({ path: insPath, note: '(SHELX instructions, matching cell/space group)' });
        }
    }

    // Consolidated report: printed to the console and saved next to the input.
    const logPath = path.resolve(args.log || path.join(dir, 'xrdspace.log'));
    outputFiles.push({ path: logPath, note: '(this report)' });
    const report = buildReport(result, {
        inputPath: filePath,
        outputFiles,
        validationText,
        notes,
    });
    fs.writeFileSync(logPath, report, 'utf8');
    process.stdout.write('\n' + report);
}

main();
