'use strict';

/* Live test against a real Sky Q box. PRESSES KEYS ON THE BOX.
   Usage: node test/live.js <box-ip>
   Wakes the box, selects ITV (103), then Channel 4 (104), checks the box
   really changed channel, then returns the box to the power state it was in.
   The SIDs checked (ITV1 HD 1209, Channel 4 HD 1202) are from a UK channel list;
   other regions may need different values. */

const assert = require('assert');
const HAP    = require('hap-nodejs');
const plugin = require('..');
const { SkyQClient, SkyQTelevision } = plugin._test;
const C = HAP.Characteristic;

const ip = process.argv[2];
if (!ip) { console.error('Usage: node test/live.js <box-ip>'); process.exit(2); }

class PlatformAccessory {
  constructor(name, uuid, category) {
    this._associatedHAPAccessory = new HAP.Accessory(name, uuid);
    this._associatedHAPAccessory.category = category;
  }
  getService(s) { return this._associatedHAPAccessory.getService(s); }
  addService(...a) { return this._associatedHAPAccessory.addService(...a); }
}
const ts  = () => new Date().toISOString().slice(11, 19);
const say = (m) => console.log(ts() + ' ' + m);
const log = { info: say, warn: (m) => say('WARN ' + m), error: (m) => say('ERROR ' + m), debug: (m) => say('debug ' + m) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (e) { /* retry */ }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for ' + what);
}

(async () => {
  const probe = new SkyQClient(ip);
  const startedOn = SkyQClient.isOn(await probe.getSystemInformation());
  say('box is ' + (startedOn ? 'ON' : 'in STANDBY') + ' at start');

  const tv = new SkyQTelevision({ log, api: { hap: HAP, platformAccessory: PlatformAccessory } }, {
    name: 'Live Test', ipAddress: ip, poll_interval: 5,
    favourites: [{ name: 'BBC One', channel: '101' }, { name: 'ITV', channel: '103' }, { name: 'Channel 4', channel: '104' }],
  });
  const active = tv.tv.getCharacteristic(C.Active);
  const input  = tv.tv.getCharacteristic(C.ActiveIdentifier);
  const sid    = () => probe.getCurrentSid();
  let failed = false;

  try {
    await waitFor(() => tv.on !== null, 15000, 'first poll');
    say('plugin reports Active=' + active.value + ', input=' + input.value);
    assert.strictEqual(tv.on, startedOn, 'plugin power state matches box');

    say('STEP 1: select ITV (103), as HomeKit does from the TV tile (Active=1 + input)');
    await active.handleSetRequest(C.Active.ACTIVE);
    await input.handleSetRequest(2);
    await waitFor(async () => (await sid()) === 1209, 60000, 'box on ITV (SID 1209)');
    assert.strictEqual(SkyQClient.isOn(await probe.getSystemInformation()), true);
    say('PASS box is on and tuned to ITV');

    say('STEP 2: select Channel 4 (104) while on');
    await input.handleSetRequest(3);
    await waitFor(async () => (await sid()) === 1202, 30000, 'box on Channel 4 (SID 1202)');
    say('PASS box tuned to Channel 4');

    say('STEP 3: press "Active=1" while already on (must not toggle to standby)');
    await sleep(16000);  // let the post-command hold expire so the real state is read
    await active.handleSetRequest(C.Active.ACTIVE);
    await sleep(8000);
    assert.strictEqual(SkyQClient.isOn(await probe.getSystemInformation()), true, 'still on');
    say('PASS box stayed on');

    say('STEP 4: polling follows the box channel');
    await waitFor(() => input.value === 3, 20000, 'tile input = Channel 4');
    say('PASS tile shows Channel 4');
  } catch (err) {
    failed = true;
    say('FAIL ' + err.message);
  }

  try {
    const nowOn = SkyQClient.isOn(await probe.getSystemInformation());
    if (nowOn !== startedOn) {
      say('STEP 5: restore power state (' + (startedOn ? 'on' : 'standby') + ')');
      tv._holdUntil = 0;
      await active.handleSetRequest(startedOn ? C.Active.ACTIVE : C.Active.INACTIVE);
      await waitFor(async () => SkyQClient.isOn(await probe.getSystemInformation()) === startedOn, 30000, 'power restored');
      await waitFor(() => active.value === (startedOn ? 1 : 0), 15000, 'tile shows restored state');
      say('PASS box back to ' + (startedOn ? 'on' : 'standby') + ', tile Active=' + active.value);
    }
  } catch (err) {
    failed = true;
    say('FAIL restoring power: ' + err.message);
  }

  say(failed ? 'LIVE TEST FAILED' : 'LIVE TEST PASSED');
  process.exit(failed ? 1 : 0);
})();
