'use strict';

/* Runs the plugin against a fake Sky Q box on localhost (REST, SOAP and the
   TCP remote protocol), using the real HAP-NodeJS characteristics. Nothing
   here talks to a real Sky Q box. */

const assert = require('assert');
const http   = require('http');
const net    = require('net');
const HAP    = require('hap-nodejs');
const plugin = require('..');
const { SkyQClient, SkyQTelevision, parseFavourites, firmwareRevision } = plugin._test;

const CONTROL_PATH = '444D5276-3247-4761-7465-d4dacd523799SkyPlay';
const CHANNELS = [
  { c: '101', t: 'BBC One HD', sid: 3011 },
  { c: '103', t: 'ITV1 HD',    sid: 1209 },
  { c: '104', t: 'Channel 4 HD', sid: 1202 },
  { c: '106', t: 'Sky Showcase', sid: 2075 },
];

/* ---------- fake Sky Q box ---------- */
function fakeBox() {
  const box = { standby: true, sid: 3011, keys: [], digits: '', connections: 0 };

  const rest = http.createServer((req, res) => {
    if (req.url === '/as/system/information') {
      res.end(JSON.stringify({ activeStandby: box.standby, deviceType: 'GATEWAYSTB',
        serialNumber: '0632444027 B', ASVersion: 'Q370.000.09.00-AS_37.2.1' }));
    } else if (req.url === '/as/services/4/1') {
      res.end(JSON.stringify({ services: CHANNELS }));
    } else {
      res.statusCode = 404; res.end();
    }
  });

  const soap = http.createServer((req, res) => {
    if (req.url === '/description2.xml') {
      return res.end('<root><deviceType>urn:schemas-nds-com:device:GatewaySkyControl:2</deviceType>' +
        '<serviceType>urn:schemas-nds-com:service:SkyPlay:2</serviceType>' +
        '<controlURL>/' + CONTROL_PATH + '</controlURL></root>');
    }
    if (req.url === '/description5.xml') {
      return res.end('<root><deviceType>urn:schemas-nds-com:device:GatewaySkyServe:2</deviceType>' +
        '<serviceType>urn:schemas-nds-com:service:SkyPlay:2</serviceType>' +
        '<controlURL>/WRONGSkyPlay</controlURL></root>');
    }
    if (req.method === 'POST' && req.url === '/' + CONTROL_PATH) {
      const uri = box.standby ? '' : 'xsi://' + box.sid.toString(16).toUpperCase();
      return res.end('<s:Envelope><s:Body><CurrentURI>' + uri + '</CurrentURI></s:Body></s:Envelope>');
    }
    res.statusCode = 404; res.end();
  });

  /* Remote: 12-byte version, 1-byte security, 4-byte auth result, 24-byte init,
     then 8-byte key-down + 8-byte key-up. */
  const remote = net.createServer((sock) => {
    box.connections++;
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.write(Buffer.from('SKY 000.001\n'));
    sock.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      const need = [12, 1, 1, 16][stage];
      if (buf.length < need) return;
      const msg = buf.subarray(0, need);
      buf = buf.subarray(need);
      if (stage === 0) { assert.strictEqual(msg.toString(), 'SKY 000.001\n'); sock.write(Buffer.from([1, 1])); }
      if (stage === 1) sock.write(Buffer.from([0, 0, 0, 0]));
      if (stage === 2) sock.write(Buffer.alloc(24));
      if (stage === 3) {
        assert.deepStrictEqual([...msg.subarray(0, 6)], [4, 1, 0, 0, 0, 0], 'key down header');
        assert.deepStrictEqual([...msg.subarray(8, 14)], [4, 0, 0, 0, 0, 0], 'key up header');
        const code = (msg[6] - 224) * 16 + msg[7];
        const name = Object.keys(plugin._test.KEYS).find((k) => plugin._test.KEYS[k] === code);
        box.keys.push(name);
        if (name === 'power') box.standby = !box.standby;
        if (/^\d$/.test(name)) {
          box.digits += name;
          if (box.digits.length === 3) {
            const ch = CHANNELS.find((c) => c.c === box.digits);
            if (ch) box.sid = ch.sid;
            box.digits = '';
          }
        } else {
          box.digits = '';
        }
      }
      stage++;
    });
    sock.on('error', () => {});
  });

  return new Promise((resolve) => {
    let ready = 0;
    const done = () => {
      if (++ready < 3) return;
      box.ports = { rest: rest.address().port, soap: soap.address().port, remote: remote.address().port };
      box.close = () => { rest.close(); soap.close(); remote.close(); };
      resolve(box);
    };
    rest.listen(0, '127.0.0.1', done);
    soap.listen(0, '127.0.0.1', done);
    remote.listen(0, '127.0.0.1', done);
  });
}

