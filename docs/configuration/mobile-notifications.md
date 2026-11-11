# Mobile notifications

iPhone alerts are push notifications, so your OpenTeam server needs an Apple Push Notification service (APNs) key from the Apple Developer team that signs your iPhone app. The TestFlight app (bundle ID `dev.openbot.mobile`) gets alerts only with a key supplied by its signing team; a key from any other Apple account won't work with it. Otherwise, [build the iPhone app yourself](../../apps/ios/README.md) and use your own team's key and bundle ID.

Desktop banners don't need APNs. Importing or changing the server's key applies live, without a restart.

## Enable alerts on iPhone

1. Connect the iPhone app to your OpenTeam server and sign in.
2. In **Settings**, turn on **Notifications**, and allow them when iOS asks.
3. Under **Settings → Bot notifications**, choose which bots notify you.

If iOS permission was denied, choose **Allow notifications in iPhone Settings**. Focus and Do Not Disturb can silence alerts. You don't get alerts for the conversation you're viewing.

**Pause iPhone alerts while I’m using my Mac** is on by default. While you're using a Mac that's running OpenTeam, in any app, your phone stays quiet unless OpenTeam is open on it. Alerts resume for new activity after five minutes of Mac inactivity, or when the Mac locks, sleeps, or quits OpenTeam. Paused alerts aren't sent later; their messages stay unread. The setting is shared: turn it off in iPhone **Settings**, or in desktop **Settings → General** (**Pause iPhone alerts while using this Mac**), to get alerts on both devices.

## Get the matching Apple credentials

The key must belong to the Apple Developer team that signed your iPhone app and allow pushes for that app's bundle ID.

If you manage that team, follow [Apple's key creation instructions](https://developer.apple.com/help/account/keys/create-a-private-key/): enable **Apple Push Notification service**, configure the allowed environment and topics, and download the `.p8` key. Record its **Key ID** and your **Team ID**. TestFlight and App Store builds use production APNs; development builds use development APNs, so the key must allow the environment your app uses. Apple lets you download the key only once.

## Import credentials on the server

Run these commands on the computer hosting your OpenTeam server. Place the `.p8` key there and create `apns.json` alongside it:

```json
{
  "keyId": "ABCDE12345",
  "teamId": "FGHIJ67890",
  "topic": "dev.openbot.mobile",
  "privateKeyFile": "./AuthKey.p8"
}
```

Replace the example IDs and key filename with your real values; `topic` is your app's bundle ID. The key path is relative to the JSON file.

```sh
openteam notifications configure --config ./apns.json
openteam notifications status
openteam doctor
```

You can also import the key directly:

```sh
openteam notifications configure \
  --key-file ./AuthKey.p8 \
  --key-id ABCDE12345 \
  --team-id FGHIJ67890 \
  --topic dev.openbot.mobile
```

If your installation uses a custom folder, add `--dir /path/to/installation`.

The server stores the key encrypted in its database, so you don't add it to `.env`. The key is protected by the control token in `.env`: keep that file with your database backups, or import the key again after changing the token.

## Verify delivery

`notifications status` shows where the configuration comes from and whether it's valid, without showing the key. `openteam doctor` checks iPhone registration, bundle-ID matches, and recent push errors.

Neither command sends a test alert or proves that Apple accepts the key. To check delivery, allow OpenTeam through Focus, leave the bot's conversation closed, and have that bot send a message. Confirm that the alert appears on the iPhone.

If alerts don't arrive, check that the phone is connected to the server you configured, turn **Notifications** off and on to register again, and inspect `openteam logs worker`. Check the signing team, bundle ID, key environment, and whether Apple has revoked the key. After fixing a configuration error, trigger a new notification; an old failed delivery may have used up its retries.

See [settings and notifications](apps.md#notifications) for device and bot preferences.
