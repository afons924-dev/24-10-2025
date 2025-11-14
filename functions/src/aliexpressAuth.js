// functions/src/aliexpressAuth.js
const { URLSearchParams } = require("url");
const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

/**
 * Creates a signature for AliExpress API calls.
 * @param {string} secret The client secret.
 * @param {object} params The parameters to sign.
 * @returns {string} The HMAC-SHA256 signature in uppercase.
 */
function createSignature(secret, params) {
    const sortedKeys = Object.keys(params).sort();
    let signString = "";
    for (const key of sortedKeys) {
        if (params[key] !== undefined && params[key] !== null) {
            signString += `${key}${params[key]}`;
        }
    }
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(signString);
    return hmac.digest("hex").toUpperCase();
}

/**
 * Initiates the AliExpress OAuth2 flow.
 * Redirects the user to the AliExpress authorization page.
 */
const aliexpressAuth = onRequest({region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_CALLBACK_URL"]}, async (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(401).send("Authentication token is missing.");
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        const appKey = process.env.ALIEXPRESS_APP_KEY?.trim();
        const state = `uid=${uid}`; // Pass the UID in the state to identify the user on callback

        // Use the configured callback URL
        const redirectUri = process.env.ALIEXPRESS_CALLBACK_URL?.trim();
        if (!redirectUri) {
            console.error("ALIEXPRESS_CALLBACK_URL environment variable is not set.");
            return res.status(500).send("Server misconfiguration: Missing callback URL.");
        }

        const authUrl = new URL("https://auth.aliexpress.com/oauth/authorize");
        authUrl.searchParams.append("response_type", "code");
        authUrl.searchParams.append("client_id", appKey);
        authUrl.searchParams.append("redirect_uri", redirectUri);
        authUrl.searchParams.append("state", state);
        authUrl.searchParams.append("sp", "ae");

        return res.redirect(authUrl.toString());

    } catch (error) {
        console.error("Error verifying auth token:", error);
        return res.status(403).send("Invalid authentication token.");
    }
});

/**
 * aliexpressOAuthCallback - callback endpoint usado APENAS pela AliExpress
 * Deve receber ?auth_code=...&state=...
 */
const aliexpressOAuthCallback = onRequest({region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET", "ALIEXPRESS_CALLBACK_URL"]}, async (req, res) => {
  try {
    // 1) Garantir que é o auth_code vindo do AliExpress
    const authCode = req.method === "GET" ? req.query.code : req.body?.code;
    const state = req.query.state;

    if (!authCode) {
      console.error("Missing auth_code in AliExpress callback. Query:", req.query, "Body:", req.body);
      return res.status(400).send("Missing auth_code");
    }

    // Extract UID from state
    const uid = new URLSearchParams(state).get('uid');
    if (!uid) {
        return res.status(400).send("User ID is missing from the state.");
    }

    // 2) Parametros (usar secrets / env vars)
    const CLIENT_ID = process.env.ALIEXPRESS_APP_KEY?.trim();
    const CLIENT_SECRET = process.env.ALIEXPRESS_APP_SECRET?.trim();
    // CALLBACK_URL deve ser exactamente igual ao redirect URI registado no AliExpress dev console
    const CALLBACK_URL = process.env.ALIEXPRESS_CALLBACK_URL?.trim(); // ex: https://europe-west3-.../aliexpressOAuthCallback

    if (!CLIENT_ID || !CLIENT_SECRET || !CALLBACK_URL) {
      console.error("Missing AliExpress env vars");
      return res.status(500).send("Server misconfiguration");
    }

    // 3) Trocar auth_code por access_token — método POST, application/x-www-form-urlencoded
    const tokenUrl = "https://api-sg.aliexpress.com/oauth/token"; // endpoint típico - ver dev console se necessário
    const params = {
      grant_type: "authorization_code",
      code: authCode,
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
    };
    const sign = createSignature(CLIENT_SECRET, params);

    const bodyParams = {
        ...params,
        client_secret: CLIENT_SECRET,
        sign: sign,
    };

    const body = new URLSearchParams(bodyParams);

    const tokenResp = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const tokenData = await tokenResp.json().catch(() => null);

    if (!tokenResp.ok) {
      console.error("AliExpress API Error Data:", tokenData);
      console.error("AliExpress API Error Status:", tokenResp.status);
      // devolve mensagem clara ao utilizador/aplicacao
      return res.status(502).json({
        error: "AliExpress token exchange failed",
        status: tokenResp.status,
        data: tokenData,
      });
    }

    // 4) Aqui tens o tokenData com access_token, refresh_token, expires_in, etc.
    console.info("AliExpress token exchange success:", tokenData);

    const { access_token, refresh_token, expire_time, refresh_token_valid_time } = tokenData;
    const db = admin.firestore();
    // Securely store the tokens in Firestore, associated with the user
    const userRef = db.collection('users').doc(uid);
    await userRef.set({
        aliexpressToken: {
            accessToken: access_token,
            refreshToken: refresh_token,
            expiresAt: Date.now() + (expire_time * 1000), // Convert to ms
            refreshExpiresAt: refresh_token_valid_time,
        }
    }, { merge: true });

    // Redirect the user back to their account page with a success message
    return res.redirect('https://desire-loja-final.web.app/#/account?aliexpress=success');

  } catch (err) {
    console.error("aliexpressOAuthCallback unexpected error:", err);
    return res.redirect('https://desire-loja-final.web.app/#/account?aliexpress=error');
  }
});


/**
 * firebaseAuthCallback - separa o callback do Firebase/Google Auth (que envia ?token=...)
 * PARA NÃO CONFLITAR com o AliExpress callback.
 */
const firebaseAuthCallback = onRequest({region: 'europe-west3'}, (req, res) => {
  // Este endpoint só trata do token do Firebase/Google
  const token = req.query.token || req.body?.token;
  if (!token) {
    return res.status(400).send("Missing token");
  }
  // Processa o token (verifica, troca, etc). Exemplo:
  console.log("Received Firebase token (short log):", token.slice(0, 30) + "...");
  // Redirect para UI
  return res.redirect(`https://darkdesire.pt/firebase-auth-success`);
});

module.exports = {
    aliexpressAuth,
    aliexpressOAuthCallback,
    firebaseAuthCallback
}
