// functions/src/aliexpressAuth.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const crypto = require('crypto');
const fetch = require('node-fetch');
const admin = require("firebase-admin");

// Redirects the user to AliExpress to authorize the application.
const aliexpressAuthRedirect = onRequest({ region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY"] }, (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }
    const appkey = process.env.ALIEXPRESS_APP_KEY;
    const redirectUri = `https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback`;
    const authUrl = `https://api-sg.aliexpress.com/oauth/authorize?response_type=code&force_auth=true&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${appkey}`;
    res.redirect(authUrl);
});

// Exchanges the authorization code for an access token and refresh token.
const aliexpressAuthCallback = onRequest({ region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"] }, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }
    const { code } = req.query;
    if (!code) {
        return res.status(400).send("Authorization code is missing.");
    }

    const APP_KEY = process.env.ALIEXPRESS_APP_KEY.trim();
    const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET.trim();
    const API_URL = "https://api-sg.aliexpress.com/rest"; // System-level API URL

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', APP_KEY);
    params.append('client_secret', APP_SECRET);
    params.append('code', code);
    params.append('redirect_uri', `https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback`);

    try {
        const response = await fetch(`${API_URL}/auth/token/create`, {
            method: 'POST',
            body: params,
        });
        const tokenData = await response.json();

        if (tokenData.error) {
            console.error("Error creating token:", tokenData);
            return res.status(500).send(`Failed to get access token: ${tokenData.error_description}`);
        }

        const db = admin.firestore();
        await db.collection('aliexpress_tokens').doc('user_specific_id').set({
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in * 1000),
            refreshExpiresAt: Date.now() + (tokenData.refresh_expires_in * 1000),
        });

        res.status(200).send("<h1>Authentication Successful!</h1><p>You can now close this window.</p>");

    } catch (error) {
        console.error("Callback Error:", error);
        res.status(500).send("An unexpected error occurred during authentication.");
    }
});

// Refreshes the AliExpress access token using the stored refresh token.
const refreshAliExpressToken = async () => {
    const db = admin.firestore();
    const tokenDoc = await db.collection('aliexpress_tokens').doc('user_specific_id').get();

    if (!tokenDoc.exists) {
        throw new Error("Refresh token not found. Please re-authenticate.");
    }

    const { refreshToken, refreshExpiresAt } = tokenDoc.data();

    if (Date.now() >= refreshExpiresAt) {
        throw new Error("Refresh token has expired. Please re-authenticate.");
    }

    const APP_KEY = process.env.ALIEXPRESS_APP_KEY.trim();
    const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET.trim();
    const API_URL = "https://api-sg.aliexpress.com/rest";

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', APP_KEY);
    params.append('client_secret', APP_SECRET);
    params.append('refresh_token', refreshToken);

    try {
        const response = await fetch(`${API_URL}/auth/token/refresh`, {
            method: 'POST',
            body: params,
        });
        const tokenData = await response.json();

        if (tokenData.error) {
            console.error("Error refreshing token:", tokenData);
            throw new Error(`Failed to refresh access token: ${tokenData.error_description}`);
        }

        await db.collection('aliexpress_tokens').doc('user_specific_id').update({
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in * 1000),
        });

        return tokenData.access_token;

    } catch (error) {
        console.error("Token Refresh Error:", error);
        throw error;
    }
};

const getValidAccessToken = async () => {
    const db = admin.firestore();
    const tokenDoc = await db.collection('aliexpress_tokens').doc('user_specific_id').get();

    if (!tokenDoc.exists) {
        throw new HttpsError('permission-denied', 'AliExpress token not found. Please authorize the application first.');
    }

    const { accessToken, expiresAt } = tokenDoc.data();

    if (Date.now() >= expiresAt) {
        console.log("Access token expired, refreshing...");
        return await refreshAliExpressToken();
    }

    return accessToken;
};


