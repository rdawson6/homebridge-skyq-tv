# homebridge-skyq-tv

A Homebridge plugin that shows each Sky Q box (main box or Sky Q Mini) as a TV in the Apple Home app.

- **Power**: the TV tile switches the box between on and standby. The tile shows the box's real state, including changes made with the Sky remote.
- **Favourite channels**: each favourite appears as an input on the TV tile. Selecting one wakes the box if needed and dials the channel.
- **Current channel**: if the box is on a favourite channel, the tile shows it, even if the channel was changed with the Sky remote.
- **Control Centre remote**: arrows, select, back, play/pause, info, rewind and fast forward.
- **Channel Up / Down buttons**: two buttons inside the TV accessory. Each press changes channel once, then the button turns itself off. They do nothing while the box is in standby.

It replaces the switches made by `homebridge-sky-q-no-logs`. That plugin can only press keys and cannot turn a box off from a channel switch.

## Configuration

```json
{
  "platform": "SkyQTV",
  "name": "Sky Q TV",
  "boxes": [
    {
      "name": "Sky Q",
      "ipAddress": "192.168.1.10",
      "favourites": [
        { "name": "BBC One", "channel": "101" },
        { "name": "ITV1", "channel": "103" },
        { "name": "Channel 4", "channel": "104" }
      ]
    },
    {
      "name": "Sky Q Mini",
      "ipAddress": "192.168.1.11",
      "favourites": [
        { "name": "BBC One", "channel": "101" },
        { "name": "ITV1", "channel": "103" },
        { "name": "Channel 4", "channel": "104" }
      ]
    }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `boxes[].name` | Yes | `Sky Q` | Name of the TV in Home |
| `boxes[].ipAddress` | Yes | | Static IP address of the box |
| `boxes[].favourites` | No | none | List of `{ name, channel }`. Channel is the 3 or 4 digit EPG number |
| `boxes[].channel_buttons` | No | `true` | Add the Channel Up and Channel Down buttons |
| `boxes[].wake_delay` | No | `20` | Seconds to wait after waking from standby before pressing Sky and Back and dialling the channel. `0` skips this |
| `boxes[].poll_interval` | No | `10` | Seconds between power and channel checks (5 to 60) |

## Adding the TVs to Home

iOS only handles one TV per bridge, so each box is published as its own accessory. After restarting Homebridge:

1. In the Home app, choose **Add Accessory**, then **More options**.
2. Pick the Sky Q TV and enter the Homebridge bridge PIN.
3. Repeat for each box.

Existing scenes or automations that use the old Sky Q switches need to be pointed at the new TVs.

## How it talks to the box

| Port | Use |
|------|-----|
| 9006 (HTTP) | `/as/system/information` for on/standby, `/as/services/4/1` for the channel list |
| 49153 (UPnP SOAP) | `GetMediaInfo` on the SkyPlay service for the current channel |
| 49160 (TCP) | Remote key presses |

Power uses the `power` key, which toggles standby. The plugin reads the box's state first and only presses it when the state needs to change.

## Tests

```bash
npm install
npm test                         # fake Sky Q box on localhost, presses no real keys
node test/live.js 192.168.x.x    # real box: wakes it, changes channel, restores power state
node test/live-buttons.js 192.168.x.x  # real box: tests Channel Up / Down (add --allow-on if the box is on)
```

## Credits

- Remote key protocol and codes from [sky-remote](https://github.com/dalhundal/sky-remote).
- Power check from [sky-q](https://www.npmjs.com/package/sky-q) and [homebridge-sky-q-no-logs](https://github.com/joepool/homebridge-sky-q-no-logs).
- UPnP and REST details from [Liam Gladdy's notes](https://gladdy.uk/blog/2017/03/13/skyq-upnp-rest-and-websocket-api-interfaces/) and [pyskyqremote](https://github.com/RogerSelwyn/skyq_remote).
- Built with [Kiro](https://kiro.dev).
