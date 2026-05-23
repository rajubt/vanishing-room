# Enabling video calls

The chat works fully without this. Video calls just need a free Daily.co
API key.

## 1. Get a Daily.co API key (one time, ~5 min)

1. Sign up at https://dashboard.daily.co/signup (free).
2. In the dashboard, open the **Developers** section.
3. Copy your **API key**.

## 2. Start the server with the key

The server reads the key from an environment variable called
`DAILY_API_KEY`. Do NOT paste the key into any file — set it like this:

### Windows (PowerShell)

In your project folder:

```
$env:DAILY_API_KEY="paste_your_key_here"
npm start
```

(You set the variable each time you open a new PowerShell window. To make
it permanent, use Windows "Environment Variables" settings.)

### Mac / Linux

```
DAILY_API_KEY=paste_your_key_here npm start
```

## 3. Confirm it worked

When the server starts you should see:

```
Video calls: ENABLED (Daily API key found).
```

If you see "disabled" instead, the variable wasn't set in that terminal.

## How it works

- Each chat room shows a **🎥 video** button.
- Clicking it creates a Daily video room and embeds the call above the chat.
- Everyone else in the room sees a "join call" banner.
- The video room auto-expires after 15 minutes, matching the ephemeral theme.
- "leave call" removes you from the call but keeps chatting.

## Notes

- Daily's free tier has monthly limits — check current limits in their
  dashboard. For a small/personal site it is usually plenty.
- The API key stays on the server only; it is never sent to browsers.
- A public, anonymous video site is worth a moderation plan before you
  share it widely.
