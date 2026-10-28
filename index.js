'use strict';

const net  = require('net');
const http = require('http');

const PLUGIN_NAME   = 'homebridge-skyq-tv';
const PLATFORM_NAME = 'SkyQTV';

/* Sky Q remote key codes, sent over TCP port 49160.
   Same codes as the sky-remote library used by homebridge-sky-q-no-logs. */
const KEYS = {
  power: 0, select: 1, backup: 2, channelup: 6, channeldown: 7,
  sidebar: 8, help: 9, search: 10, home: 11, i: 14, text: 15,
  up: 16, down: 17, left: 18, right: 19,
  red: 32, green: 33, yellow: 34, blue: 35,
  0: 48, 1: 49, 2: 50, 3: 51, 4: 52, 5: 53, 6: 54, 7: 55, 8: 56, 9: 57,
  play: 64, pause: 65, stop: 66, record: 67, fastforward: 69, rewind: 71,
  boxoffice: 240, sky: 241,
};

const KEY_GAP_MS          = 500;    // pause between key presses (matches sky-remote)
const SOAP_RETRY_MS       = 5 * 60 * 1000;
const CHANNEL_RELOAD_MS   = 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, SkyQTVPlatform);
};

const DEFAULT_PORTS = { rest: 9006, soap: 49153, remote: 49160 };

/* =============================================================================
   Sky Q network client
   - REST   port 9006  : /as/system/information (power), /as/services/4/1 (channels)
   - SOAP   port 49153 : SkyPlay GetMediaInfo (current channel SID)
   - Remote port 49160 : key presses
   ============================================================================= */
class SkyQClient {
  constructor(ip, ports) {
    this.ip           = ip;
    this.ports        = Object.assign({}, DEFAULT_PORTS, ports);
    this.controlPath  = null;
    this._keyQueue    = Promise.resolve();
  }

