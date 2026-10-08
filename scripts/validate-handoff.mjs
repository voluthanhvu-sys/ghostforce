import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const requiredDocs = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CODEMAP.md',
  'PIPELINES.md',
  'CURRENT_STATE.md',
  'VALIDATION.md',
  'AI_INTEGRATIONS.md',
  'CHANGELOG_AI.md',
];
const requiredSource = [
  'ghostforge-server.js',
  'src/ghostforge-app.tsx',
  'server/jobs.js',
  'server/process.js',
  'server/save-dir.js',
  'server/editor-plan.js',
  'server/local-listen-map.js',
  'server/google-stt-retry.js',
  'server/ffmpeg-diagnostics.js',
  'server/ffmpeg-expressions.js',
  'local_listen_diarize.py',
  'pgd_clip.py',
];
const documentedRoutes = [
  '/health',
  '/api/upload',
  '/api/stream/:jobId',
  '/api/edit/job-local',
  '/api/edit/job',
  '/api/edit/stream/:jobId',
  '/api/edit/part-test',
  '/api/edit/part-test/stream/:jobId',
  '/api/reframe/job-local',
  '/api/reframe/job',
  '/api/reframe/stream/:jobId',
  '/api/unique/job-local',
  '/api/unique/held',
  '/api/unique/held/:jobId',
  '/api/unique/pause/:jobId',
  '/api/edit/held',
  '/api/edit/held/:jobId',
  '/api/youtube-import/status',
  '/api/youtube-import',
  '/api/youtube-import/stream/:jobId',
  '/api/youtube-import/hold',
  '/api/youtube-import/:jobId/save',
  '/api/youtube-import/:jobId',
  '/api/youtube-channels',
  '/api/youtube-channels/scan',
  '/api/youtube-channels/known',
  '/api/youtube-channels/:key/folder',
  '/api/youtube-channels/:key/anchor',
  '/api/youtube-channels/:key/concat',
  '/api/youtube-channels/:key',
  '/api/youtube-receipts',
  '/api/youtube-receipts/:id/copy',
  '/api/youtube-receipts/:id',
];
const documentedSymbols = [
  'runEditEncode',
  'geminiGeneratePlan',
  'vertexGeneratePlan',
  'vertexJsonVideo',
  'googleSttWords',
  'runLocalDiarization',
  'cutEditClip',
  'geminiGenerateReframe',
  'vertexGenerateReframe',
];

const failures = [];
const passes = [];
const exists = (rel) => fs.existsSync(path.join(root, rel));

for (const rel of [...requiredDocs, ...requiredSource]) {
  if (exists(rel)) passes.push(`exists: ${rel}`);
  else failures.push(`missing required handoff/source file: ${rel}`);
}

const serverPath = path.join(root, 'ghostforge-server.js');
if (fs.existsSync(serverPath)) {
  const server = fs.readFileSync(serverPath, 'utf8');
  for (const route of documentedRoutes) {
    if (server.includes(`'${route}'`) || server.includes(`\"${route}\"`)) passes.push(`route: ${route}`);
    else failures.push(`CODEMAP/contract route not found in ghostforge-server.js: ${route}`);
  }
  for (const symbol of documentedSymbols) {
    if (server.includes(symbol)) passes.push(`symbol: ${symbol}`);
    else failures.push(`documented backend symbol not found: ${symbol}`);
  }
}

const agentsPath = path.join(root, 'AGENTS.md');
if (fs.existsSync(agentsPath)) {
  const agents = fs.readFileSync(agentsPath, 'utf8');
  const requiredRules = [
    'Never rely on chat history as project documentation',
    'Source-of-truth hierarchy',
    'Documentation impact check',
  ];
  for (const rule of requiredRules) {
    if (agents.includes(rule)) passes.push(`AGENTS rule: ${rule}`);
    else failures.push(`AGENTS.md missing handoff rule/section: ${rule}`);
  }
}

if (failures.length) {
  console.error('Handoff validation FAILED.');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${passes.length} checks passed; ${failures.length} failed.`);
  process.exit(1);
}

console.log(`Handoff validation passed (${passes.length} checks).`);
console.log('Repository contains the required handoff docs, core source files, documented routes/symbols, and maintenance rules.');
