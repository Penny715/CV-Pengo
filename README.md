[README.md](https://github.com/user-attachments/files/29806590/README.md)
# CV Pengo — AI-Powered CV Analysis

An initiative by The Young SEAkers (TYS). Upload a CV (PDF), optionally paste a
target job description, and get AI feedback: overall + ATS scores, strengths,
weaknesses, section-by-section review, bullet rewrites, job match, and a
5-step action plan. Powered by Google Gemini.

## Stack
- React 18 + Vite (frontend)
- Netlify Functions (serverless proxy that holds the Gemini key)
- PDF.js for in-browser text extraction (PDF fallback for scanned resumes)

## Deploy to Netlify

1. **Push this folder to a GitHub repo.**

2. **Netlify → Add new site → Import an existing project** → pick the repo.
   Build settings are auto-read from `netlify.toml`
   (build: `npm run build`, publish: `dist`, functions: `netlify/functions`).

3. **Add your API key** (do this BEFORE the first deploy):
   Site configuration → Environment variables → Add:
   - Key: `GEMINI_API_KEY`
   - Value: your key from Google AI Studio (https://aistudio.google.com/apikey)

   ⚠️ Never commit the key to the repo. If a key has ever been pasted in a
   chat, screenshot, or commit, revoke it and create a new one.

4. **Deploy.** You'll get a live `https://<yourname>.netlify.app` link.
   Add a custom domain later under Domain management if TYS wants one.

## Local development

```bash
npm install
npm install -g netlify-cli
netlify dev          # runs Vite + functions together at http://localhost:8888
```

Create a `.env` file locally (already gitignored):

```
GEMINI_API_KEY=your_key_here
```

## Notes
- The model is set in `netlify/functions/analyze.js` (`gemini-2.5-flash`).
  Swap to another Gemini model there if needed.
- Costs: Gemini Flash has a generous free tier; each CV analysis makes
  3 small requests.
