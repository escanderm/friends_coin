const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHelp, renderBalance } = require('../terminal-ui');
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '');
test('terminal guide adapts to narrow windows and respects NO_COLOR and pipes', () => {
  for (const columns of [40, 60, 80, 120]) {
    const text = renderHelp('2.1.0-rc.2', { output: { isTTY: true, columns }, env: {} });
    assert.match(text, /\x1b\[/);
    for (const line of strip(text).split('\n')) assert.ok(Array.from(line).length <= columns, `overflow at ${columns}: ${line}`);
    for (const command of ['balance','address','send','history','nft','mine','stop','friends','info','rules','syncpool','help','exit']) assert.match(strip(text), new RegExp('\\b'+command+'\\b'));
  }
  assert.doesNotMatch(renderHelp('test', { output: { isTTY: false }, env: {} }), /\x1b/);
  assert.doesNotMatch(renderHelp('test', { output: { isTTY: true }, env: { NO_COLOR: '' } }), /\x1b/);
});
test('balance distinguishes saved local state from completed synchronization', () => {
  const user = { wallet: { address: 'public' }, ready: false, blockchain: { getLastBlock: () => ({height:3}), getBalanceUnits: () => 55500, getAvailableBalanceUnits: () => 55500 } };
  assert.match(renderBalance(user), /Локальные данные/);
  assert.match(renderBalance(user), /555\.00 FC/);
  assert.doesNotMatch(renderBalance(user), /Синхронизировано/);
  user.ready = true;
  assert.match(renderBalance(user), /Синхронизировано/);
  assert.doesNotMatch(renderBalance(user), /ожидаем синхронизацию/);
});
