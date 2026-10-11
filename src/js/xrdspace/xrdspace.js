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

import { analyzeParsed, cellVolume } from './index.js';
import { parseHkl } from './hkl-parser.js';
import { searchByCell, structureDownloads, fetchStructureDownloads } from './cell-search.js';
import { loadPdbLookup, validateSpaceGroupAgainstPdb } from './pdb-lookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = '1.0.0';

const HELP = `
xrdspace — space-group determination and reflection merging (POINTLESS-style CLI)

Usage:
  node src/xrdspace.js --hklin <file.hkl> [options]
  node src/xrdspace.js --codsearch|--pdbsearch|--search --cell "a b c alpha beta gamma" [options]

Input / output:
   --hklin <file> [<file> ...]
                       Input HKL file(s) (XDS_ASCII, SHELX five-column, or
                       Bruker P4P). Give all scans of the same crystal as one
                       list, e.g. --hklin scan1.hkl scan2.hkl scan3.hkl. The
                       first is used for space-group determination, all are
                       combined for the analysis, and with --abs each file is a
                       scan. (Repeating --hklin also works.)
  --hklout <file>     Output UNMERGED HKL file, SHELX format (default: <input>_shelx.hkl).
                      SHELX (HKLF 4) does its own merging, so the raw observations
                      are written; a merged SHELX file is also available in the API
                      as merge.shelxHklMerged.
  --xdsout <file>     Output merged HKL file, XDS_ASCII format (default: <input>_xds.hkl)
   --unmergedout <file>  Output UNMERGED HKL file, XDS_ASCII format (MERGE=FALSE),
                        keeping all observations (default: <input>_unmerged.hkl)
   --mtzout <file>     Output MERGED MTZ file for REFMAC / CCP4, columns
                       H K L IMEAN SIGIMEAN F SIGF (default: <input>_merged.mtz)
  --log <file>        Write the formatted report to <file>
                      (default: xrdspace.log next to the input file)
  --no-write          Analyse and print the report to stdout only; do not
                      create any output files (no HKL, .ins or log files).

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
  --download <dir>    Download the deposited structure file of every reported
                      match into <dir> (created if needed). PDB entries come from
                      RCSB, COD entries (CIF only) from the COD server.
  --format <fmt>      Which file(s) --download fetches:
                        pdb    RCSB legacy PDB format (.pdb)
                        cif    mmCIF (.cif; PDB and COD)
                        both   .pdb and .cif for PDB hits, .cif for COD (default)
                        native the database's own format (PDB -> .pdb, COD -> .cif)

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

Beam-damage analysis (RADDOSE-style):
  --rad                             Analyse radiation damage over the course of the
                                    scan. Uses each observation's rotation angle
                                    (PSI column) as the dose coordinate: the mean
                                    intensity recorded LATE in the scan is compared
                                    with that recorded EARLY, per resolution shell
                                    (R = <I>_late / <I>_early; R < 1 = decayed).
                                     Needs input carrying a per-observation
                                      rotation angle: unmerged XDS_ASCII (PSI
                                      column) or Bruker P4P (omega); on other input
                                      it reports why it is not usable. The per-shell
                                      table is written to the consolidated report
                                      (xrdspace.log). See Pantelides et al., Acta
                                      Cryst. D65, 1010-1022 (2009).
    --rad-minisig <n>                 I/sigma threshold for observations entering the
                                     analysis (default 2)
   --rad-early <frac>                Fraction of the rotation counted as "early"
                                     (default 0.25)
   --rad-late <frac>                 Fraction of the rotation counted as "late"
                                     (default 0.25)
   --rad-shells <n>                  Number of resolution shells (default 10)

Multi-scan absorption correction (AIMLESS method, Evans & McCoy, Acta Cryst.
   D66, 210 (2010)):
   --abs                             Enable absorption correction on the --hklin
                                     data. With a single --hklin file it runs in
                                     single-scan mode (symmetry-equivalent
                                     reflections); give multiple --hklin files for
                                     true multi-scan correction. The corrected
                                     intensities feed the merge and every output
                                     file (so run it AFTER the space group is
                                     known, which the auto-determination handles
                                     internally).
   --abs-cycles <n>                  ALS iterations (default 30).
   --abs-order <n>                   Spherical-harmonic order: even l up to n,
                                     odd l up to n-1 (default 6, i.e. the
                                     AIMLESS 6/5 set = 49 terms).
   --abs-outlier <sigma>             Reject observations beyond this many sigma
                                     (default 6).
   --abs-robust <lncosh|huber|none>  Robust loss for the fit (default lncosh).
   --abs-no-sd                       Skip the per-scan SD sigma correction.
   --abs-min-scans <n>               Minimum distinct scans per equivalent set
                                     (default 2 when >= 2 scans, else 1).

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
    const header = [];
    for (const c of cols) header.push(cell(c[0], c[1], c[2]));
    const out = ['  ' + header.join(' ')];
    for (const s of shells) {
        const vals = [
            `${s.dHi.toFixed(2)}-${s.dLo.toFixed(2)}`,
            String(s.nObs), String(s.nUnique), pct(s.completeness),
            s.multiplicity.toFixed(1), pct(s.rMerge), pct(s.rMeas), pct(s.rPim),
            s.meanIsig.toFixed(1), s.ccHalf == null ? '-' : s.ccHalf.toFixed(3),
            (s.negFrac * 100).toFixed(0) + '%',
        ];
        const cells = [];
        for (let i = 0; i < vals.length; i++) cells.push(cell(vals[i], cols[i][1], cols[i][2]));
        out.push('  ' + cells.join(' '));
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

// RADDOSE-style beam-damage report block (per-shell I_late/I_early decay).
function fmtBeamDamage(bd) {
    const L = [];
    if (!bd || !bd.usable) {
        L.push(reportKv('Beam damage', 'not analysed'));
        L.push(`    ${(!bd || bd.reason) || 'no data'}`);
        L.push('    (needs input with a per-observation rotation angle: XDS_ASCII PSI or P4P omega)');
        return L;
    }
    L.push(reportKv('Scan rotation', `${bd.totalRotation} deg` + (Number.isFinite(bd.startAngle) ? ` (start ${bd.startAngle} deg)` : '')));
    L.push(reportKv('Dose positions', `${bd.doseMin.toFixed(1)} - ${bd.doseMax.toFixed(1)} deg (PSI)`));
    L.push(reportKv('Usable observations', `${bd.nObs}  (${bd.nRefl} reflections)`));
    L.push(reportKv('Window', `early = first ${Math.round(bd.earlyFrac * 100)}%, late = last ${Math.round(bd.lateFrac * 100)}%   (I/σ >= ${bd.minIsig})`));
    L.push('');
    const o = bd.overall;
    L.push(reportKv('Overall <I>_late/<I>_early', Number.isFinite(o.ratio) ? o.ratio.toFixed(3) : '?'));
    if (Number.isFinite(o.k)) L.push(reportKv('Decay constant k', `${o.k.toFixed(6)} per deg  (${(o.k * 100).toFixed(4)} per 100 deg)`));
    if (o.doseHalf != null) L.push(reportKv('Rotation to half intensity', `${o.doseHalf.toFixed(1)} deg`));
    if (Number.isFinite(o.r2)) L.push(reportKv('Fit R^2 (ln R vs 1/d^2)', o.r2.toFixed(3)));
    L.push(reportKv('Damage detected', bd.decay));
    L.push('');
    L.push('  Per-resolution-shell decay  (R = <I>_late / <I>_early;  R < 1 = decayed):');
    L.push('    d range (A)      nE     nL     <I>_early   <I>_late       R');
    for (const s of bd.shells) {
        const R = Number.isFinite(s.ratio) ? s.ratio.toFixed(3) : '   -';
        const flag = Number.isFinite(s.ratio) && s.ratio < 0.9 ? '   <-- decayed' : '';
        L.push('  ' + `${s.dHi.toFixed(2)}-${s.dLo.toFixed(2)}`.padEnd(15)
            + String(s.nEarly).padStart(6) + String(s.nLate).padStart(6)
            + (Number.isFinite(s.meanEarly) ? s.meanEarly.toFixed(1).padStart(11) : '-'.padStart(11))
            + (Number.isFinite(s.meanLate) ? s.meanLate.toFixed(1).padStart(11) : '-'.padStart(11))
            + R.padStart(8) + flag);
    }
    L.push('');
    L.push('  Note: the dose coordinate is the rotation angle. Converting k to e-/A^2 or');
    L.push('  Gy requires the beam flux / current, which is not stored in the HKL file.');
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

    if (result.merge && result.merge.beamDamage) {
        L.push(...reportSection('BEAM DAMAGE (RADDOSE-STYLE)'));
        L.push(...fmtBeamDamage(result.merge.beamDamage));
        L.push('');
    }

    if (result.merge && result.merge.absorption) {
        L.push(...reportSection('ABSORPTION CORRECTION (AIMLESS METHOD)'));
        // The report carries its own title + method line + separator; drop
        // those leading header lines so the section header above stands alone.
        const lines = (result.merge.absorption.report || '').split('\n');
        if (lines.length && /absorption correction/i.test(lines[0])) lines.shift();
        if (lines.length && /method:/i.test(lines[0])) lines.shift();
        while (lines.length && (lines[0] === '' || /^=+$/.test(lines[0].trim()))) lines.shift();
        L.push(...lines);
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
        hklin: 1, hklout: 1, xdsout: 1, unmergedout: 1, mtzout: 1, spacegroup: 1, sg: 1, laue: 1, sigthreshold: 1,
        sfac: 1, formula: 1, log: 1, tol: 1, 'tol-angle': 1, limit: 1, 'pdb-table': 1,
        download: 1, format: 1,
        cell: 6, resolution: 2,
        chiral: 0, 'no-chiral': 0, nochiral: 0, valid: 0,
        'no-write': 0, nowrite: 0,
        search: 0, codsearch: 0, pdbsearch: 0,
        rad: 0, 'rad-minisig': 1, 'rad-early': 1, 'rad-late': 1, 'rad-shells': 1,
        abs: 0, 'abs-cycles': 1, 'abs-order': 1, 'abs-outlier': 1,
        'abs-robust': 1, 'abs-no-sd': 0, 'abs-min-scans': 1,
    };
    // Recognized option keywords (used to stop --hklin's variadic file list).
    const KNOWN_KEYWORDS = new Set(Object.keys(N_VALUES));

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
    const args = { hklin: null, hklout: null, xdsout: null, unmergedOut: null, mtzout: null, cell: null, spaceGroup: null, laue: null, resolution: null, sigThreshold: 5, sfac: null, log: null, chiral: null, help: false, version: false, search: null, codsearch: false, pdbsearch: false, tol: 1.0, tolAngle: 1.5, limit: 20, download: null, format: 'both', valid: false, pdbTable: null, noWrite: false, rad: false, radMinIsig: 2, radEarlyFrac: 0.25, radLateFrac: 0.25, radShells: 10, hklinFiles: [], abs: false, absCycles: 30, absOrder: 6, absOutlier: 6, absRobust: 'lncosh', absNoSD: false, absMinScans: null };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { args.help = true; i++; continue; }
        if (a === '--version' || a === '-v') { args.version = true; i++; continue; }

        // --hklin / hklin [file ...] : one or more input scans (each file is a
        // scan of the same crystal). Consume following tokens as file names
        // until the next recognized keyword or a '-'-option, so both
        //   --hklin a.hkl b.hkl --abs
        //   hklin a.hkl b.hkl spacegroup 14
        // work. Repeated --hklin is also accepted.
        if (a === '--hklin' || a === 'hklin') {
            i++;
            while (i < argv.length) {
                const t = argv[i];
                if (t.startsWith('-')) break;
                if (KNOWN_KEYWORDS.has(t.toLowerCase())) break;
                args.hklinFiles.push(t);
                i++;
            }
            if (!args.hklinFiles.length) throw new Error('hklin expects at least one file');
            args.hklin = args.hklinFiles[0];
            continue;
        }

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
        } else if (a === 'hklin' || a === 'hklout' || a === 'xdsout' || a === 'unmergedout' || a === 'mtzout' || a === 'spacegroup' || a === 'laue'
            || a === 'cell' || a === 'resolution' || a === 'sigthreshold' || a === 'sfac' || a === 'formula' || a === 'log'
            || a === 'chiral' || a === 'no-chiral' || a === 'nochiral'
            || a === 'search' || a === 'codsearch' || a === 'pdbsearch' || a === 'tol' || a === 'tol-angle' || a === 'limit'
            || a === 'download' || a === 'format'
            || a === 'valid' || a === 'pdb-table'
            || a === 'rad' || a === 'rad-minisig' || a === 'rad-early' || a === 'rad-late' || a === 'rad-shells'
            || a === 'abs' || a === 'abs-cycles' || a === 'abs-order' || a === 'abs-outlier'
            || a === 'abs-robust' || a === 'abs-no-sd' || a === 'abs-min-scans') {
            key = a;
            n = N_VALUES[a];
        } else if (!a.startsWith('-')) {
            // Positional argument: treated as an hklin file (may be repeated).
            args.hklinFiles.push(a);
            args.hklin = args.hklinFiles[0];
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

        if (key === 'hklin') { args.hklinFiles.push(vals[0]); args.hklin = args.hklinFiles[0]; }
        else if (key === 'hklout') args.hklout = vals[0];
        else if (key === 'xdsout') args.xdsout = vals[0];
        else if (key === 'unmergedout') args.unmergedOut = vals[0];
        else if (key === 'mtzout') args.mtzout = vals[0];
        else if (key === 'log') args.log = vals[0];
        else if (key === 'valid') args.valid = true;
        else if (key === 'pdb-table') args.pdbTable = vals[0];
        else if (key === 'chiral') args.chiral = true;
        else if (key === 'no-chiral' || key === 'nochiral') args.chiral = false;
        else if (key === 'no-write' || key === 'nowrite') args.noWrite = true;
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
        } else if (key === 'download') args.download = vals[0];
        else if (key === 'format') {
            const v = String(vals[0]).toLowerCase();
            if (!['pdb', 'cif', 'both', 'native'].includes(v)) throw new Error('format expects pdb | cif | both | native');
            args.format = v;
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
        } else if (key === 'rad') args.rad = true;
        else if (key === 'rad-minisig') {
            const t = parseFloat(vals[0]);
            if (!Number.isFinite(t) || t < 0) throw new Error('rad-minisig expects a non-negative number');
            args.radMinIsig = t;
        } else if (key === 'rad-early' || key === 'rad-late') {
            const t = parseFloat(vals[0]);
            if (!Number.isFinite(t) || t <= 0 || t >= 0.5) throw new Error(`${key} expects a fraction in (0, 0.5)`);
            if (key === 'rad-early') args.radEarlyFrac = t; else args.radLateFrac = t;
        } else if (key === 'rad-shells') {
            const t = parseInt(vals[0], 10);
            if (!Number.isFinite(t) || t < 2) throw new Error('rad-shells expects an integer >= 2');
            args.radShells = t;
        } else if (key === 'abs') args.abs = true;
        else if (key === 'abs-cycles') {
            const t = parseInt(vals[0], 10);
            if (!Number.isFinite(t) || t < 1) throw new Error('abs-cycles expects a positive integer');
            args.absCycles = t;
        } else if (key === 'abs-order') {
            const t = parseInt(vals[0], 10);
            if (!Number.isFinite(t) || t < 2) throw new Error('abs-order expects an integer >= 2 (spherical-harmonic order)');
            args.absOrder = t;
        } else if (key === 'abs-outlier') {
            const t = parseFloat(vals[0]);
            if (!Number.isFinite(t) || t <= 0) throw new Error('abs-outlier expects a positive sigma threshold');
            args.absOutlier = t;
        } else if (key === 'abs-robust') {
            const v = String(vals[0]).toLowerCase();
            if (!['lncosh', 'huber', 'none'].includes(v)) throw new Error('abs-robust expects lncosh | huber | none');
            args.absRobust = v;
        } else if (key === 'abs-no-sd') args.absNoSD = true;
        else if (key === 'abs-min-scans') {
            const t = parseInt(vals[0], 10);
            if (!Number.isFinite(t) || t < 1) throw new Error('abs-min-scans expects a positive integer');
            args.absMinScans = t;
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

// Download the deposited structure file(s) of the search hits into args.download.
// PDB entries come from RCSB (PDB and/or mmCIF); COD entries are CIF only.
async function downloadSearchResults(results, args) {
    const dir = path.resolve(args.download);
    fs.mkdirSync(dir, { recursive: true });
    const downloads = structureDownloads(results, { formats: args.format });
    console.log('');
    console.log('----------------------------------------------');
    if (!downloads.length) {
        console.log('  Download      : nothing to fetch (no matched structures).');
        console.log('==============================================');
        return;
    }
    console.log(`  Download      : ${downloads.length} file(s) -> ${dir}`);
    let fetched;
    try {
        fetched = await fetchStructureDownloads(downloads);
    } catch (e) {
        console.log(`  Download failed: ${e.message}`);
        console.log('==============================================');
        return;
    }
    let saved = 0;
    for (const f of fetched) {
        if (f.error) {
            console.log(`    FAILED  ${f.database} ${f.id} (${f.format}): ${f.error}`);
            continue;
        }
        const dest = path.join(dir, path.basename(f.filename));
        fs.writeFileSync(dest, f.text, 'utf8');
        saved++;
        console.log(`    saved   ${f.database} ${String(f.id).padEnd(7)} -> ${dest}`);
    }
    console.log(`  Saved ${saved}/${fetched.length} file(s).`);
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
    const sgParts = [];
    for (const s of v.sgCounts) sgParts.push(s.hm ? `${s.hm} (No. ${s.sg}) x${s.count}` : `No. ${s.sg} x${s.count}`);
    L.push(reportKv('PDB space groups', sgParts.join(', ')));
    const shown = v.matches.slice(0, 5);
    if (shown.length) {
        const ids = [];
        for (const m of shown) ids.push(`${m.id} (No. ${m.sg})`);
        L.push(reportKv('Matches', `${ids.join(', ')}${v.total > shown.length ? `, +${v.total - shown.length} more` : ''}`));
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
            if (args.download) {
                await downloadSearchResults(r.results, args);
            }
        } catch (e) {
            console.error(`xrdspace: cell search failed: ${e.message}`);
            process.exit(1);
        }
        process.exit(0);
    }

    if (!args.hklinFiles.length) {
        console.error('xrdspace: no input HKL file given.');
        console.error(HELP);
        process.exit(1);
    }

    // Every --hklin file is a scan of the same crystal (AIMLESS multi-dataset
    // input). The first is the primary for space-group determination; all are
    // concatenated for the analysis, and with --abs each is a scan for the
    // absorption correction. A single file therefore runs single-scan mode.
    const filePaths = [];
    for (const f of args.hklinFiles) filePaths.push(path.resolve(f));
    for (const fp of filePaths) {
        if (!fs.existsSync(fp)) {
            console.error(`xrdspace: file not found: ${fp}`);
            process.exit(1);
        }
    }
    const parsedObjects = [];
    const allReflections = [];
    for (const fp of filePaths) {
        const p = parseHkl(fs.readFileSync(fp, 'utf8'));
        parsedObjects.push(p);
        for (const r of p.reflections) allReflections.push(r);
    }
    const primary = parsedObjects[0];
    const combined = { ...primary, reflections: allReflections };

    let cell = args.cell;
    if (!cell && !primary.cell) {
        console.log('xrdspace: HKL file has no unit-cell parameters.');
        try {
            cell = await promptCell();
        } catch (e) {
            console.error(`xrdspace: ${e.message}`);
            process.exit(1);
        }
    }

    const sfacOpts = args.sfac ? parseSfacInput(args.sfac) : {};

    // Absorption scans: one per --hklin file. Single file -> single-scan mode
    // (symmetry-equivalent reflections, minScans = 1).
    let absScans = null;
    if (args.abs) {
        absScans = [];
        for (const p of parsedObjects) absScans.push({ reflections: p.reflections, orientation: p.orientation });
    }
    const absMinScans = args.absMinScans != null
        ? args.absMinScans
        : (absScans && absScans.length >= 2 ? 2 : 1);

    const result = analyzeParsed(combined, {
        cell,
        spaceGroup: args.spaceGroup,
        laue: args.laue,
        resolution: args.resolution,
        sigThreshold: args.sigThreshold,
        sfac: sfacOpts.sfac,
        unit: sfacOpts.unit,
        chiral: args.chiral,
        quality: true,
        rad: args.rad,
        radMinIsig: args.radMinIsig,
        radEarlyFrac: args.radEarlyFrac,
        radLateFrac: args.radLateFrac,
        radShells: args.radShells,
        abs: args.abs,
        absScans,
        absMinScans,
        absMaxIter: args.absCycles,
        absLmaxEven: args.absOrder,
        absLmaxOdd: Math.max(1, args.absOrder - 1),
        absOutlierSigma: args.absOutlier,
        absRobustLoss: args.absRobust === 'none' ? undefined : args.absRobust,
        absRobust: args.absRobust !== 'none',
        absUseSD: !args.absNoSD,
    });
    if (!result.ok) abortAnalysis(result);

    const dir = path.dirname(filePaths[0]);
    const base = path.parse(filePaths[0]).name;
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

    // Write the corrected/merged HKL files. With --no-write we analyse only
    // and leave the filesystem untouched.
    if (result.merge && !args.noWrite) {
        const shelxPath = path.resolve(args.hklout || path.join(dir, base + '_shelx.hkl'));
        const xdsPath = path.resolve(args.xdsout || path.join(dir, base + '_xds.hkl'));
        const unmergedPath = path.resolve(args.unmergedOut || path.join(dir, base + '_unmerged.hkl'));
        const insPath = path.resolve(args.hklout ? args.hklout.replace(/\.hkl$/i, '.ins') : path.join(dir, base + '_shelx.ins'));
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
        outputFiles.push({ path: shelxPath, note: '(UNMERGED SHELX format, ready for SHELXL/SHELXT)' });
        outputFiles.push({ path: xdsPath, note: '(merged XDS_ASCII)' });
        outputFiles.push({ path: unmergedPath, note: '(UNMERGED XDS_ASCII, all observations)' });
        if (result.merge.inputWasMerged) {
            notes.push('the input was already merged, so the unmerged file has no redundant observations');
        }
        if (result.merge.shelxIns) {
            fs.writeFileSync(insPath, result.merge.shelxIns, 'utf8');
            outputFiles.push({ path: insPath, note: '(SHELX instructions, matching cell/space group)' });
        }
        // Merged MTZ for REFMAC / CCP4 (H K L IMEAN SIGIMEAN F SIGF).
        if (result.merge.mtz) {
            const mtzPath = path.resolve(args.mtzout || path.join(dir, base + '_merged.mtz'));
            fs.writeFileSync(mtzPath, result.merge.mtz);
            outputFiles.push({ path: mtzPath, note: '(merged MTZ: H K L IMEAN SIGIMEAN F SIGF, for REFMAC / CCP4)' });
        }
    }

    // Consolidated report: printed to the console and saved next to the input.
    const logPath = path.resolve(args.log || path.join(dir, 'xrdspace.log'));
    if (!args.noWrite) {
        outputFiles.push({ path: logPath, note: '(this report)' });
    } else {
        notes.push('--no-write in effect: no output files were created (stdout only)');
    }
    const report = buildReport(result, {
        inputPath: filePaths.join(', '),
        outputFiles,
        validationText,
        notes,
    });
    if (!args.noWrite) {
        fs.writeFileSync(logPath, report, 'utf8');
    }
    process.stdout.write('\n' + report);
}

main();
