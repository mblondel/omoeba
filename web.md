# Omoeba on the web

If you keep your Omoeba library in a Google Drive folder,
Omoeba can create a file index.html for reading your library
using the Google Drive API.

## 1. The list of papers

Omoeba keeps `omoeba-library.jsonl` in each library folder. 
It lists the papers, one per line, and is updated after each index sync when a paper
changed. The page reads it from Google Drive, so the library folder must be in Google
Drive, synced by Google Drive for desktop.

If you additionally sync your library by git, you can add `omoeba-library.jsonl` to 
`.gitignore`.

## 2. Create a Google sign-in client (about 15 minutes, once)

In <https://console.cloud.google.com>:

1. **Create a project**, for example "Omoeba".
2. **APIs & Services › Library:** enable the **Google Drive API**.
3. **APIs & Services › OAuth consent screen:**
   - User type: **External**.
   - App name: "Omoeba".
   - Your e-mail as the support and developer contact.
   - Scopes: add `.../auth/drive.readonly`.
   - Test users: add your Google account.
   - Leave the app in **Testing**: then only the test users can sign in.
4. **APIs & Services › Credentials › Create credentials › OAuth client ID:**
   - Type: **Web application**.
   - Authorized JavaScript origins: the address the page will be hosted at, without its path. For GitHub Pages that is `https://<your-github-name>.github.io`.
   - You can also add `http://localhost:8000` to try the page locally.
   - Authorized redirect URIs (for phones, which sign in by going to Google and back): the page's full address, exactly as you open it, without `#…` or `?…`. For example `https://<your-github-name>.github.io/omoeba-web/`. If you sometimes open it as `…/omoeba-web/index.html`, add that address too.
5. **Copy the client ID** (`….apps.googleusercontent.com`) into `src/web/config.ts`:

   ```ts
   export const GOOGLE_CLIENT_ID = '….apps.googleusercontent.com';
   ```

   It is not a secret: it only lets the page ask a signed-in person for read-only access to *their own* Drive.

Because the app stays unverified, Google shows a "Google hasn't verified this app" screen when you sign in. Click **Continue**.

## 3. Try it on your computer (localhost)

The client ID must list `http://localhost:8000` as an authorized JavaScript origin (step 2). Then:

```sh
node scripts/build.mjs
cd dist/web && python3 -m http.server 8000
```

Open <http://localhost:8000> in Chrome and sign in. Stop the server with Ctrl-C. After a change to the page, run `node scripts/build.mjs` again and reload. The server can keep running.

Opening `index.html` directly from disk (`file://`) does not work: Google signs in only pages served from an authorized `http(s)://` address.

## 4. Build and host the page

1. **Build:** run `node scripts/build.mjs`. This writes `dist/web/index.html`, a single file.
2. **GitHub Pages:**
   - Create a public repository, for example `omoeba-web`.
   - Add `dist/web/index.html` to it as `index.html` and push.
   - In the repository's **Settings › Pages**, deploy from the `main` branch.
   - The page is then at `https://<your-github-name>.github.io/omoeba-web/`.
3. **Updates:** after a change to the page, copy the newly built `index.html` there again.

Anyone who finds the address only gets the page's code. Reading a library needs signing in as a test user, and each person only ever sees their own Drive.

## 5. On the iPhone

1. Open the page in **Safari** and tap **Sign in with Google**.
2. Tap **Share › Add to Home Screen** for an app-like icon.

Opened from the home-screen icon, signing in goes to Google’s page and comes back, rather than opening a popup (as in Safari): the page then runs in its own window, which a popup cannot report back to. This needs the page's address among the client's **Authorized redirect URIs** (step 2).
