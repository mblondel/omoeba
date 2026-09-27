/** HAL (hal.science, the French open archive) as a place to find a paper's PDF. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPdfUrl } from '../src/main/download';
import { pdfCandidates } from '../src/main/related';
import { halCandidates, halStampOf, halUrl, sourcePrompt } from '../src/main/sourcefinder';

test('HAL: landing pages lead to their PDF', () => {
  assert.equal(toPdfUrl('https://hal.science/hal-01234567'), 'https://hal.science/hal-01234567/document');
  assert.equal(toPdfUrl('https://hal.science/hal-01234567v2/'), 'https://hal.science/hal-01234567v2/document');
  assert.equal(toPdfUrl('https://inria.hal.science/hal-04567890'), 'https://inria.hal.science/hal-04567890/document');
  assert.equal(toPdfUrl('https://hal.archives-ouvertes.fr/tel-00123456'), 'https://hal.archives-ouvertes.fr/tel-00123456/document');
  // Already a file, or not a paper page: unchanged.
  assert.equal(toPdfUrl('https://hal.science/hal-01234567/file/paper.pdf'), 'https://hal.science/hal-01234567/file/paper.pdf');
  assert.equal(toPdfUrl('https://hal.science/hal-01234567/document'), 'https://hal.science/hal-01234567/document');
  assert.equal(toPdfUrl('https://hal.science/search/index'), 'https://hal.science/search/index');
  assert.match(sourcePrompt({ title: 'T', authors: [], fileName: 'f.pdf', arxivStamp: false, firstPage: '' }), /HAL/);
});

test('HAL: title search keeps exact title matches, with their files and earlier versions', async () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (u: string | URL) => {
    asked.push(String(u));
    const docs = [
      {
        halId_s: 'hal-01234567',
        title_s: ['Optimal Transport for Domain Adaptation'],
        fileMain_s: 'http://hal.science/hal-01234567/file/paper.pdf',
        files_s: ['http://hal.science/hal-01234567/file/paper.pdf', 'http://hal.science/hal-01234567/file/slides.pptx'],
        version_i: 3,
      },
      { halId_s: 'hal-07654321', title_s: ['Optimal transport for domain adaptation: a survey'], fileMain_s: 'https://hal.science/hal-07654321/file/x.pdf' },
      { halId_s: 'hal-01111111', title_s: 'Optimal transport for domain adaptation.' }, // no file listed
    ];
    return new Response(JSON.stringify({ response: { docs } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await halCandidates('Optimal "Transport" for Domain Adaptation'), [
      'https://hal.science/hal-01234567/file/paper.pdf',
      'https://hal.science/hal-01234567v2/document',
      'https://hal.science/hal-01234567v1/document',
      'https://hal.science/hal-01111111/document',
    ]);
    const q = new URL(asked[0]).searchParams;
    assert.equal(q.get('q'), 'title_t:"Optimal Transport for Domain Adaptation"');
    assert.equal(q.get('wt'), 'json');
    // Too short a title to be searched reliably.
    assert.deepEqual(await halCandidates('Paper'), []);
  } finally {
    globalThis.fetch = realFetch;
  }
  // HAL unreachable or failing: no candidates, no error.
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  try {
    assert.deepEqual(await halCandidates('Optimal Transport for Domain Adaptation'), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('HAL: related papers without an arXiv version are looked for on OpenReview and HAL', async () => {
  const paper = { title: 'Optimal Transport for Domain Adaptation', relation: '' };
  const search = {
    arxiv: async () => [],
    openReview: async () => ['https://openreview.net/pdf?id=abc'],
    hal: async () => ['https://hal.science/hal-01234567/file/paper.pdf'],
  };
  assert.deepEqual(await pdfCandidates(paper, search), ['https://openreview.net/pdf?id=abc', 'https://hal.science/hal-01234567/file/paper.pdf']);
  // One of the two failing does not lose the other.
  assert.deepEqual(await pdfCandidates(paper, { ...search, openReview: async () => Promise.reject(new Error('down')) }), [
    'https://hal.science/hal-01234567/file/paper.pdf',
  ]);
  // A reference that links to HAL is tried as is.
  assert.deepEqual(await pdfCandidates({ ...paper, url: 'https://hal.science/hal-01234567' }, search), ['https://hal.science/hal-01234567']);
});


test('HAL: the stamp on the first page names the deposit and version', () => {
  // Margin stamp of older HAL files (as extracted from a real one).
  const margin = 'th potentially taking the value +∞, and a linear operator A from Rp to Rn. We\n1\nhal-00757696, version 1 - 27 Nov 2012';
  assert.deepEqual(halStampOf(margin), { id: 'hal-00757696', version: 1 });
  assert.equal(halUrl({ id: 'hal-00757696', version: 1 }), 'https://hal.science/hal-00757696v1');
  assert.deepEqual(halStampOf('tel-00123456, version 3 - 5 Sept. 2019'), { id: 'tel-00123456', version: 3 });
  // Cover page of newer ones.
  const cover = 'HAL Id: hal-04852612\nhttps://hal.science/hal-04852612v1\nSubmitted on 20 Dec 2024\nHAL is a multi-disciplinary open access archive';
  assert.deepEqual(halStampOf(cover), { id: 'hal-04852612', version: 1 });
  assert.deepEqual(halStampOf('HAL Id: halshs-01234567\nSubmitted on 1 Jan 2020'), { id: 'halshs-01234567' });
  assert.equal(halUrl({ id: 'halshs-01234567' }), 'https://hal.science/halshs-01234567');
  // Not stamped by HAL.
  assert.equal(halStampOf('arXiv:2410.15474v2 [cs.LG] 28 Feb 2025\nA paper about HAL, version 2 of our method'), undefined);
});

test('HAL: a PDF stamped by HAL gets its source from the stamp when no identical copy is online', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { OmoebaService } = await import('../src/main/api');
  const { defaultConfig } = await import('../src/main/config');
  const lib = await mkdtemp(path.join(os.tmpdir(), 'omoeba-hal-'));
  process.env.OMOEBA_HOME = await mkdtemp(path.join(os.tmpdir(), 'omoeba-home-'));
  // A one-page PDF with HAL's margin stamp.
  const lines = ['Duality between subgradient and conditional gradient methods', 'Francis Bach', 'hal-00757696, version 1 - 27 Nov 2012'];
  const content = ['BT', '/F1 12 Tf', '72 720 Td', ...lines.flatMap((l, i) => [i ? '0 -16 Td' : '', `(${l}) Tj`])].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(lib, 'bach.pdf');
  await writeFile(file, pdf);

  const svc = new OmoebaService({
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    emit: () => undefined,
    workerScript: '/nonexistent-worker.js',
  });
  // No AI configured: none must be needed.
  (svc as unknown as { config: unknown }).config = { ...defaultConfig(), folders: [lib], ais: [], defaultAI: null };
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  // HAL answers with its bot check page, as it does for programs.
  globalThis.fetch = (async (u: string | URL) => {
    fetched.push(String(u));
    return new Response('<!doctype html><title>Making sure you&#39;re not a bot!</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  }) as typeof fetch;
  try {
    const { paper, result } = await svc.findSource(file);
    assert.equal(result.identifiedBy, 'hal-stamp');
    assert.equal(result.url, 'https://hal.science/hal-00757696v1');
    assert.deepEqual(paper.sidecar.source, { url: 'https://hal.science/hal-00757696v1', identifiedBy: 'hal-stamp' });
    assert.equal(paper.sidecar.sourceSearch?.found, true);
    // The stamped version was tried for an identical copy first; nothing else was searched.
    assert.deepEqual(fetched, ['https://hal.science/hal-00757696v1/document']);
  } finally {
    globalThis.fetch = realFetch;
    svc.dispose();
    await rm(lib, { recursive: true, force: true });
    await rm(process.env.OMOEBA_HOME!, { recursive: true, force: true });
    delete process.env.OMOEBA_HOME;
  }
});
