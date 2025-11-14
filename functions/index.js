const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");

// Initialize the application
admin.initializeApp();

// AliExpress OAuth and API configuration
const ALIEXPRESS_AUTH_URL = "https://api-sg.aliexpress.com/oauth/authorize";
const ALIEXPRESS_TOKEN_URL = "https://api-sg.aliexpress.com/oauth/token";

/**
 * Initiates the AliExpress OAuth2 flow.
 * Redirects the user to the AliExpress authorization page.
 */
exports.aliexpressAuth = onRequest({region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY"]}, async (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(401).send("Authentication token is missing.");
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        const appKey = process.env.ALIEXPRESS_APP_KEY;
        const state = `uid=${uid}`; // Pass the UID in the state to identify the user on callback

        // Dynamically construct the redirect URI
        const region = process.env.FUNCTION_REGION || 'europe-west3';
        const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
        const redirectUri = `https://${region}-${projectId}.cloudfunctions.net/aliexpressOAuthCallback`;

        const authUrl = new URL(ALIEXPRESS_AUTH_URL);
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
 * Handles the OAuth2 callback from AliExpress.
 * Exchanges the authorization code for an access token and stores it.
 */
exports.aliexpressOAuthCallback = onRequest({region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"]}, async (req, res) => {
    const { code, state } = req.query;

    if (!code) {
        return res.status(400).send("Authorization code is missing.");
    }

    // Extract UID from state
    const uid = new URLSearchParams(state).get('uid');
    if (!uid) {
        return res.status(400).send("User ID is missing from the state.");
    }

    const appKey = process.env.ALIEXPRESS_APP_KEY;
    const appSecret = process.env.ALIEXPRESS_APP_SECRET;

    // Dynamically construct the redirect URI
    const region = process.env.FUNCTION_REGION || 'europe-west3';
    const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
    const redirectUri = `https://${region}-${projectId}.cloudfunctions.net/aliexpressOAuthCallback`;

    try {
        const tokenResponse = await axios.post(ALIEXPRESS_TOKEN_URL, new URLSearchParams({
            grant_type: 'authorization_code',
            app_key: appKey,
            app_secret: appSecret,
            redirect_uri: redirectUri,
            code: code,
        }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const { access_token, refresh_token, expire_time, refresh_token_valid_time } = tokenResponse.data;
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

    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error("AliExpress API Error Data:", error.response.data);
            console.error("AliExpress API Error Status:", error.response.status);
          } else {
            // Something else happened
            console.error("Error exchanging AliExpress token:", error.message);
          }
        // Redirect with an error message
        return res.redirect('https://desire-loja-final.web.app/#/account?aliexpress=error');
    }
});
