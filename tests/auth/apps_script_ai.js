// Runs the real apps-script/Код.js AI actions in a Node vm (FIRESTORE_PLAN.md
// stage 7) so the Python port in functions-auth/ai.py can be checked against
// them byte for byte, and its prompt texts regenerated from them.
//
//   node apps_script_ai.js prompts
//       prints the prompt texts functions-auth/ai_prompts.json holds
//   node apps_script_ai.js run <action> <body.json> <anthropic-reply.json> [status]
//       prints {request:{payload, headers}, result} — what Apps Script would
//       send to Anthropic for that body, and what it would return for that reply
const vm = require('vm'), fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', '..', 'apps-script', 'Код.js');

function load(reply, status) {
  const sent = [];
  const ctx = {
    PropertiesService: {getScriptProperties: () => ({getProperty: k => (k === 'ANTHROPIC_API_KEY' ? 'KEY' : null)})},
    UrlFetchApp: {fetch: (url, opts) => {
      sent.push({url, payload: JSON.parse(opts.payload), headers: opts.headers});
      return {getContentText: () => reply, getResponseCode: () => status};
    }},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
  return {ctx, sent};
}

function run(action, body, reply = '{"content":[{"type":"text","text":"{}"}]}', status = 200) {
  const {ctx, sent} = load(reply, status);
  const result = JSON.parse(JSON.stringify(ctx[action](body)));
  const req = sent[0] ? {url: sent[0].url, payload: sent[0].payload, headers: sent[0].headers} : null;
  return {request: req, result};
}

function systemText(action, body) { return run(action, body).request.payload.messages[0].content[0].text; }

function prompts() {
  const img = {image: 'I'};
  const verifyField = {};
  for (const k of ['digits9', 'date', 'passportNo', '*']) verifyField[k] = systemText('aiVerifyField', Object.assign({kind: k === '*' ? 'unknown-kind' : k}, img));
  const kinds = {};
  for (const k of ['digits9', 'date', 'passportNo', '*']) {
    const c = run('aiVerifyFields', {jobs: [{field: 'F', kind: k === '*' ? 'unknown-kind' : k, image: 'I'}]}).request.payload.messages[0].content;
    kinds[k] = c[1].text.replace(/^Field "F": /, '').replace(/\.$/, '');
  }
  const head = run('aiVerifyFields', {jobs: Array.from({length: 7}, (_, i) => ({field: 'F' + i, kind: 'date', image: 'I'}))}).request.payload.messages[0].content[0].text;
  const at = head.indexOf(' 7 images');
  return {
    _source: 'Generated from apps-script/Код.js by tests/auth/apps_script_ai.js — do not edit by hand.',
    readDoc: systemText('aiReadDoc', img),
    readSefach: systemText('aiReadSefach', img),
    detectAlign: systemText('aiDetectAlign', img),
    readHoursTable: systemText('aiReadHoursTable', img),
    verifyField,
    verifyFieldsHead: [head.slice(0, at + 1), head.slice(at + 2)],
    verifyFieldsKind: kinds,
  };
}

if (require.main === module) {
  const [cmd, action, bodyFile, replyFile, status] = process.argv.slice(2);
  if (cmd === 'prompts') process.stdout.write(JSON.stringify(prompts(), null, 1) + '\n');
  else if (cmd === 'run') process.stdout.write(JSON.stringify(run(action, JSON.parse(fs.readFileSync(bodyFile, 'utf8')),
    fs.readFileSync(replyFile, 'utf8'), Number(status || 200))));
  else { console.error('usage: prompts | run <action> <body.json> <reply.json> [status]'); process.exit(2); }
}
