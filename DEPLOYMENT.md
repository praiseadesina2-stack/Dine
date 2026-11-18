# Deploying Dine Telegram Bot (24/7 Cloud Hosting)

The Dine Telegram bot runs as a long-polling daemon. It needs to run continuously in the cloud so students can use it without your laptop running.

---

## Option 1: Railway (Recommended — Fastest & Easiest)

1. Go to [railway.app](https://railway.app) and sign in with GitHub.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Select `praiseadesina2-stack/Dine` (or your repository).
4. Railway will automatically detect the `Dockerfile` / `railway.json` and start building.
5. Click on the project → **Variables** tab, and add your environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` = `gemini-3.5-flash-lite,gemini-3.8-flash`
   - `KORA_PUBLIC_KEY`
   - `KORA_SECRET_KEY`
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `TELEGRAM_STRING_SESSION`
   - `PRIME_BOT_USERNAME` = `orderfromprimebot`
6. Click **Deploy**. Your bot is now live 24/7!

---

## Option 2: Render (Free Background Worker)

1. Go to [render.com](https://render.com) and sign in.
2. Click **New +** → **Background Worker**.
3. Connect your GitHub repository.
4. Set:
   - **Environment:** Docker
   - **Plan:** Free
5. Add the Environment Variables (same as above).
6. Click **Create Background Worker**.

---

## Option 3: Local Testing

To run the bot locally right now:
```bash
pnpm dev
```
