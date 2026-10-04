/** LaTeX: the main file, latexmk's arguments, the log, SyncTeX's answers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRoot, latexInfo, latexmkArgs, magicComment, parseLatexLog, parseSynctexEdit, parseSynctexView } from '../src/main/latex';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'omoeba-latex-'));

test('latex: the main file of a document', async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, 'sections'));
  await writeFile(path.join(dir, 'main.tex'), '% comment\n\\documentclass{article}\n\\begin{document}\\input{sections/intro}\\end{document}\n');
  await writeFile(path.join(dir, 'macros.tex'), '\\newcommand{\\R}{\\mathbb{R}} % not \\documentclass{x}\n');
  await writeFile(path.join(dir, 'sections', 'intro.tex'), '\\section{Intro}\n');
  await writeFile(path.join(dir, 'sections', 'magic.tex'), '% !TEX root = ../main.tex\n\\section{M}\n');
  await writeFile(path.join(dir, 'sections', 'magic2.tex'), '%!TeX root=../main\n');
  assert.equal(await findRoot(path.join(dir, 'main.tex')), path.join(dir, 'main.tex'));
  assert.equal(await findRoot(path.join(dir, 'macros.tex')), path.join(dir, 'main.tex'), 'commented \\documentclass ignored');
  assert.equal(await findRoot(path.join(dir, 'sections', 'intro.tex')), path.join(dir, 'main.tex'), 'found in the folder above');
  assert.equal(await findRoot(path.join(dir, 'sections', 'magic.tex')), path.join(dir, 'main.tex'));
  assert.equal(await findRoot(path.join(dir, 'sections', 'magic2.tex')), path.join(dir, 'main.tex'), '.tex added');

  // Two main files: the user says which.
  await writeFile(path.join(dir, 'slides.tex'), '\\documentclass{beamer}\n');
  await assert.rejects(findRoot(path.join(dir, 'macros.tex')), /TEX root/);

  const info = await latexInfo(path.join(dir, 'main.tex'));
  assert.deepEqual(info, { root: path.join(dir, 'main.tex'), pdf: path.join(dir, 'main.pdf'), rc: null });
  await writeFile(path.join(dir, '.latexmkrc'), '$pdf_mode = 5;\n');
  assert.equal((await latexInfo(path.join(dir, 'main.tex'))).rc, path.join(dir, '.latexmkrc'));
});

test('latex: magic comments and latexmk arguments', () => {
  assert.equal(magicComment('% !TEX program = xelatex\n', 'program'), 'xelatex');
  assert.equal(magicComment('% !TEX TS-program = lualatex\n', 'program'), 'lualatex');
  assert.equal(magicComment('\\documentclass{x}\n', 'program'), null);
  const base = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-no-shell-escape', '-auxdir=.build', '-outdir=.build'];
  assert.deepEqual(latexmkArgs('/p/main.tex', { program: null, rc: null, rcText: '', useRc: false }), [...base, '-pdf', 'main.tex']);
  assert.deepEqual(latexmkArgs('/p/main.tex', { program: 'XeLaTeX', rc: null, rcText: '', useRc: false }), [...base, '-pdfxe', 'main.tex']);
  // A latexmkrc: not used unless allowed; used, it may choose the engine.
  assert.deepEqual(latexmkArgs('/p/main.tex', { program: null, rc: '/p/latexmkrc', rcText: '$pdf_mode = 5;', useRc: false }), [...base, '-norc', '-pdf', 'main.tex']);
  assert.deepEqual(latexmkArgs('/p/main.tex', { program: null, rc: '/p/latexmkrc', rcText: '$pdf_mode = 5;', useRc: true }), [...base, 'main.tex']);
  assert.deepEqual(latexmkArgs('/p/main.tex', { program: null, rc: '/p/latexmkrc', rcText: '$out_dir = "x";', useRc: true }), [...base, '-pdf', 'main.tex']);
});

const LOG = `This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024) (preloaded format=pdflatex 2024.1.1)
(./main.tex
LaTeX2e <2023-11-01>
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/size10.clo))
(.build/main.aux) (see the transcript file (for details))
(./sections/intro.tex
./sections/intro.tex:12: Undefined control sequence.
l.12 We use \\foo
                  here.

LaTeX Warning: Reference \`sec:x' on page 1 undefined on input line 14.

) [1]
./main.tex:20: LaTeX Error: Environment theorem undefined.

See the LaTeX manual or LaTeX Companion for explanation.
l.20 \\begin{theorem}

Package natbib Warning: Citation \`bach15' on page 2 undefined on input line 25.

LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.

Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing \`math shift' on input line 30.

LaTeX Warning: There were undefined references.

)
! Emergency stop.
<*> main.tex
`;

test('latex: errors and warnings of the log, with their files and lines', () => {
  const p = parseLatexLog(LOG, '/paper');
  assert.deepEqual(p, [
    { severity: 'error', file: '/paper/sections/intro.tex', line: 12, message: 'Undefined control sequence. — We use \\foo' },
    { severity: 'warning', file: '/paper/sections/intro.tex', line: 14, message: "Reference `sec:x' on page 1 undefined" },
    { severity: 'error', file: '/paper/main.tex', line: 20, message: 'LaTeX Error: Environment theorem undefined. — \\begin{theorem}' },
    { severity: 'warning', file: '/paper/main.tex', line: 25, message: "natbib: Citation `bach15' on page 2 undefined" },
    { severity: 'warning', file: '/paper/main.tex', line: 30, message: "hyperref: Token not allowed in a PDF string (Unicode): removing `math shift'" },
    { severity: 'warning', file: null, line: null, message: 'There were undefined references' },
    { severity: 'error', file: null, line: null, message: 'Emergency stop.' },
  ]);
});

test('synctex: answers of synctex view and synctex edit', () => {
  const view = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/paper/./main.pdf
Page:2
x:133.768356
y:280.191162
h:133.768356
v:281.987061
W:343.711060
H:8.966995
before:
offset:0
middle:
after:
Output:/paper/./main.pdf
Page:2
x:1
y:2
h:3
v:4
W:5
H:6
SyncTeX result end
`;
  assert.deepEqual(parseSynctexView(view), { page: 2, x: 133.768356, y: 280.191162, h: 133.768356, v: 281.987061, width: 343.71106, height: 8.966995 });
  assert.equal(parseSynctexView('SyncTeX ERROR: no record'), null);
  const edit = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:main.pdf
Input:/paper/./sections/intro.tex
Line:12
Column:-1
Offset:0
Context:
SyncTeX result end
`;
  assert.deepEqual(parseSynctexEdit(edit, '/paper'), { file: '/paper/sections/intro.tex', line: 12, column: 0 });
  assert.deepEqual(parseSynctexEdit(edit.replace('/paper/./sections', './sections'), '/paper'), { file: '/paper/sections/intro.tex', line: 12, column: 0 });
  assert.equal(parseSynctexEdit('nothing', '/paper'), null);
});