/* ---------- minimal Homebridge API ---------- */
class PlatformAccessory {
  constructor(name, uuid, category) {
    this._associatedHAPAccessory = new HAP.Accessory(name, uuid);
    this._associatedHAPAccessory.category = category;
  }
  getService(s) { return this._associatedHAPAccessory.getService(s); }
  addService(...args) { return this._associatedHAPAccessory.addService(...args); }
}
const logs = [];
const log = {
  info:  (m) => logs.push('INFO ' + m),
  warn:  (m) => logs.push('WARN ' + m),
  error: (m) => logs.push('ERROR ' + m),
  debug: () => {},
};
const api = { hap: HAP, platformAccessory: PlatformAccessory };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error('Timed out waiting for ' + what);
}

/* ---------- tests ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const C = HAP.Characteristic;

test('parseFavourites validates and de-duplicates', () => {
  const warn = [];
  const favs = parseFavourites([
    { name: 'BBC One', channel: '101' },
    { name: 'Bad', channel: '1o1' },
    { name: 'Dup', channel: '101' },
    { channel: ' 103 ' },
    { name: 'Long', channel: '12345' },
  ], { warn: (m) => warn.push(m) }, 'Box');
  assert.deepStrictEqual(favs, [
    { id: 1, name: 'BBC One', channel: '101' },
    { id: 2, name: '103', channel: '103' },
  ]);
  assert.strictEqual(warn.length, 2);
  assert.deepStrictEqual(parseFavourites(undefined, log, 'Box'), []);
});

test('firmwareRevision extracts x.y.z', () => {
  assert.strictEqual(firmwareRevision('Q370.000.09.00-AS_37.2.1'), '37.2.1');
  assert.strictEqual(firmwareRevision('weird'), '1.0.0');
});

test('client: power state, discovery skips GatewaySkyServe, current SID, channels, keys', async () => {
  const box = await fakeBox();
  try {
    const client = new SkyQClient('127.0.0.1', box.ports);
    assert.strictEqual(SkyQClient.isOn(await client.getSystemInformation()), false);
    assert.strictEqual(await client.discoverControlPath(), CONTROL_PATH);
    box.standby = false;
    assert.strictEqual(await client.getCurrentSid(), 3011);
    const map = await client.getChannels();
    assert.deepStrictEqual(map.get('1209'), { number: '103', name: 'ITV1 HD' });
    await client.pressKeys(['backup', '1', '0', '3']);
    await waitFor(() => box.keys.length === 4, 2000, 'last key');
    assert.deepStrictEqual(box.keys, ['backup', '1', '0', '3']);
    assert.strictEqual(box.sid, 1209);
    await assert.rejects(client.pressKeys(['nonsense']), /Unknown Sky Q key/);
  } finally { box.close(); }
});

test('client: concurrent key sequences do not interleave', async () => {
  const box = await fakeBox();
  try {
    const client = new SkyQClient('127.0.0.1', box.ports);
    await Promise.all([client.pressKeys(['1', '0', '1']), client.pressKeys(['up', 'down'])]);
    await waitFor(() => box.keys.length === 5, 2000, 'last key');
    assert.deepStrictEqual(box.keys, ['1', '0', '1', 'up', 'down']);
  } finally { box.close(); }
});

function makeTv(box, extra) {
  return new SkyQTelevision({ log, api }, Object.assign({
    name: 'Sky Q', ipAddress: '127.0.0.1', _ports: box.ports, poll_interval: 5, wake_delay: 0,
    favourites: [{ name: 'BBC One', channel: '101' }, { name: 'ITV', channel: '103' }, { name: 'C4', channel: '104' }],
  }, extra));
}

test('television: services, inputs and accessory information', async () => {
  const box = await fakeBox();
  try {
    const tv = makeTv(box);
    const hap = tv.accessory._associatedHAPAccessory;
    assert.strictEqual(hap.category, HAP.Categories.TELEVISION);
    const inputs = hap.services.filter((s) => s.UUID === HAP.Service.InputSource.UUID);
    assert.deepStrictEqual(inputs.map((s) => s.getCharacteristic(C.ConfiguredName).value), ['BBC One', 'ITV', 'C4']);
    assert.deepStrictEqual(inputs.map((s) => s.getCharacteristic(C.Identifier).value), [1, 2, 3]);
    assert.strictEqual(tv.tv.linkedServices.length, 3);
    await waitFor(() => tv._infoSet, 3000, 'first poll');
    assert.strictEqual(tv.info.getCharacteristic(C.Model).value, 'Sky Q');
    assert.strictEqual(tv.info.getCharacteristic(C.FirmwareRevision).value, '37.2.1');
    assert.strictEqual(tv.tv.getCharacteristic(C.Active).value, C.Active.INACTIVE);
    // Information + Television + 3 inputs
    assert.strictEqual(hap.services.length, 5);
  } finally { box.close(); }
});

test('television: turn on, tune favourite, turn off; no double power press', async () => {
  const box = await fakeBox();
  try {
    const tv = makeTv(box);
    await waitFor(() => tv.on === false, 3000, 'standby detected');

    // Selecting an input from standby: HomeKit sends Active=1 and ActiveIdentifier together.
    await tv.tv.getCharacteristic(C.Active).handleSetRequest(C.Active.ACTIVE);
    await tv.tv.getCharacteristic(C.ActiveIdentifier).handleSetRequest(2);
    await waitFor(() => box.keys.length >= 7, 15000, 'power + tune keys');
    await sleep(800);
    assert.deepStrictEqual(box.keys, ['power', 'backup', 'backup', 'backup', '1', '0', '3']);
    assert.strictEqual(box.standby, false);
    assert.strictEqual(box.sid, 1209);
    assert.strictEqual(tv.tv.getCharacteristic(C.Active).value, C.Active.ACTIVE);

    // Turning on again while on must not press power (it would toggle to standby).
    box.keys = [];
    tv._holdUntil = 0;
    await tv.tv.getCharacteristic(C.Active).handleSetRequest(C.Active.ACTIVE);
    await sleep(500);
    assert.deepStrictEqual(box.keys, []);

    // Turn off.
    await tv.tv.getCharacteristic(C.Active).handleSetRequest(C.Active.INACTIVE);
    await waitFor(() => box.keys.length === 1, 3000, 'power off key');
    assert.strictEqual(box.standby, true);
    assert.strictEqual(tv.tv.getCharacteristic(C.Active).value, C.Active.INACTIVE);
  } finally { box.close(); }
});

test('television: wake delay presses sky,backup before dialling', async () => {
  const box = await fakeBox();
  try {
    const tv = makeTv(box, { wake_delay: 1 });
    await waitFor(() => tv.on === false, 3000, 'standby detected');
    await tv.tv.getCharacteristic(C.ActiveIdentifier).handleSetRequest(3);
    await waitFor(() => box.keys.length >= 9, 15000, 'keys');
    await sleep(800);
    assert.deepStrictEqual(box.keys, ['power', 'sky', 'backup', 'backup', 'backup', 'backup', '1', '0', '4']);
    assert.strictEqual(box.sid, 1202);
  } finally { box.close(); }
});

test('television: polling follows the box (remote control used directly)', async () => {
  const box = await fakeBox();
  try {
    box.standby = false;
    box.sid = 1209;  // ITV, favourite id 2
    const tv = makeTv(box);
    await waitFor(() => tv.tv.getCharacteristic(C.ActiveIdentifier).value === 2, 3000, 'ITV selected');
    assert.strictEqual(tv.tv.getCharacteristic(C.Active).value, C.Active.ACTIVE);

    box.sid = 2075;  // not a favourite: selection stays
    box.standby = true;
    tv._poll();
    await waitFor(() => tv.tv.getCharacteristic(C.Active).value === C.Active.INACTIVE, 3000, 'standby');
    assert.strictEqual(tv.tv.getCharacteristic(C.ActiveIdentifier).value, 2);
  } finally { box.close(); }
});

test('television: unreachable box shows as off and logs once', async () => {
  const box = await fakeBox();
  box.close();
  await sleep(100);
  logs.length = 0;
  const tv = makeTv(box);
  await waitFor(() => tv._reachable === false, 8000, 'unreachable');
  assert.strictEqual(tv.tv.getCharacteristic(C.Active).value, C.Active.INACTIVE);
  assert.strictEqual(logs.filter((l) => l.startsWith('WARN')).length, 1);
});

test('remote key mapping', async () => {
  const box = await fakeBox();
  try {
    box.standby = false;
    const tv = makeTv(box);
    const rk = tv.tv.getCharacteristic(C.RemoteKey);
    for (const k of [C.RemoteKey.ARROW_UP, C.RemoteKey.SELECT, C.RemoteKey.BACK,
      C.RemoteKey.PLAY_PAUSE, C.RemoteKey.PLAY_PAUSE, C.RemoteKey.INFORMATION]) {
      await rk.handleSetRequest(k);
    }
    await waitFor(() => box.keys.length === 6, 8000, 'remote keys');
    assert.deepStrictEqual(box.keys, ['up', 'select', 'backup', 'pause', 'play', 'i']);
  } finally { box.close(); }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok   ' + t.name);
    } catch (err) {
      failed++;
      console.log('FAIL ' + t.name + '\n     ' + (err.stack || err));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
