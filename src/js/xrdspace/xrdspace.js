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

import { analyzeHkl } from './index.js';
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
  --xdsout <file>     Output merged HKL file, XDS_ASCII format (default: <input>_XDS.HKL)
  --log <file>        Write all console output (the printed logs) to a file

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
accepted. Without --hklout/--xdsout the merged files are written next to the
input file.
`;

function printAnalysis(result) {
    if (!result.ok) {
        console.error(`xrdspace: ${result.error}`);
        if (result.error === 'NO_CELL') {
            console.error('  The HKL file does not contain unit-cell parameters.');
            console.error('  Run again with --cell "a b c alpha beta gamma" or provide them at the prompt.');
        }
        process.exit(1);
    }

    const s = result.summary;
    console.log('');
    console.log('==============================================');
    console.log('  xrdspace  —  space-group determination');
    console.log('==============================================');
    console.log(`  Format             : ${s.format}`);
    if (s.title) console.log(`  Title              : ${s.title}`);
    console.log(`  Unit cell          : ${result.cell.a} ${result.cell.b} ${result.cell.c}  ${result.cell.alpha} ${result.cell.beta} ${result.cell.gamma}`);
    if (s.wavelength) console.log(`  Wavelength         : ${s.wavelength}`);
    console.log(`  Reflections        : ${s.nReflections}`);
    console.log(`  Crystal system     : ${s.crystalSystem}${s.uniqueAxis ? ' (unique ' + s.uniqueAxis + ')' : ''}`);
    console.log(`  Lattice centering  : ${s.centering}`);
    console.log(`  Centrosymmetric    : ${s.centricity}  (<|E^2-1|> = ${s.centricityScore.toFixed(3)})`);
    if (s.chiral) console.log('  Chiral restriction : on (Sohncke space groups only)');
    console.log(`  Laue class         : ${s.laueClass}   R(sym) = ${(s.laueRSym * 100).toFixed(2)} %`);
    console.log('----------------------------------------------');
    console.log('  R(sym) by Laue class:');
    for (const row of result.laueTable) {
        const mark = row.chosen ? ' <--' : '';
        console.log(`    ${row.name.padEnd(7)} order ${String(row.order).padStart(2)}  R(sym) = ${(row.rsym * 100).toFixed(2)} %${mark}`);
    }
    console.log('----------------------------------------------');
    console.log('  Space-group candidates (systematic absences):');
    if (!result.candidates.length) {
        console.log('    (no candidates matched)');
    } else {
        for (const c of result.candidates.slice(0, 12)) {
            const mark = c.id === result.best.id ? '  <-- best' : '';
            console.log(`    ${String(c.id).padStart(3)}  ${c.hm.padEnd(20)} violations ${String(c.violations).padStart(4)}${mark}`);
        }
    }
    if (result.best) {
        console.log('----------------------------------------------');
        const forced = result.summary && result.summary.forced ? '  [forced]' : '';
        console.log(`  Best space group  : ${result.best.hm}  (No. ${result.best.id})${forced}`);
        if (result.determined && result.summary && result.summary.forced) {
            console.log(`  (determined       : ${result.determined.hm} (No. ${result.determined.id}))`);
        }
    }
    if (result.merge && result.merge.consistency) {
        const c = result.merge.consistency;
        const ok = c.violations === 0 ? 'consistent with data' : `INCONSISTENT (${c.violations} violation(s))`;
        console.log(`  Data consistency  : ${ok}`);
    }
    if (result.merge) {
        console.log('----------------------------------------------');
        console.log('  Merging statistics:');
        const st = result.merge.statistics;
        console.log(`    Resolution range : ${st.dmax.toFixed(2)} - ${st.dmin.toFixed(2)} A`);
        console.log(`    Observations     : ${st.nObs}`);
        console.log(`    Unique           : ${st.nUnique}`);
        console.log(`    Multiplicity     : ${st.meanMultiplicity.toFixed(1)}`);
        console.log(`    Completeness     : ${(st.completeness * 100).toFixed(1)} %`);
        console.log(`    R(merge)         : ${(st.rMerge * 100).toFixed(2)} %`);
        console.log(`    R(pim)           : ${(st.rPim * 100).toFixed(2)} %`);
        console.log(`    Mean I/sigma(I)  : ${st.meanIsig.toFixed(1)}`);
    }
    console.log('==============================================');
    if (result.merge) {
        console.log('');
        console.log(result.merge.report);
    }
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
        hklin: 1, hklout: 1, xdsout: 1, spacegroup: 1, sg: 1, laue: 1, sigthreshold: 1,
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
    const args = { hklin: null, hklout: null, xdsout: null, cell: null, spaceGroup: null, laue: null, resolution: null, sigThreshold: 5, sfac: null, log: null, chiral: null, help: false, version: false, search: null, codsearch: false, pdbsearch: false, tol: 1.0, tolAngle: 1.5, limit: 20, valid: false, pdbTable: null };
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
        } else if (a === 'hklin' || a === 'hklout' || a === 'xdsout' || a === 'spacegroup' || a === 'laue'
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

// Tee console output into a log file (synchronous writes so it is flushed even
// on process.exit). The log file is truncated at the start of the run.
function setupLogFile(logPath) {
    const resolved = path.resolve(logPath);
    try { fs.writeFileSync(resolved, ''); } catch (e) { /* ignore */ }
    const origLog = console.log;
    const origErr = console.error;
    const fmt = (args) => {
        let out = '';
        for (let i = 0; i < args.length; i++) {
            if (i) out += ' ';
            out += typeof args[i] === 'string' ? args[i] : JSON.stringify(args[i]);
        }
        return out;
    };
    const write = (line) => {
        try { fs.appendFileSync(resolved, line + '\n', 'utf8'); } catch (e) { /* ignore */ }
    };
    console.log = (...args) => { origLog(...args); write(fmt(args)); };
    console.error = (...args) => { origErr(...args); write(fmt(args)); };
    return resolved;
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

function printPdbValidation(v, opts) {
    console.log('');
    console.log('==============================================');
    console.log('  xrdspace  —  PDB space-group validation');
    console.log('==============================================');
    console.log(`  Lookup table      : ${opts.tablePath} (${opts.tableCount} entries)`);
    console.log(`  Query cell        : ${fmtCell(v.queryCell, 3)}`);
    console.log(`  Tolerances        : ${opts.tol}% lengths, ${opts.tolAngle} deg angles`);
    if (v.total === 0) {
        console.log('  Matching PDB      : none');
        console.log('----------------------------------------------');
        console.log('  Result            : INDETERMINATE');
        console.log('    No PDB structure matches this cell. (widen --tol / --tol-angle,');
        console.log('    or rebuild the table with  node scripts/build-pdb-table.js)');
        console.log('==============================================');
        return;
    }
    console.log(`  Matching PDB      : ${v.total} entr${v.total === 1 ? 'y' : 'ies'}`);
    console.log(`  PDB space groups  : ${v.sgCounts.map(s => s.hm ? `${s.hm} (No. ${s.sg}) x${s.count}` : `No. ${s.sg} x${s.count}`).join(', ')}`);
    const shown = v.matches.slice(0, 5);
    if (shown.length) {
        console.log(`  Matches           : ${shown.map(m => `${m.id} (No. ${m.sg})`).join(', ')}${v.total > shown.length ? `, +${v.total - shown.length} more` : ''}`);
    }
    console.log('----------------------------------------------');
    const d = opts.determined;
    console.log(`  Determined SG     : ${d ? `${d.hm} (No. ${d.id})` : `No. ${v.determinedSg}`}`);
    if (opts.forcedHm) console.log(`  (forced for output: ${opts.forcedHm})`);
    if (v.verdict === 'verified') {
        console.log('  Result            : VERIFIED');
        console.log(`    PDB assigns this cell to space group No. ${v.determinedSg}.`);
    } else if (v.verdict === 'enantiomorph') {
        console.log('  Result            : AMBIGUOUS (enantiomorph)');
        console.log(`    PDB assigns this cell to No. ${v.enantiomorphOf}; Nos. ${v.determinedSg} and ${v.enantiomorphOf} are`);
        console.log('    an enantiomorphic pair and cannot be told apart from the diffraction');
        console.log('    pattern alone (only by anomalous scattering).');
    } else if (v.verdict === 'mismatch') {
        console.log('  Result            : MISMATCH');
        console.log(`    PDB structures with this cell are in space group${v.sgNumbers.length === 1 ? '' : 's'} ${v.sgNumbers.join(', ')};`);
        console.log(`    No. ${v.determinedSg} was determined. Check the indexing / space-group assignment.`);
    }
    console.log('==============================================');
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
    if (args.log) {
        const logPath = setupLogFile(args.log);
        process.stdout.write(`Logging to: ${logPath}\n`);
    }

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
    });
    printAnalysis(result);

    // Validate the determined space group against the offline PDB lookup table.
    if (result.ok && args.valid) {
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
        printPdbValidation(v, {
            tablePath,
            tableCount: table.entries.length,
            tol: args.tol,
            tolAngle: args.tolAngle,
            determined,
            forcedHm: result.forced ? `${result.forced.hm} (No. ${result.forced.id})` : null,
        });
    }

    // Write the corrected/merged HKL files.
    if (result.ok && result.merge) {
        const dir = path.dirname(filePath);
        const base = path.parse(filePath).name;
        const shelxPath = path.resolve(args.hklout || path.join(dir, base + '_merged.hkl'));
        const xdsPath = path.resolve(args.xdsout || path.join(dir, base + '_XDS.HKL'));
        const insPath = path.resolve(args.hklout ? args.hklout.replace(/\.hkl$/i, '.ins') : path.join(dir, base + '_merged.ins'));
        // Keep the XDS header OUTPUT_FILE consistent with the written file.
        result.merge.xdsAscii = result.merge.xdsAscii.replace(
            /!OUTPUT_FILE=[^\n]*/,
            '!OUTPUT_FILE=' + path.basename(xdsPath));
        fs.writeFileSync(shelxPath, result.merge.shelxHkl, 'utf8');
        fs.writeFileSync(xdsPath, result.merge.xdsAscii, 'utf8');
        if (result.merge.shelxIns) {
            fs.writeFileSync(insPath, result.merge.shelxIns, 'utf8');
        }
        console.log(`Merged HKL written to:`);
        console.log(`  ${shelxPath}  (SHELX format, ready for SHELXD/SHELXT)`);
        console.log(`  ${xdsPath}  (merged XDS_ASCII)`);
        if (result.merge.shelxIns) {
            console.log(`  ${insPath}  (SHELX instructions, matching cell/space group)`);
        }
    }
}

main();