  _request({ port, path, method = 'GET', headers = {}, body, timeout = 5000 }) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.ip, port, path, method,
        headers: Object.assign({ 'User-Agent': 'SKYPLUS_skyplus' }, headers),
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.setTimeout(timeout, () => req.destroy(new Error('Timeout talking to ' + this.ip + ':' + port)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async _getJSON(path) {
    const res = await this._request({ port: this.ports.rest, path: '/as/' + path });
    if (res.status !== 200) throw new Error('HTTP ' + res.status + ' from /as/' + path);
    return JSON.parse(res.body);
  }

  async getSystemInformation() {
    return this._getJSON('system/information');
  }

  /* true = on, false = standby */
  static isOn(info) {
    if (!info || typeof info.activeStandby !== 'boolean') {
      throw new Error("Unexpected value for 'activeStandby'");
    }
    return !info.activeStandby;
  }

  /* Map of SID -> { number, name } */
  async getChannels() {
    const data = await this._getJSON('services/4/1');
    const map = new Map();
    for (const s of (data && data.services) || []) {
      if (s.sid) map.set(String(s.sid), { number: String(s.c || ''), name: String(s.t || '') });
    }
    return map;
  }

  /* Find the SkyPlay control URL on the GatewaySkyControl (Sky Q) or
     MRSkyControl (Sky Q Mini) device. GatewaySkyServe rejects GetMediaInfo. */
  async discoverControlPath() {
    for (let i = 0; i <= 24; i++) {
      let res;
      try {
        res = await this._request({ port: this.ports.soap, path: '/description' + i + '.xml', timeout: 2000 });
      } catch (err) {
        continue;
      }
      const xml = res.body || '';
      if (xml.includes('SkyPlay:2') &&
          (xml.includes('GatewaySkyControl') || xml.includes('MRSkyControl'))) {
        const match = xml.match(/<controlURL>\/([^<]*SkyPlay[^<]*)<\/controlURL>/);
        if (match) {
          this.controlPath = match[1];
          return this.controlPath;
        }
      }
    }
    throw new Error('SkyPlay control URL not found');
  }

  /* Current channel SID, or null (standby, recording, app, etc.) */
  async getCurrentSid() {
    if (!this.controlPath) await this.discoverControlPath();
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
      '<u:GetMediaInfo xmlns:u="urn:schemas-nds-com:service:SkyPlay:2">' +
      '<InstanceID>0</InstanceID></u:GetMediaInfo></s:Body></s:Envelope>';
    const res = await this._request({
      port: this.ports.soap,
      path: '/' + this.controlPath,
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'text/xml',
        'SOAPACTION': '"urn:schemas-nds-com:service:SkyPlay:2#GetMediaInfo"',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    if (res.status !== 200) {
      this.controlPath = null;   // rediscover next time
      throw new Error('SOAP HTTP ' + res.status);
    }
    const uri   = (res.body.match(/<CurrentURI>(.*?)<\/CurrentURI>/) || [])[1] || '';
    const match = uri.match(/^xsi:\/\/([0-9a-fA-F]+)/);
    return match ? parseInt(match[1], 16) : null;
  }

  /* Press a sequence of keys. Sequences are queued so they never interleave. */
  pressKeys(keys) {
    const run = async () => {
      for (let i = 0; i < keys.length; i++) {
        const code = KEYS[keys[i]];
        if (code === undefined) throw new Error('Unknown Sky Q key "' + keys[i] + '"');
        await this._sendKey(code);
        if (i < keys.length - 1) await sleep(KEY_GAP_MS);
      }
    };
    const result = this._keyQueue.then(run, run);
    this._keyQueue = result.catch(() => {});
    return result;
  }

  /* One key press. Handshake reproduced from the sky-remote library:
     echo the box's short greeting messages back, then send key-down and key-up. */
  _sendKey(code) {
    return new Promise((resolve, reject) => {
      const down = Buffer.from([4, 1, 0, 0, 0, 0, 224 + Math.floor(code / 16), code % 16]);
      const up   = Buffer.from(down);
      up[1] = 0;

      const sock = net.connect({ host: this.ip, port: this.ports.remote });
      let echoLen = 12;
      let done    = false;

      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          sock.destroy();
          reject(err);
        } else {
          // Half-close so the box reads both bytes before the socket goes away.
          sock.end();
          setTimeout(() => sock.destroy(), 1000).unref();
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error('Remote timeout ' + this.ip + ':' + this.ports.remote)), 3000);

      sock.on('data', (data) => {
        if (done) return;
        if (data.length < 24) {
          sock.write(data.subarray(0, echoLen));
          echoLen = 1;
        } else {
          sock.write(down, () => sock.write(up, () => finish()));
        }
      });
      sock.on('error', finish);
      sock.on('close', () => finish(new Error('Remote connection closed before key was sent')));
    });
  }
}

/* =============================================================================
   Platform
   Television accessories are published as external accessories. iOS only shows
   one TV per bridge properly, so each box is added to Home separately using
   the bridge PIN.
   ============================================================================= */
class SkyQTVPlatform {
  constructor(log, config, api) {
    this.log    = log;
    this.config = config || {};
    this.api    = api;

    if (!api) return;
    api.on('didFinishLaunching', () => this._setup());
  }

  /* Required for platform plugins. External accessories are not cached. */
  configureAccessory() {}

  _setup() {
    const boxes = Array.isArray(this.config.boxes) ? this.config.boxes : [];
    if (boxes.length === 0) {
      this.log.warn('No Sky Q boxes configured.');
      return;
    }
    const seen = new Set();
    const accessories = [];
    for (const box of boxes) {
      if (!box || !box.ipAddress) {
        this.log.error('Skipping a Sky Q box with no IP address.');
        continue;
      }
      if (seen.has(box.ipAddress)) {
        this.log.error('Skipping duplicate Sky Q box ' + box.ipAddress + '.');
        continue;
      }
      seen.add(box.ipAddress);
      const tv = new SkyQTelevision(this, box);
      accessories.push(tv.accessory);
    }
    if (accessories.length) {
      this.api.publishExternalAccessories(PLUGIN_NAME, accessories);
    }
  }
}

/* =============================================================================
   Television accessory (one per box)
   Active          -> standby / on, using the power key
   ActiveIdentifier -> favourite channels (InputSource services)
   RemoteKey       -> iOS Control Centre remote
   ============================================================================= */
class SkyQTelevision {
  constructor(platform, config) {
    const { Service, Characteristic, uuid } = platform.api.hap;
    this.log            = platform.log;
    this.Characteristic = Characteristic;

    this.name         = config.name || 'Sky Q';
    this.ip           = config.ipAddress;
    this.pollMs       = clamp(config.poll_interval, 5, 60, 10) * 1000;
    this.wakeDelayMs  = clamp(config.wake_delay, 0, 60, 20) * 1000;
    this.client       = new SkyQClient(this.ip, config._ports);
    this.favourites   = parseFavourites(config.favourites, this.log, this.name);

    this.on           = null;   // null = unknown
    this.activeId     = this.favourites.length ? this.favourites[0].id : 0;
    this._holdUntil   = 0;      // ignore polled state until this time (after our own commands)
    this._reachable   = null;
    this._infoSet     = false;
    this._channels    = null;
    this._channelsAt  = 0;
    this._soapRetryAt = 0;
    this._paused      = false;
    this._actions     = Promise.resolve();

    const accessory = new platform.api.platformAccessory(
      this.name,
      uuid.generate(PLUGIN_NAME + ':' + this.ip),
      platform.api.hap.Categories.TELEVISION
    );
    this.accessory = accessory;

    this.info = accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Sky')
      .setCharacteristic(Characteristic.Model, 'Sky Q')
      .setCharacteristic(Characteristic.SerialNumber, this.ip);

    const tv = accessory.addService(Service.Television, this.name);
    this.tv = tv;
    tv.setCharacteristic(Characteristic.ConfiguredName, this.name);
    tv.setCharacteristic(Characteristic.SleepDiscoveryMode,
      Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    tv.getCharacteristic(Characteristic.Active)
      .onGet(() => (this.on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE))
      .onSet((value) => {
        const wantOn = value === Characteristic.Active.ACTIVE;
        this._enqueue(() => this._setPower(wantOn));
      });

    tv.getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.activeId)
      .onSet((value) => {
        const fav = this.favourites.find((f) => f.id === value);
        if (!fav) return;
        this.activeId = value;
        this._enqueue(() => this._tuneTo(fav));
      });

    tv.getCharacteristic(Characteristic.RemoteKey)
      .onSet((value) => this._remoteKey(value));

    for (const fav of this.favourites) {
      const input = accessory.addService(Service.InputSource, fav.name, 'channel-' + fav.id);
      input
        .setCharacteristic(Characteristic.Identifier, fav.id)
        .setCharacteristic(Characteristic.ConfiguredName, fav.name)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.TUNER)
        .setCharacteristic(Characteristic.CurrentVisibilityState,
          Characteristic.CurrentVisibilityState.SHOWN);
      tv.addLinkedService(input);
    }
    tv.updateCharacteristic(Characteristic.ActiveIdentifier, this.activeId);

    this.log.info('[' + this.name + '] ' + this.ip + ' with ' + this.favourites.length + ' favourite channel(s)');
    setImmediate(() => this._poll());
  }

  /* Run user actions one at a time so power + channel requests from the same
     tap (HomeKit sends both) don't press the power key twice. */
  _enqueue(fn) {
    const run = () => fn().catch((err) => this.log.error('[' + this.name + '] ' + err.message));
    this._actions = this._actions.then(run, run);
  }

  _updateActive(on) {
    if (this.on === on) return;
    this.on = on;
    this.log.debug('[' + this.name + '] ' + (on ? 'on' : 'standby'));
    const { Active } = this.Characteristic;
    this.tv.updateCharacteristic(Active, on ? Active.ACTIVE : Active.INACTIVE);
  }

  /* Box power state. Trusts our own recent command while the box is waking,
     because the box can still report standby for a few seconds. */
  async _isOn() {
    if (Date.now() < this._holdUntil && this.on !== null) return this.on;
    const on = SkyQClient.isOn(await this.client.getSystemInformation());
    this._updateActive(on);
    return on;
  }

  async _setPower(wantOn) {
    const isOn = await this._isOn();
    if (isOn === wantOn) return;

    await this.client.pressKeys(['power']);
    this._holdUntil = Date.now() + this.wakeDelayMs + 15000;
    this._updateActive(wantOn);

    if (wantOn) {
      if (this.wakeDelayMs > 0) {
        await sleep(this.wakeDelayMs);
        await this.client.pressKeys(['sky', 'backup']);
        await sleep(1000);
      } else {
        await sleep(3000);
      }
    }
  }

  async _tuneTo(fav) {
    await this._setPower(true);
    await this.client.pressKeys(['backup', 'backup', 'backup'].concat(fav.channel.split('')));
    this._holdUntil = Math.max(this._holdUntil, Date.now() + 5000);
    this.log.debug('[' + this.name + '] tuned to ' + fav.channel + ' ' + fav.name);
  }

  _remoteKey(value) {
    const K = this.Characteristic.RemoteKey;
    const map = {
      [K.ARROW_UP]: 'up',
      [K.ARROW_DOWN]: 'down',
      [K.ARROW_LEFT]: 'left',
      [K.ARROW_RIGHT]: 'right',
      [K.SELECT]: 'select',
      [K.BACK]: 'backup',
      [K.EXIT]: 'sky',
      [K.INFORMATION]: 'i',
      [K.REWIND]: 'rewind',
      [K.FAST_FORWARD]: 'fastforward',
      [K.NEXT_TRACK]: 'channelup',
      [K.PREVIOUS_TRACK]: 'channeldown',
    };
    let key = map[value];
    if (value === K.PLAY_PAUSE) {
      key = this._paused ? 'play' : 'pause';
      this._paused = !this._paused;
    }
    if (!key) return;
    this.client.pressKeys([key])
      .catch((err) => this.log.error('[' + this.name + '] remote key failed: ' + err.message));
  }

  async _poll() {
    try {
      const info = await this.client.getSystemInformation();
      const on   = SkyQClient.isOn(info);
      this._setReachable(true);
      this._setInfo(info);
      if (Date.now() >= this._holdUntil) {
        this._updateActive(on);
        if (on) await this._syncChannel();
      }
    } catch (err) {
      this._setReachable(false, err);
      if (Date.now() >= this._holdUntil) this._updateActive(false);
    } finally {
      setTimeout(() => this._poll(), this.pollMs);
    }
  }

  /* Point the TV tile at the favourite matching the channel the box is on.
     Channels that aren't favourites leave the selection unchanged. */
  async _syncChannel() {
    if (this.favourites.length === 0) return;
    if (!this.client.controlPath && Date.now() < this._soapRetryAt) return;

    let sid;
    try {
      sid = await this.client.getCurrentSid();
    } catch (err) {
      this._soapRetryAt = Date.now() + SOAP_RETRY_MS;
      this.log.debug('[' + this.name + '] channel lookup failed: ' + err.message);
      return;
    }
    if (sid === null) return;

    const key = String(sid);
    const stale = Date.now() - this._channelsAt > CHANNEL_RELOAD_MS;
    if (!this._channels || (stale && !this._channels.has(key))) {
      try {
        this._channels   = await this.client.getChannels();
        this._channelsAt = Date.now();
      } catch (err) {
        this.log.debug('[' + this.name + '] channel list failed: ' + err.message);
        return;
      }
    }

    const channel = this._channels.get(key);
    if (!channel) return;
    const fav = this.favourites.find((f) => f.channel === channel.number);
    if (fav && fav.id !== this.activeId) {
      this.activeId = fav.id;
      this.tv.updateCharacteristic(this.Characteristic.ActiveIdentifier, fav.id);
    }
  }

  _setInfo(info) {
    if (this._infoSet) return;
    this._infoSet = true;
    const C = this.Characteristic;
    const model = info.deviceType === 'MULTIROOMSTB' ? 'Sky Q Mini' : 'Sky Q';
    this.info.updateCharacteristic(C.Model, model);
    if (info.serialNumber) this.info.updateCharacteristic(C.SerialNumber, String(info.serialNumber).trim());
    if (info.ASVersion) this.info.updateCharacteristic(C.FirmwareRevision, firmwareRevision(info.ASVersion));
  }

  _setReachable(ok, err) {
    if (this._reachable === ok) return;
    const first = this._reachable === null;
    this._reachable = ok;
    if (!ok) this.log.warn('[' + this.name + '] not reachable at ' + this.ip + ': ' + (err && err.message));
    else if (!first) this.log.info('[' + this.name + '] reachable again');
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* FirmwareRevision must look like x.y.z. "Q370.000.09.00-AS_37.2.1" -> "37.2.1" */
function firmwareRevision(asVersion) {
  const m = String(asVersion).match(/(\d+)\.(\d+)\.(\d+)\s*$/);
  return m ? m[1] + '.' + m[2] + '.' + m[3] : '1.0.0';
}

function parseFavourites(list, log, boxName) {
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    const channel = String((item && item.channel) || '').trim();
    if (!/^\d{3,4}$/.test(channel)) {
      log.warn('[' + boxName + '] ignoring favourite with invalid channel "' + channel + '"');
      continue;
    }
    if (result.some((f) => f.channel === channel)) continue;
    const name = String((item && item.name) || channel).trim() || channel;
    result.push({ id: result.length + 1, name, channel });
  }
  return result;
}

/* Exposed for the tests in test/ only. */
module.exports._test = { SkyQClient, SkyQTVPlatform, SkyQTelevision, parseFavourites, firmwareRevision, KEYS };