// Internal logic function, easier to test
const _importAliExpressProductLogic = async (data, context) => {
    // 1. Check for admin privileges
    if (!context.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const db = admin.firestore();
    const userProfileRef = db.collection('users').doc(context.auth.uid);
    const userProfileSnap = await userProfileRef.get();

    if (!userProfileSnap.exists() || !userProfileSnap.data().isAdmin) {
        throw new HttpsError('permission-denied', 'Must be an administrative user to call this function.');
    }

    const { url } = data;
    if (!url) {
        throw new HttpsError('invalid-argument', 'The function must be called with one argument "url".');
    }

    // 2. Extract Product ID from URL
    const productIdMatch = url.match(/item\/(\d+)\.html/);
    if (!productIdMatch || !productIdMatch[1]) {
        throw new HttpsError('invalid-argument', 'Invalid AliExpress URL format.');
    }
    const productId = productIdMatch[1];

    // 3. Get Access Token and Prepare API Request
    const accessToken = await getValidAccessToken();
    const APP_KEY = process.env.ALIEXPRESS_APP_KEY.trim();
    const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET.trim();
    const API_URL = "https://api-sg.aliexpress.com/sync";

    // 4. Combine All Parameters for a GET request
    const params = {
        session: accessToken, // Correct parameter name is 'session' per logs
        app_key: APP_KEY,
        sign_method: 'sha256',
        format: 'json',
        v: '2.0',
        timestamp: Date.now(), // Correct timestamp format is Unix ms per logs
        method: 'aliexpress.ds.product.get',
        product_id: productId,
        ship_to_country: 'US',
    };

    // 5. Calculate Signature
    const sortedKeys = Object.keys(params).sort();
    let signString = '';
    sortedKeys.forEach(key => {
        signString += key + params[key];
    });
    const hmac = crypto.createHmac('sha256', APP_SECRET);
    hmac.update(signString);
    params.sign = hmac.digest('hex').toUpperCase();


    // 6. Make the API Call
    const queryString = new URLSearchParams(params).toString();
    const requestUrl = `${API_URL}?${queryString}`;

    try {
        const response = await fetch(requestUrl); // Default is GET

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`AliExpress API request failed with status ${response.status}:`, errorBody);
            throw new HttpsError('internal', `The AliExpress API returned a non-200 status: ${response.status} ${response.statusText}. Body: ${errorBody}`);
        }

        const data = await response.json();

        if (data.error_response) {
            console.error("AliExpress API Error:", data.error_response);
            throw new HttpsError('internal', `AliExpress API Error: ${data.error_response.msg}`);
        }

        const result = data.aliexpress_ds_product_get_response?.result;
        if (!result) {
             console.error("Unexpected AliExpress API response structure:", data);
            throw new HttpsError('internal', 'Could not find product data in the AliExpress API response.');
        }

        // 6. Transform data to match the format expected by the frontend
        const transformedData = {
            name: result.ae_item_base_info_dto.subject,
            description: result.ae_item_base_info_dto.detail, // Note: This might be HTML
            price: parseFloat(result.ae_item_sku_info_dtos[0]?.offer_sale_price || '0'),
            images: result.ae_multimedia_info_dto.image_urls.split(';')
        };

        return transformedData;

    } catch (error) {
        console.error("Error calling AliExpress API:", error);
        if (error instanceof HttpsError) { // Re-throw HttpsError
            throw error;
        }
        throw new HttpsError('internal', 'An unexpected error occurred while fetching product data from AliExpress.');
    }
};

const importAliExpressProduct = onCall({ region: 'europe-west3', secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"] }, (request) => {
    return _importAliExpressProductLogic(request.data, { auth: request.auth });
});

const exportsObject = {
    importAliExpressProduct,
    aliexpressAuthRedirect,
    aliexpressAuthCallback,
};

if (process.env.NODE_ENV === 'test') {
    exportsObject._importAliExpressProductLogic = _importAliExpressProductLogic;
    exportsObject.refreshAliExpressToken = refreshAliExpressToken;
}

module.exports = exportsObject;
