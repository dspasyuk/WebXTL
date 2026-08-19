#!/usr/bin/env node
// jsSpace command-line interface.
// Usage:
//   node src/js/jsSpace/cli.js <file.hkl>
//
// If the HKL file does not carry unit-cell parameters, jsSpace prompts for
// them interactively. Pass --cell "a b c alpha beta gamma" to skip the prompt.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { analyzeHkl } from './index.js';
import { parseHkl } from './hkl-parser.js';

function printAnalysis(result) {
    if (!result.ok) {
        console.error(`jsSpace: ${result.error}`);
        if (result.error === 'NO_CELL') {
            console.error('  The HKL file does not contain unit-cell parameters.');
            console.error('  Run again with --cell "a b c alpha beta gamma" or provide them at the prompt.');
        }
        process.exit(1);
    }

    const s = result.summary;
    const fmt = (x) => (x === null || x === undefined ? '?' : String(x));
    console.log('');
    console.log('==============================================');
    console.log('  jsSpace  —  space-group determination');
    console.log('==============================================');
    console.log(`  Format             : ${s.format}`);
    if (s.title) console.log(`  Title              : ${s.title}`);
    console.log(`  Unit cell          : ${result.cell.a} ${result.cell.b} ${result.cell.c}  ${result.cell.alpha} ${result.cell.beta} ${result.cell.gamma}`);
    if (s.wavelength) console.log(`  Wavelength         : ${s.wavelength}`);
    console.log(`  Reflections        : ${s.nReflections}`);
    console.log(`  Crystal system     : ${s.crystalSystem}${s.uniqueAxis ? ' (unique ' + s.uniqueAxis + ')' : ''}`);
    console.log(`  Lattice centering  : ${s.centering}`);
    console.log(`  Centrosymmetric    : ${s.centricity}  (<|E^2-1|> = ${s.centricityScore.toFixed(3)})`);
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
        console.log(`  Best space group  : ${result.best.hm}  (No. ${result.best.id})`);
    }
    console.log('==============================================');
}

async function promptCell() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(res => rl.question(q, res));
    const a = await ask('Unit cell a b c alpha beta gamma (e.g. 10.5 10.5 14.0 90 90 90): ');
    rl.close();
    const v = a.trim().split(/\s+/).map(parseFloat);
    if (v.length !== 6 || v.some(x => !Number.isFinite(x))) {
        throw new Error('Invalid unit cell. Expected six numbers: a b c alpha beta gamma.');
    }
    return { a: v[0], b: v[1], c: v[2], alpha: v[3], beta: v[4], gamma: v[5] };
}

function parseArgs(argv) {
    const args = { file: null, cell: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--cell' && argv[i + 1]) {
            const v = argv[++i].split(/\s+/).map(parseFloat);
            if (v.length === 6 && v.every(Number.isFinite)) {
                args.cell = { a: v[0], b: v[1], c: v[2], alpha: v[3], beta: v[4], gamma: v[5] };
            } else {
                throw new Error('--cell expects six numbers: a b c alpha beta gamma');
            }
        } else if (!a.startsWith('-')) {
            args.file = a;
        }
    }
    return args;
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`jsSpace: ${e.message}`);
        process.exit(1);
    }
    if (!args.file) {
        console.error('Usage: node src/js/jsSpace/cli.js <file.hkl> [--cell "a b c alpha beta gamma"]');
        process.exit(1);
    }
    const filePath = path.resolve(args.file);
    if (!fs.existsSync(filePath)) {
        console.error(`jsSpace: file not found: ${filePath}`);
        process.exit(1);
    }
    const text = fs.readFileSync(filePath, 'utf8');

    let cell = args.cell;
    if (!cell) {
        const parsed = parseHkl(text);
        if (!parsed.cell) {
            console.log('jsSpace: HKL file has no unit-cell parameters.');
            try {
                cell = await promptCell();
            } catch (e) {
                console.error(`jsSpace: ${e.message}`);
                process.exit(1);
            }
        }
    }

    const result = analyzeHkl(text, { cell });
    printAnalysis(result);
}

main();
