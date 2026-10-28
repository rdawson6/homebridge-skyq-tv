'use strict';

/* Live test of the Channel Up / Down buttons on a real Sky Q box.
   PRESSES KEYS ON THE BOX. Usage: node test/live-buttons.js <box-ip> [--allow-on]
   Refuses to run on a box that is on (it may be in use) unless --allow-on is
   given. Puts the box back in the power state it started in. */

const HAP    = require('hap-nodejs');
const plugin = require('..');
const { SkyQClient, SkyQTelevision } = plugin._test;
const C = HAP.Characteristic;

const ip = process.argv[2];
if (!ip) { console.error('Usage: node test/live-buttons.js <box-ip>'); process.exit(2); }

class PlatformAccessory {
  constructor(name, uuid, category) {
    this._associatedHAPAccessory = new HAP.Accessory(name, uuid);
    this._associatedHAPAccessory.category = category;
  }
  getService(s) { return this._associatedHAPAccessory.getService(s); }
  addService(...a) { return this._associatedHAPAccessory.addService(...a); }
}
const t0  = Date.now();
const say = (m) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's ' + m);
const log = { info: say, warn: say, error: say, debug: say };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const probe = new SkyQClient(ip);
  const startedOn = SkyQClient.isOn(await probe.getSystemInformation());
  if (startedOn && !process.argv.includes('--allow-on')) {
    say('box is on (maybe being watched), not testing. Use --allow-on to override.');
    process.exit(1);
  }
  say('box is ' + (startedOn ? 'ON' : 'in STANDBY') + ' at start');
  const channels = await probe.getChannels();
  const chan = async () => {
    const sid = await probe.getCurrentSid();
    const c = sid !== null && channels.get(String(sid));
    return c ? c.number + ' ' + c.name : String(sid);
  };

  const tv = new SkyQTelevision({ log, api: { hap: HAP, platformAccessory: PlatformAccessory } }, {
    name: 'Live', ipAddress: ip, poll_interval: 5,
    favourites: [{ name: 'BBC One', channel: '101' }, { name: 'BBC Two', channel: '102' }],
  });
  const hap   = tv.accessory._associatedHAPAccessory;
  const up    = hap.getServiceById(HAP.Service.Switch, 'channel-up').getCharacteristic(C.On);
  const down  = hap.getServiceById(HAP.Service.Switch, 'channel-down').getCharacteristic(C.On);
  const active = tv.tv.getCharacteristic(C.Active);
  const input  = tv.tv.getCharacteristic(C.ActiveIdentifier);
  let ok = true;
  const check = (cond, msg) => { say((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) ok = false; };

  try {
    await sleep(2000);
    if (!startedOn) {
      say('STEP 1: Channel Up while in standby (should do nothing)');
      await up.handleSetRequest(true);
      await sleep(3000);
      check(!SkyQClient.isOn(await probe.getSystemInformation()), 'box still in standby');
      check(up.value === false, 'button reset');
    } else {
      say('STEP 1: skipped (box started on)');
    }

    say('STEP 2: wake onto BBC One (101)');
    await active.handleSetRequest(1);
    await input.handleSetRequest(1);
    for (let i = 0; i < 60 && (await probe.getCurrentSid()) !== 3011; i++) await sleep(1000);
    say('box on ' + (await chan()));

    say('STEP 3: Channel Up');
    await up.handleSetRequest(true);
    await sleep(5000);
    const afterUp = await chan();
    check(afterUp.startsWith('102'), 'Channel Up -> ' + afterUp);
    check(input.value === 2, 'tile shows BBC Two (input ' + input.value + ')');
    check(up.value === false, 'button reset');

    say('STEP 4: Channel Down');
    await down.handleSetRequest(true);
    await sleep(5000);
    const afterDown = await chan();
    check(afterDown.startsWith('101'), 'Channel Down -> ' + afterDown);
    check(input.value === 1, 'tile shows BBC One (input ' + input.value + ')');
  } catch (err) {
    ok = false;
    say('FAIL ' + err.message);
  }

  if (!startedOn) {
    await sleep(16000);
    tv._holdUntil = 0;
    await active.handleSetRequest(0);
    await sleep(5000);
  }
  const on = SkyQClient.isOn(await probe.getSystemInformation());
  check(on === startedOn, 'box left ' + (on ? 'on' : 'in standby') + ', as it started');
  say(ok ? 'LIVE TEST PASSED' : 'LIVE TEST FAILED');
  process.exit(ok ? 0 : 1);
})();
