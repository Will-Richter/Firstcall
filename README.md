# Firstcall

Every enquiry from your website's forms in one place, ready to call.

Firstcall takes the form submission emails a Squarespace site sends, turns each one into a lead card, and lets you work the list from your phone:

- call, text or email a lead with one tap
- mark it New, Contacted, Quoted, Successful or Unsuccessful, and keep notes
- send it to ServiceM8 as a client and a job
- get a phone notification within a minute or two of a new enquiry
- keep working with poor reception; changes are sent when you are back in range

It is one small server and one web page. Add the page to your phone's Home Screen and it opens full screen like any other app.

## What it runs on

- Node 22.5 or newer. Nothing to install: there are no packages to download.
- One SQLite file on a disk that is kept between restarts.
- An https address. Phones only allow Home Screen apps and notifications over https.

## Try it on your own computer

```
npm start
```

Open http://localhost:8080 and create an account. The first account created owns the app, and sign-ups then close.

```
npm test
```

runs the server against a throwaway database with stand-ins for ServiceM8 and for a phone's notification service.

## Put it online

Any host that runs a Docker container (or Node 22) with a persistent disk works.

1. Create a web service from this repository. The `Dockerfile` is all it needs.
2. Attach a persistent disk and mount it at `/data`. Without one, leads and log-ins are lost on every restart.
3. Set `PUBLIC_URL` to the https address of the service, `CONTACT_EMAIL` to your email, and `TRUST_PROXY=1` (hosts put their own https proxy in front). The rest of `.env.example` is optional.
4. Open the address and create your account straight away: the first account created owns the app. Set `OWNER_EMAIL` beforehand if you want only your email to be able to do that.
5. Follow the set-up steps the app shows.

The host must answer `/health` with `ok` once it is up.

## Setting up, once it is online

The app lists whatever is left to do. There are three steps.

**Website emails.** Firstcall does not log in to your mailbox. Instead it gives you a short script to paste into [script.google.com](https://script.google.com) in the Google account that receives your form emails. The script looks for emails from `form-submission@squarespace.info` once a minute and passes those, and only those, to your Firstcall. The first run sends the last 12 months. If Firstcall is offline for a while, the script catches up on anything from the last 7 days; run `setup` again to re-send further back. You can read the whole script before you run it, and remove it from your Google account at any time.

**ServiceM8.** Create an API key in ServiceM8 under Settings, then API Keys, and paste it into Firstcall. It is stored locked (AES-256-GCM) and is never sent back to the browser. Sending a lead across checks for a client of the same name first; if there isn't one it creates the client and a contact with their phone and email, then the job, then the job contact.

**Notifications.** On an iPhone, add Firstcall to the Home Screen first (Safari, Share, Add to Home Screen), open it from the new icon, then turn notifications on in the app. Android and desktop browsers can turn them on straight away.

## Settings

| Name | What it is for |
| --- | --- |
| `PUBLIC_URL` | The https address of the app. Used in the website emails script. |
| `DATA_DIR` | Where the database and secret key are kept. Default `./data`, `/data` in the container. |
| `PORT` | Port to listen on. Default `8080`. |
| `TRUST_PROXY` | `1` when the host has its own https proxy in front, so the limit on wrong passwords sees each visitor's real address. |
| `OWNER_EMAIL` | Optional. Only this email can create the first account. |
| `CONTACT_EMAIL` | Contact address sent to Apple and Google with each notification. |
| `SECRET_KEY` | Optional. Text used to lock stored credentials. If left out, a key is created on the data disk. |
| `SIGNUPS` | Optional. `on` lets more than one person create an account. Each account has its own leads. |

## How it is put together

| File | Job |
| --- | --- |
| `index.html` | The app screens. |
| `shim.js` | Connects the screens to this server and keeps a copy of the leads on the phone. |
| `gate.js`, `gate.css` | Log-in, set-up steps and the account screen. |
| `sw.js`, `manifest.webmanifest`, icons | Home Screen app, opening without reception, notifications. |
| `server.js` | Serves the page and its files. |
| `api.js` | Accounts, leads, the website emails link, ServiceM8 and notification requests. |
| `mail.js` | Reads the fields out of a Squarespace form email. |
| `sm8.js` | Talks to ServiceM8. |
| `push.js` | Encrypts and sends phone notifications. |
| `db.js`, `secure.js`, `http.js` | Storage, passwords and locking, request handling. |
| `test.js` | The end-to-end test. |

Passwords are stored as scrypt hashes. Log-in is a cookie the page's scripts cannot read. Wrong passwords are limited per visitor and per email. If you forget your password, you can set a new one with your email and the ServiceM8 API key connected to your account.

## Privacy

This repository holds the app only. It contains no leads, customer details, keys or passwords, and the test data is made up. Your leads live in the database on your own host.

## Status

Tested here: the server test suite (which also runs the website emails script against stand-ins for Gmail and Google's script services), the notification encryption against the worked example in RFC 8291, and a full run in a phone-sized browser (create account, receive form emails, work a lead, send it to a stand-in ServiceM8, go offline and back). The code has had one independent review, and what it found is fixed.

Not yet proven against the real thing: a live ServiceM8 account, a notification arriving on a real phone, the website emails script running in a real Google account, and the container image build.
