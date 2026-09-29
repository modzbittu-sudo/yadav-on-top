const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { renderHomePage } = require('../views/home');
const { renderTokenFilePage } = require('../views/token-file');

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

test('dashboard page ships valid inline JavaScript', () => {
  const html = renderHomePage();
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'dashboard script must parse');
  assert.doesNotMatch(html, /mic-route|Mic Routing/);
  assert.doesNotMatch(html, /__NEXT__/);
  // Adding is available again: one at a time, in bulk, or by editing the file.
  assert.match(html, /id="tokenInput"/, 'single token field');
  assert.match(html, /id="tokenBulkInput"/, 'bulk paste field');
  assert.match(html, /id="tokenTxtFile"[^>]*accept="\.txt,text\/plain"/, 'text token file picker');
  assert.match(html, /id="addTokenBtn"/);
  assert.match(html, /id="addBulkBtn"/);
  assert.match(html, /id="importTxtBtn"/, 'import tokens from a text file');
  assert.match(html, /Edit tokens\.txt/);
  assert.doesNotMatch(html, /driveSlider|lufsInput|limiterCheck|duckCheck|duckLevel/);
});

test('token file page ships valid inline JavaScript and the add controls', () => {
  const html = renderTokenFilePage();
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'token file script must parse');
  assert.match(html, /id="singleInput"/, 'add one');
  assert.match(html, /id="bulkInput"/, 'add many');
  assert.match(html, /id="fileText"/, 'edit the file');
  assert.match(html, /api\/tokens\/append/);
  assert.match(html, /api\/tokens\/save/);
  assert.doesNotMatch(html, /__NEXT__/);
});

test('pages share the base stylesheet and navigation', () => {
  for (const html of [renderHomePage(), renderTokenFilePage()]) {
    assert.match(html, /body \{ background:#0b1220/, 'styles are inlined');
    assert.match(html, /href="\/"/);
    assert.match(html, /href="\/token-file"/);
    assert.doesNotMatch(html, /mic-route|Mic Routing/);
  }
});
