# Patient Google sign-in (optional)


Email and password sign-in works without Google credentials. Google sign-in is shown only after all required environment settings are configured. It is patient-only: an OAuth response cannot assign a role, and a verified Google email can link only to an existing patient account. Doctor and administrator credentials must be provisioned by an administrator.

To configure Google for local development:

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a project.
2. Under **Google Auth Platform** (or **APIs & Services → OAuth consent screen** in the older console), configure the app name, support email, audience, and contact email. During testing, add the Google accounts that will sign in as test users. Complete Google verification before making an external app broadly available if Google requires it.
3. Go to **Google Auth Platform → Clients** (or **APIs & Services → Credentials → Create credentials → OAuth client ID**) and create a **Web application** client.
4. Add the local origin `http://localhost:3000` under **Authorized JavaScript origins** and the exact callback `http://localhost:3000/auth/google/callback` under **Authorized redirect URIs**. The server flow does not send browser JavaScript to Google; the origin is included for the web client configuration.
5. Copy the client ID and secret into a local `.env` file (never commit it), for example:

   ```text
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
   PUBLIC_BASE_URL=http://localhost:3000
   COOKIE_SECURE=false
   ```

6. Start the app with `npm start` and open `http://localhost:3000/login/patient`. Google sign-in requests only `openid`, `email`, and `profile`; the server verifies the ID token signature and claims with Google's maintained `google-auth-library` client.

For production, create a separate Web application OAuth client. Set the production HTTPS application origin as the authorized JavaScript origin, the exact HTTPS callback (for example `https://health.example.edu/auth/google/callback`) as the authorized redirect URI, and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `PUBLIC_BASE_URL`, and `COOKIE_SECURE=true` in the deployment's secret/configuration store. Never commit credentials or reuse a development client in production. Google sign-in is not production-verified until the configured callback has been exercised against the real Google project and its consent-screen requirements are complete.

Seed credentials are generated for local demo use and printed at runtime; they are not checked into source. Replace them with newly provisioned accounts before sharing a demo environment.

