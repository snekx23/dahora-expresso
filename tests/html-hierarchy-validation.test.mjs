import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Validação de Hierarquia DOM de public/index.html', async (t) => {
  const htmlPath = path.resolve(process.cwd(), 'public/index.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');

  await t.test('1. #modal-city está devidamente fechado antes de #modal-request-delivery', () => {
    const cityPos = html.indexOf('<div id="modal-city"');
    const reqPos = html.indexOf('<div id="modal-request-delivery"');
    assert.ok(cityPos > 0 && reqPos > cityPos, '#modal-city deve vir antes de #modal-request-delivery');

    const citySection = html.substring(cityPos, reqPos);
    const openDivs = (citySection.match(/<div[\s>]/g) || []).length;
    const closeDivs = (citySection.match(/<\/div>/g) || []).length;

    assert.equal(openDivs, closeDivs, `#modal-city deve possuir exatamente o mesmo número de <div (${openDivs}) e </div> (${closeDivs})`);
  });

  await t.test('2. #modal-request-delivery está devidamente fechado antes de #modal-add-commercial-client', () => {
    const reqPos = html.indexOf('<div id="modal-request-delivery"');
    const commPos = html.indexOf('<div id="modal-add-commercial-client"');
    assert.ok(reqPos > 0 && commPos > reqPos, '#modal-request-delivery deve vir antes de #modal-add-commercial-client');

    const reqSection = html.substring(reqPos, commPos);
    const openDivs = (reqSection.match(/<div[\s>]/g) || []).length;
    const closeDivs = (reqSection.match(/<\/div>/g) || []).length;

    assert.equal(openDivs, closeDivs, `#modal-request-delivery deve possuir o mesmo número de <div (${openDivs}) e </div> (${closeDivs})`);
  });

  await t.test('3. #modal-add-commercial-client está devidamente fechado antes de #owner-fab-btn', () => {
    const commPos = html.indexOf('<div id="modal-add-commercial-client"');
    const fabPos = html.indexOf('id="owner-fab-btn"');
    assert.ok(commPos > 0 && fabPos > commPos, '#modal-add-commercial-client deve vir antes de #owner-fab-btn');

    const commSection = html.substring(commPos, fabPos);
    const openDivs = (commSection.match(/<div[\s>]/g) || []).length;
    const closeDivs = (commSection.match(/<\/div>/g) || []).length;

    assert.equal(openDivs, closeDivs, `#modal-add-commercial-client deve possuir o mesmo número de <div (${openDivs}) e </div> (${closeDivs})`);
  });
});
